import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  defaultProtectedSourceDir,
  exportContactsCatalog,
  normalizeIdentifier,
  openApprovedDb,
  persistApprovedMessage,
  readContactsCatalog,
  upsertEntity,
  writeActivityCatalog,
} from './imessage-db.js'

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)

export function importFromBackups({ root, sourceDir = null } = {}) {
  if (!root) throw new Error('root is required')
  const consumed = consumeSource({ root, sourceDir })
  if (!consumed.source_dir) throw new Error('no iMessage backup source found')
  const source = consumed.source_dir
  const chatDbPath = join(source, 'chat.db')
  if (!existsSync(chatDbPath)) throw new Error(`missing chat.db in ${source}`)

  const contacts = loadAddressBookContacts(source)
  const db = openApprovedDb({ root })
  try {
    const beforeApproved = new Set(readContactsCatalog({ root }).filter(row => row.approved).map(row => row.id))
    const chatDb = new DatabaseSync(chatDbPath, { readOnly: true })
    try {
      const stats = importChatDb({ root, db, chatDb, contacts })
      exportContactsCatalog(db, { root })
      return {
        ...consumed,
        ...stats,
        approved_before_import: beforeApproved.size,
      }
    } finally {
      chatDb.close()
    }
  } finally {
    db.close()
  }
}

const SNAPSHOT_RETENTION = 3

function consumeSource({ root, sourceDir = null }) {
  const sourceRoot = defaultProtectedSourceDir(root)
  const snapshotsDir = join(sourceRoot, 'snapshots')
  const inboxDir = join(root, 'inbox')
  mkdirSync(snapshotsDir, { recursive: true })

  const candidates = []
  if (sourceDir) candidates.push({ path: sourceDir, origin: 'explicit' })
  for (const inbox of listDirs(inboxDir)) candidates.push({ path: inbox.path, origin: 'inbox', removeAfterCopy: true })
  if (!candidates.length) return { source_dir: null, source_origin: null }

  const chosen = candidates.sort((a, b) => mtimeMs(b.path) - mtimeMs(a.path))[0]
  const snapshotName = `${timestampName()}-${chosen.origin}`
  const snapshotDir = join(snapshotsDir, snapshotName)
  cpSync(chosen.path, snapshotDir, { recursive: true, force: true, errorOnExist: false })
  if (chosen.removeAfterCopy) markInboxConsumed(chosen.path)

  pruneSnapshots(snapshotsDir, SNAPSHOT_RETENTION)

  const latestDir = join(sourceRoot, 'latest')
  rmSync(latestDir, { recursive: true, force: true })
  cpSync(snapshotDir, latestDir, { recursive: true, force: true, errorOnExist: false })
  return {
    source_dir: latestDir,
    source_origin: chosen.origin,
    snapshot_dir: snapshotDir,
  }
}

function pruneSnapshots(snapshotsDir, keep) {
  try {
    const entries = readdirSync(snapshotsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: join(snapshotsDir, e.name) }))
      .sort((a, b) => b.name.localeCompare(a.name))
    for (const entry of entries.slice(keep)) {
      rmSync(entry.path, { recursive: true, force: true })
    }
  } catch {
    // non-fatal: pruning is best-effort
  }
}

