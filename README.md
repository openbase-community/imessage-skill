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
- **The exfiltration leg is human-gated and, in v1, not wired to delivery.**
  `send` requires a stored `send_allowed` flag *and* an explicit Openbase Coder
  user-approval prompt, and only writes to a local outbox — actual delivery is
  not implemented, so there is no automated outbound path at all.
- **Mutating the trust surface requires `sudo`.** `approve`, `revoke`, and
  `import` change what the agent can see, and are root-gated.

**Operator note:** treat all inbound message text as untrusted input. The
per-send approval prompt is the primary backstop against injection-driven
exfiltration — do not set `IMESSAGE_SKIP_OPENBASE_APPROVAL=1` or
`IMESSAGE_ALLOW_UNPRIVILEGED_ADMIN=1` in any environment an agent's own context
can influence (the import LaunchDaemon sets the latter deliberately in its own
isolated, non-agent context).

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
imessage-local send CONTACT_OR_CHAT_ID TEXT [--json]
imessage-local queued [--limit N] [--json]
sudo imessage-local import [--source DIR] [--json]
```

Metadata commands do not return message bodies. `recent` only returns message
text for approved people or group conversations.

`send` does not require sudo. It checks `send_allowed`, asks Openbase Coder for
approval, and queues locally in `data/outbox/outbox.sqlite`. Delivery is not
implemented in v1.

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
