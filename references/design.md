# iMessage CLI Design

The iMessage CLI mirrors the current WhatsApp local archive pattern:

- source and skill usually live in `~/Developer/skills/imessage`
- runtime lives in `~/.imessage-cli`
- raw source snapshots are service-only
- catalog and approved stores are group-readable
- send queue is group-writable but gated by CLI approval checks

The native backup helper is the only scheduled backup path. It writes to
`~/.imessage-cli/inbox/`, and the `_imessage` importer moves those snapshots
into protected storage. There is no `/tmp/imessage-backups` fallback because
that would leave raw Messages and Contacts databases outside the approval
boundary.