function importChatDb({ root, db, chatDb, contacts }) {
  const handleRows = chatDb.prepare(`
    SELECT ROWID as rowid, id, service, uncanonicalized_id, person_centric_id
    FROM handle
  `).all()
  const handlesByRowId = new Map()
  const handleEntities = []
  for (const handle of handleRows) {
    const id = handle.id
    const displayName = contacts.get(normalizeIdentifier(id)) ?? null
    const last = lastMessageForHandle(chatDb, handle.rowid)
    const entity = {
      id,
      kind: 'handle',
      display_name: displayName,
      normalized_id: normalizeIdentifier(id),
      service: handle.service,
      handle_rowid: handle.rowid,
      is_group: 0,
      participant_count: 1,
      last_message_at: last?.last_message_at ?? null,
      last_inbound_message_at: last?.last_inbound_message_at ?? null,
      last_outbound_message_at: last?.last_outbound_message_at ?? null,
    }
    handlesByRowId.set(handle.rowid, entity)
    handleEntities.push(entity)
    upsertEntity(db, entity, { exportCatalog: false })
  }

  const chatRows = chatDb.prepare(`
    SELECT
      c.ROWID as rowid,
      c.guid,
      c.chat_identifier,
      c.display_name,
      c.service_name,
      c.room_name,
      c.style,
      COUNT(DISTINCT chj.handle_id) as participant_count,
      CAST(MAX(m.date) AS TEXT) as last_message_date
    FROM chat c
    LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
    LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    LEFT JOIN message m ON m.ROWID = cmj.message_id
    GROUP BY c.ROWID
  `).all()
  const chatsByRowId = new Map()
  for (const chat of chatRows) {
    const isGroup = Number(chat.participant_count ?? 0) > 1 || Boolean(chat.room_name) || Number(chat.style ?? 0) !== 45
    const displayName = chat.display_name || (isGroup ? chat.chat_identifier : contacts.get(normalizeIdentifier(chat.chat_identifier))) || chat.chat_identifier || chat.guid
    const lastIso = imessageDateToIso(chat.last_message_date)
    const entity = {
      id: chat.guid,
      kind: 'chat',
      display_name: displayName,
      normalized_id: normalizeIdentifier(chat.chat_identifier ?? chat.guid),
      service: chat.service_name,
      chat_rowid: chat.rowid,
      chat_identifier: chat.chat_identifier,
      is_group: isGroup ? 1 : 0,
      participant_count: Number(chat.participant_count ?? 0),
      last_message_at: lastIso,
    }
    chatsByRowId.set(chat.rowid, entity)
    upsertEntity(db, entity, { exportCatalog: false })
  }

  const approved = new Set(readApprovedIds(db))
  const rows = chatDb.prepare(`
    SELECT
      m.ROWID as rowid,
      m.guid,
      m.text,
      m.handle_id,
      m.service,
      CAST(m.date AS TEXT) as date,
      m.is_from_me,
      cmj.chat_id
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    WHERE m.guid IS NOT NULL AND m.date IS NOT NULL
    ORDER BY m.date ASC, m.ROWID ASC
  `).all()

  const events = []
  let approvedMessages = 0
  let skippedMessages = 0
  for (const row of rows) {
    const chat = chatsByRowId.get(row.chat_id)
    const sender = handlesByRowId.get(row.handle_id)
    const entityId = approvedEntityForMessage({ chat, sender, approved })
    const timestampMs = imessageDateToMs(row.date)
    const dateIso = new Date(timestampMs).toISOString()
    const activityEntity = chat?.id ?? sender?.id ?? `message:${row.rowid}`
    events.push({
      event_id: row.guid,
      entity_id: activityEntity,
      chat_id: chat?.id ?? null,
      sender_id: row.is_from_me ? 'me' : sender?.id ?? null,
      direction: row.is_from_me ? 'outbound' : 'inbound',
      timestamp_ms: timestampMs,
      date_iso: dateIso,
      service: row.service ?? chat?.service ?? null,
      approved: entityId ? 1 : 0,
    })

    updateEntityActivity(db, chat?.id, timestampMs, dateIso, Boolean(row.is_from_me))
    if (sender?.id) updateEntityActivity(db, sender.id, timestampMs, dateIso, Boolean(row.is_from_me))

    if (!entityId) {
      skippedMessages += 1
      continue
    }
    const result = persistApprovedMessage(db, {
      guid: row.guid,
      entity_id: entityId,
      chat_id: chat?.id ?? '',
      sender_id: row.is_from_me ? 'me' : sender?.id ?? null,
      is_from_me: Boolean(row.is_from_me),
      timestamp_ms: timestampMs,
      date_iso: dateIso,
      service: row.service ?? chat?.service ?? null,
      text: row.text ?? null,
      source: 'chat.db',
    }, { root })
    if (result.saved) approvedMessages += 1
    else skippedMessages += 1
  }

  const activityCount = writeActivityCatalog(root, events)
  return {
    handles_discovered: handleEntities.length,
    chats_discovered: chatRows.length,
    messages_scanned: rows.length,
    approved_messages_written: approvedMessages,
    unapproved_messages_skipped: skippedMessages,
    activity_events_written: activityCount,
  }
}

function approvedEntityForMessage({ chat, sender, approved }) {
  if (chat?.is_group && approved.has(chat.id)) return chat.id
  if (chat && approved.has(chat.id)) return chat.id
  if (sender && approved.has(sender.id)) return sender.id
  return null
}

function readApprovedIds(db) {
  return db.prepare('SELECT id FROM entities WHERE approved = 1 AND read_allowed = 1').all().map(row => row.id)
}

