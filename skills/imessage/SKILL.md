---
name: imessage
description: >-
  Use this skill when the user asks about iMessage, Messages.app, SMS,
  chat.db, approved senders or groups, or local iMessage backups on a Mac.
version: 0.2.0
---

# iMessage

Use the Mac-local `imessage-local` CLI. Do not inspect raw iMessage or
Contacts databases directly for ordinary answers.

## Hard Rules

- This skill is Mac-only. If the agent is not already on the Mac that hosts
  the iMessage runtime, SSH there first using the user's configured SSH host,
  IP, or `IMESSAGE_CLI_SSH_TARGET` value.
- Use `imessage-local` for all iMessage content access.
- Never read, list, grep, summarize, or open `~/.imessage-cli/data/protected`
  unless the user explicitly asks for low-level maintenance.
- Never open raw `chat.db`, AddressBook databases, or inbox snapshots to answer
  conversational questions.
- Metadata browsing is allowed without sudo, but message text may only be shown
  from approved CLI results.
- Do not approve, revoke, import, or change launchd/Full Disk Access unless the
  user explicitly asks.
- `approve` and `revoke` must use an exact contact or conversation ID and either
  `--approval-mode openbase` or `--approval-mode sudo`. Openbase mode asks
  Openbase Coder for metadata-only user approval and does not require sudo.
  Sudo mode uses the stronger local Unix-permissions path.
- `import` still requires sudo because it handles protected raw database
  snapshots.
- `send` does not require sudo, but it must pass both the stored `send_allowed`
  gate and exact-entity Openbase Coder approval before queueing. Approval
  prompts must not include message bodies.

## CLI Location

Source and CLI usually live on the Mac at:

```sh
cd ~/Developer/skills/imessage
PATH=/opt/homebrew/bin:/usr/bin:/bin npm run imessage -- help
```

Runtime data lives at:

```text
~/.imessage-cli
```

## Common Commands

Browse metadata only:

```sh
imessage-local search "Name or phone" --json
imessage-local contacts --json
imessage-local conversations --json
imessage-local activity --limit 25 --json
```

Read recent approved messages:

```sh
imessage-local recent CONTACT_OR_CHAT_ID --limit 10 --json
```

Approve only when the user explicitly asks:

```sh
imessage-local approve CONTACT_OR_CHAT_ID --approval-mode openbase --name "Name" --json
imessage-local approve CONTACT_OR_CHAT_ID --approval-mode openbase --name "Name" --send --json
sudo imessage-local approve CONTACT_OR_CHAT_ID --approval-mode sudo --name "Name" --json
```

Revoke only when the user explicitly asks:

```sh
imessage-local revoke CONTACT_OR_CHAT_ID --approval-mode openbase --json
sudo imessage-local revoke CONTACT_OR_CHAT_ID --approval-mode sudo --json
```

Queue a send only when the user explicitly asks:

```sh
imessage-local send CONTACT_OR_CHAT_ID "message text" --json
```

## Output Discipline

- For metadata/search/activity, return names, IDs, service, timestamps, and
  approval flags only.
- For recent messages, keep excerpts brief and cite that they came from
  `imessage-local recent`.
- If a target is not approved, say that directly and ask whether the user wants
  that exact person or group approved.
- If a send is not send-approved, say that directly. Do not work around the
  approval gate.
