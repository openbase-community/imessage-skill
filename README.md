# iMessage CLI Skill

Local Mac iMessage CLI and agent skill with a WhatsApp-style approval boundary.

## Install Skill

```sh
npx skills add montaguegabe/imessage-skill --list
npx skills add montaguegabe/imessage-skill --skill imessage
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