function updateEntityActivity(db, entityId, _timestampMs, dateIso, fromMe) {
  if (!entityId) return
  db.prepare(`
    UPDATE entities
    SET last_message_at = CASE WHEN last_message_at IS NULL OR ? > last_message_at THEN ? ELSE last_message_at END,
        last_inbound_message_at = CASE WHEN ? = 0 AND (last_inbound_message_at IS NULL OR ? > last_inbound_message_at) THEN ? ELSE last_inbound_message_at END,
        last_outbound_message_at = CASE WHEN ? = 1 AND (last_outbound_message_at IS NULL OR ? > last_outbound_message_at) THEN ? ELSE last_outbound_message_at END
    WHERE id = ?
  `).run(dateIso, dateIso, fromMe ? 1 : 0, dateIso, dateIso, fromMe ? 1 : 0, dateIso, dateIso, entityId)
}

function lastMessageForHandle(chatDb, handleRowId) {
  const row = chatDb.prepare(`
    SELECT
      CAST(MAX(date) AS TEXT) as last_message_date,
      CAST(MAX(CASE WHEN is_from_me = 0 THEN date ELSE NULL END) AS TEXT) as last_inbound_date,
      CAST(MAX(CASE WHEN is_from_me = 1 THEN date ELSE NULL END) AS TEXT) as last_outbound_date
    FROM message
    WHERE handle_id = ?
  `).get(handleRowId)
  return {
    last_message_at: imessageDateToIso(row?.last_message_date),
    last_inbound_message_at: imessageDateToIso(row?.last_inbound_date),
    last_outbound_message_at: imessageDateToIso(row?.last_outbound_date),
  }
}

function loadAddressBookContacts(source) {
  const dbPath = readdirSync(source).find(name => /^AddressBook-.*\.abcddb$/.test(name))
  const contacts = new Map()
  if (!dbPath) return contacts
  const db = new DatabaseSync(join(source, dbPath), { readOnly: true })
  try {
    const people = db.prepare(`
      SELECT Z_PK as pk,
        TRIM(COALESCE(ZFIRSTNAME, '') || ' ' || COALESCE(ZLASTNAME, '')) as full_name,
        ZORGANIZATION as organization,
        ZNICKNAME as nickname
      FROM ZABCDRECORD
      WHERE Z_ENT IS NOT NULL
    `).all()
    const names = new Map()
    for (const person of people) {
      const name = person.full_name || person.nickname || person.organization
      if (name) names.set(person.pk, name)
    }
    for (const row of safeAll(db, 'SELECT ZOWNER as owner, ZFULLNUMBER as value FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL')) {
      if (names.has(row.owner)) contacts.set(normalizeIdentifier(row.value), names.get(row.owner))
    }
    for (const row of safeAll(db, 'SELECT ZOWNER as owner, ZADDRESS as value FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL')) {
      if (names.has(row.owner)) contacts.set(normalizeIdentifier(row.value), names.get(row.owner))
    }
    for (const row of safeAll(db, 'SELECT ZOWNER as owner, ZADDRESS as value FROM ZABCDMESSAGINGADDRESS WHERE ZADDRESS IS NOT NULL')) {
      if (names.has(row.owner)) contacts.set(normalizeIdentifier(row.value), names.get(row.owner))
    }
  } finally {
    db.close()
  }
  return contacts
}

function safeAll(db, sql) {
  try {
    return db.prepare(sql).all()
  } catch {
    return []
  }
}

export function imessageDateToMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  if (Math.abs(n) > 10_000_000_000_000) return Math.floor(n / 1_000_000) + APPLE_EPOCH_MS
  return n + APPLE_EPOCH_MS
}

export function imessageDateToIso(value) {
  if (value == null) return null
  return new Date(imessageDateToMs(value)).toISOString()
}

function listDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\d{8}T\d{6}Z$/.test(entry.name))
      .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
  } catch {
    return []
  }
}

function markInboxConsumed(path) {
  try {
    rmSync(path, { recursive: true, force: true })
    return
  } catch {
    // A user-session helper may create files with macOS metadata that resists
    // removal by the importer. Rename after snapshotting so it will not be
    // retried forever.
  }
  try {
    renameSync(path, `${path}.consumed-${timestampName()}`)
  } catch {
    // The snapshot is already safely in protected storage. Leave the source in
    // place if even quarantine fails; the strict timestamp filter avoids most
    // stale retry loops.
  }
}

function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function timestampName() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')
}
