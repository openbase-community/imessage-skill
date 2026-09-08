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
- `approve`, `revoke`, and `import` require sudo and do not also require
  Openbase Coder approval.
- `send` and `deliver` do not require sudo, but must pass the stored `send_allowed` gate and exact-entity Openbase Coder approval. Approval prompts contain metadata only, never message bodies. A declined or timed-out approval is a hard stop.
- Delivery uses Messages.app in the logged-in macOS user's session. Do not work around macOS Automation permissions. Never automatically drain old queued messages or retry a `submitting`, `submitted`, or `unknown` message.

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
sudo imessage-local approve CONTACT_OR_CHAT_ID --name "Name" --json
sudo imessage-local approve CONTACT_OR_CHAT_ID --name "Name" --send --json
```

Send only when the user explicitly asks:

```sh
imessage-local send CONTACT_OR_CHAT_ID "message text" --json
```

Check readiness without sending, or inspect the metadata of one outbound message:

```sh
imessage-local delivery-check CONTACT_OR_CHAT_ID --json
imessage-local send-status OUTBOX_ID --json
```

For explicit queueing, add `--queue-only` to `send`. Later, `imessage-local deliver OUTBOX_ID --json` requests fresh approval and submits that exact queued message. `submitted` means accepted by Messages.app, not confirmed recipient delivery. If submission is `unknown` or interrupted in `submitting`, ask the user to verify in Messages before creating another send; never retry automatically.

## Output Discipline

- For metadata/search/activity, return names, IDs, service, timestamps, and
  approval flags only.
- For recent messages, keep excerpts brief and cite that they came from
  `imessage-local recent`.
- If a target is not approved, say that directly and ask whether the user wants
  that exact person or group approved.
- If a send is not send-approved, say that directly. Do not work around the
  approval gate.
