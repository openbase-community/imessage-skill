# iMessage CLI Skill

Local Mac iMessage CLI and agent skill with a WhatsApp-style approval boundary.

## Why a Custom CLI/Skill

iMessage access depends on local macOS databases, Full Disk Access, contacts data, and a careful
split between metadata and message bodies. A custom CLI gives agents a narrow, reproducible command
surface instead of direct database access: metadata commands are body-free, message text is only
available for approved conversations, and send attempts are queued behind approval. The protected
runtime layout also keeps raw chat databases and snapshots outside normal agent context.

## Security model & the lethal trifecta

An agent that can read your iMessages sits squarely inside the
[**lethal trifecta**](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) —
the combination of capabilities that makes AI agents dangerous:

1. **Access to private data** — your iMessage/SMS history and Contacts.
2. **Exposure to untrusted content** — inbound messages are attacker-controlled,
   so any sender can attempt a prompt injection that enters agent context the
   moment the text is read.
3. **Ability to exfiltrate** — a `send` channel that could leak what was read.

This skill is designed to break the chain:

- **The read leg is narrowed to approved conversations only.** Raw `chat.db`,
  Contacts (`AddressBook`) copies, and snapshots live in service/sudo-only
  `data/protected/` (mode `700`, owned by the `_imessage` service user) outside
  agent context. Only messages for entities you explicitly `approve` are
  exposed; everything else is metadata-only. The Full-Disk-Access backup helper
  is a separate, minimal binary — the agent never touches the live databases.
- **The outbound path is human-gated.** `send` requires a stored `send_allowed` flag and explicit exact-recipient Openbase Coder approval before submitting through Messages.app. Approval prompts contain metadata only. No worker drains the queue automatically, and uncertain submissions are never automatically retried.
- **Mutating the trust surface requires `sudo`.** `approve`, `revoke`, and
  `import` change what the agent can see, and are root-gated.

**Operator note:** treat all inbound message text as untrusted input. The per-send approval prompt is the primary backstop against injection-driven exfiltration; the legacy `IMESSAGE_SKIP_OPENBASE_APPROVAL` bypass is no longer supported. Do not set `IMESSAGE_ALLOW_UNPRIVILEGED_ADMIN=1` in any environment an agent's own context can influence (the import LaunchDaemon sets it deliberately in its own isolated, non-agent context).

## Install Skill

```sh
npx skills add openbase-community/imessage-skill --list
npx skills add openbase-community/imessage-skill --skill imessage
```

The repository contains the `imessage-local` CLI plus the agent skill in
`skills/imessage/SKILL.md`.

## Runtime Layout

Runtime data lives outside the source tree:

```text
~/.imessage-cli/
  data/
    catalog/
      contacts.json
      activity.jsonl
    approved/
      approved.sqlite
    outbox/
      outbox.sqlite
    protected/
      source/
  inbox/
  logs/
```

`data/catalog` and `data/approved` are group-readable through `imessage-data`.
`data/protected` is service/sudo-only. `data/outbox`, `inbox`, and `logs` are
group-writable so the user-session helper and non-sudo send queue can work.

## CLI

Run from this repo:

```sh
PATH=/opt/homebrew/bin:/usr/bin:/bin npm run imessage -- help
```

Commands:

```sh
imessage-local contacts [--limit N] [--offset N] [--json]
imessage-local conversations [--limit N] [--offset N] [--json]
imessage-local search QUERY [--limit N] [--json]
imessage-local activity [--limit N] [--since today|YYYY-MM-DD|ISO] [--json]
imessage-local approved [--json]
imessage-local recent CONTACT_OR_CHAT_ID [--limit N] [--before TIMESTAMP_MS] [--json]
sudo imessage-local approve CONTACT_OR_CHAT_ID [--name NAME] [--send] [--no-read] [--kind handle|chat] [--json]
sudo imessage-local revoke CONTACT_OR_CHAT_ID [--json]
imessage-local send CONTACT_OR_CHAT_ID TEXT [--queue-only] [--json]
imessage-local delivery-check CONTACT_OR_CHAT_ID [--json]
imessage-local deliver OUTBOX_ID [--json]
imessage-local send-status OUTBOX_ID [--json]
imessage-local queued [--limit N] [--json]
sudo imessage-local import [--source DIR] [--json]
```

Metadata commands do not return message bodies. `recent` only returns message
text for approved people or group conversations.

`send` does not require sudo. It checks `send_allowed` in the authoritative approved database, asks Openbase Coder for exact-recipient approval (metadata only, never message text), records the outbound message, and submits it through Messages.app. The approved database stays read-only during sending. macOS must permit Automation access to Messages, and the signed-in user must have a working Messages account. SMS/RCS requires an existing matching conversation and the necessary phone-forwarding setup. Phone numbers and email addresses are matched exactly; a person's approval never authorizes a group containing them.

Use `delivery-check CONTACT_OR_CHAT_ID` for a read-only readiness check. `--queue-only` retains an explicit queueing workflow; `deliver OUTBOX_ID` requests fresh approval and submits only that queued message. Existing queued messages are never drained automatically. `send-status OUTBOX_ID` returns metadata without the message body. `submitted` means Messages.app accepted the scripting command, not that the recipient received or read it. Timeouts or uncertain submission failures become `unknown`, and an interrupted `submitting` message is not retried automatically. Check Messages before explicitly creating another send, to avoid duplicates. An account/permission failure during the read-only preflight leaves the entry queued.

Outbound text is passed to the native transport as JSON over stdin, never interpolated into AppleScript/JavaScript source. Native errors are redacted because they can contain message text. Tests use synthetic databases and mocked delivery; `npm test` never sends real messages. The native sender must run in the logged-in macOS user's session, not under sudo. Ensure `openbase-coder` is on PATH or configure `OPENBASE_CODER_APPROVAL_COMMAND` to its executable path.

## Backup Helper

The reproducible backup path is a small native helper app:

```text
/Applications/iMessage CLI Backup Helper.app
```

It copies `~/Library/Messages/chat.db*` and AddressBook sqlite files into
`~/.imessage-cli/inbox/`. The `_imessage` importer consumes inbox snapshots and
moves them into protected runtime storage.

There is intentionally no `/tmp/imessage-backups` fallback. Raw database copies
should enter through `~/.imessage-cli/inbox/` or an explicit, deliberate
`sudo imessage-local import --source DIR` run.

Grant Full Disk Access to the helper app after installing.

## Install CLI Services

```sh
cd ~/Developer/skills/imessage
sudo ./scripts/install-launchd-services.sh
```

The installer creates `_imessage`, `imessage-data`, runtime directories, the
backup helper app, a user LaunchAgent for copying, and a system LaunchDaemon
for importing.

Runtime iMessage databases, Contacts snapshots, generated launchd plists, local
logs, build output, and environment files are ignored by git.
