import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

export function defaultApprovedDbPath(root) {
  return join(root, 'data', 'approved', 'approved.sqlite')
}

export function defaultOutboxDbPath(root) {
  return join(root, 'data', 'outbox', 'outbox.sqlite')
}

export function defaultCatalogPath(root) {
  return join(root, 'data', 'catalog', 'contacts.json')
}

export function defaultActivityPath(root) {
  return join(root, 'data', 'catalog', 'activity.jsonl')
}

export function defaultProtectedSourceDir(root) {
  return join(root, 'data', 'protected', 'source')
}

export function openApprovedDb({
  root,
  path = process.env.IMESSAGE_DB_PATH ?? defaultApprovedDbPath(root),
  readOnly = false,
} = {}) {
  if (!path) throw new Error('database path is required')
  if (!readOnly) mkdirSync(dirname(path), { recursive: true })
  const db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path)
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = DELETE')
    db.exec('PRAGMA foreign_keys = ON')
    migrateApproved(db)
  }
  return db
}

export function openOutboxDb({
  root,
  path = process.env.IMESSAGE_OUTBOX_PATH ?? defaultOutboxDbPath(root),
  readOnly = false,
} = {}) {
  if (!path) throw new Error('outbox database path is required')
  if (!readOnly) mkdirSync(dirname(path), { recursive: true })
  const db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path)
  if (!readOnly) migrateOutbox(db)
  return db
}

export function migrateApproved(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT,
      normalized_id TEXT,
      service TEXT,
      handle_rowid INTEGER,
      chat_rowid INTEGER,
      chat_identifier TEXT,
      is_group INTEGER NOT NULL DEFAULT 0,
      participant_count INTEGER NOT NULL DEFAULT 0,
      approved INTEGER NOT NULL DEFAULT 0,
      read_allowed INTEGER NOT NULL DEFAULT 0,
      send_allowed INTEGER NOT NULL DEFAULT 0,
      approved_at TEXT,
      revoked_at TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_message_at TEXT,
      last_inbound_message_at TEXT,
      last_outbound_message_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      guid TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      timestamp_ms INTEGER NOT NULL,
      date_iso TEXT NOT NULL,
      service TEXT,
      text TEXT,
      source TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_entity_time
      ON messages(entity_id, timestamp_ms DESC);
  `)
}

export function migrateOutbox(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_messages (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outbound_status
      ON outbound_messages(status, requested_at);
  `)
}

export function upsertEntity(db, entity, { exportCatalog = true, root = null } = {}) {
  if (!entity?.id) return null
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO entities (
      id, kind, display_name, normalized_id, service, handle_rowid, chat_rowid,
      chat_identifier, is_group, participant_count, first_seen_at, last_seen_at,
      last_message_at, last_inbound_message_at, last_outbound_message_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      display_name = COALESCE(excluded.display_name, entities.display_name),
      normalized_id = COALESCE(excluded.normalized_id, entities.normalized_id),
      service = COALESCE(excluded.service, entities.service),
      handle_rowid = COALESCE(excluded.handle_rowid, entities.handle_rowid),
      chat_rowid = COALESCE(excluded.chat_rowid, entities.chat_rowid),
      chat_identifier = COALESCE(excluded.chat_identifier, entities.chat_identifier),
      is_group = excluded.is_group,
      participant_count = MAX(entities.participant_count, excluded.participant_count),
      last_seen_at = excluded.last_seen_at,
      last_message_at = CASE
        WHEN excluded.last_message_at IS NOT NULL AND (entities.last_message_at IS NULL OR excluded.last_message_at > entities.last_message_at) THEN excluded.last_message_at
        ELSE entities.last_message_at
      END,
      last_inbound_message_at = CASE
        WHEN excluded.last_inbound_message_at IS NOT NULL AND (entities.last_inbound_message_at IS NULL OR excluded.last_inbound_message_at > entities.last_inbound_message_at) THEN excluded.last_inbound_message_at
        ELSE entities.last_inbound_message_at
      END,
      last_outbound_message_at = CASE
        WHEN excluded.last_outbound_message_at IS NOT NULL AND (entities.last_outbound_message_at IS NULL OR excluded.last_outbound_message_at > entities.last_outbound_message_at) THEN excluded.last_outbound_message_at
        ELSE entities.last_outbound_message_at
      END
  `).run(
    entity.id,
    entity.kind ?? 'handle',
    entity.display_name ?? null,
    entity.normalized_id ?? normalizeIdentifier(entity.id),
    entity.service ?? null,
    entity.handle_rowid ?? null,
    entity.chat_rowid ?? null,
    entity.chat_identifier ?? null,
    entity.is_group ? 1 : 0,
    Number(entity.participant_count ?? 0),
    now,
    now,
    entity.last_message_at ?? null,
    entity.last_inbound_message_at ?? null,
    entity.last_outbound_message_at ?? null,
  )
  const row = getEntity(db, entity.id)
  if (exportCatalog) exportContactsCatalog(db, { root })
  return row
}

export function approveEntity(db, id, {
  displayName = null,
  readAllowed = true,
  sendAllowed = false,
  kind = 'handle',
  root = null,
} = {}) {
  const now = new Date().toISOString()
  upsertEntity(db, { id, kind, display_name: displayName }, { exportCatalog: false })
  db.prepare(`
    UPDATE entities
    SET approved = 1,
        read_allowed = ?,
        send_allowed = ?,
        display_name = COALESCE(?, display_name),
        approved_at = ?,
        revoked_at = NULL,
        last_seen_at = ?
    WHERE id = ?
  `).run(readAllowed ? 1 : 0, sendAllowed ? 1 : 0, displayName, now, now, id)
  const row = getEntity(db, id)
  exportContactsCatalog(db, { root })
  return row
}

export function revokeEntity(db, id, { root = null } = {}) {
  const now = new Date().toISOString()
  db.prepare(`
    UPDATE entities
    SET approved = 0,
        read_allowed = 0,
        send_allowed = 0,
        revoked_at = ?,
        last_seen_at = ?
    WHERE id = ?
  `).run(now, now, id)
  const row = getEntity(db, id)
  exportContactsCatalog(db, { root })
  return row
}

export function getEntity(db, id) {
  return db.prepare('SELECT * FROM entities WHERE id = ?').get(id) ?? null
}

export function isReadApproved(db, id, options = {}) {
  const catalog = getCatalogEntity(id, options)
  if (catalog) return Boolean(catalog.approved && catalog.read_allowed)
  const row = getEntity(db, id)
  return Boolean(row?.approved && row?.read_allowed)
}

export function isSendApproved(db, id, options = {}) {
  const catalog = getCatalogEntity(id, options)
  if (catalog) return Boolean(catalog.approved && catalog.send_allowed)
  const row = getEntity(db, id)
  return Boolean(row?.approved && row?.send_allowed)
}

export function persistApprovedMessage(db, message, { root = null } = {}) {
  if (!message?.guid || !message?.entity_id) return { saved: false, reason: 'missing-message-key' }
  if (!isReadApproved(db, message.entity_id, { root })) {
    return { saved: false, reason: 'not-approved', entity_id: message.entity_id }
  }
  db.prepare(`
    INSERT INTO messages (
      guid, entity_id, chat_id, sender_id, is_from_me, timestamp_ms, date_iso,
      service, text, source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guid) DO UPDATE SET
      entity_id = excluded.entity_id,
      chat_id = excluded.chat_id,
      sender_id = excluded.sender_id,
      is_from_me = excluded.is_from_me,
      timestamp_ms = excluded.timestamp_ms,
      date_iso = excluded.date_iso,
      service = excluded.service,
      text = excluded.text,
      source = excluded.source
  `).run(
    message.guid,
    message.entity_id,
    message.chat_id,
    message.sender_id ?? null,
    message.is_from_me ? 1 : 0,
    message.timestamp_ms,
    message.date_iso,
    message.service ?? null,
    message.text ?? null,
    message.source ?? null,
  )
  return { saved: true, entity_id: message.entity_id, guid: message.guid }
}

export function listCatalogEntities({ root, kind = null, limit = 50, offset = 0 } = {}) {
  const rows = readContactsCatalog({ root })
  const filtered = kind ? rows.filter(row => row.kind === kind) : rows
  return filtered
    .sort(compareEntities)
    .slice(Math.max(Number(offset) || 0, 0), Math.max(Number(offset) || 0, 0) + normalizeLimit(limit, 50))
}

export function searchCatalogEntities(query, { root, limit = DEFAULT_LIMIT } = {}) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return listCatalogEntities({ root, limit })
  return readContactsCatalog({ root })
    .filter(row => [
      row.id,
      row.display_name,
      row.normalized_id,
      row.chat_identifier,
      row.service,
    ].some(value => String(value ?? '').toLowerCase().includes(q)))
    .sort(compareEntities)
    .slice(0, normalizeLimit(limit, DEFAULT_LIMIT))
}

export function listApprovedEntities({ root } = {}) {
  return readContactsCatalog({ root }).filter(row => row.approved).sort(compareEntities)
}

export function listRecentMessages(db, entityId, { root = null, limit = DEFAULT_LIMIT, beforeTimestampMs = null } = {}) {
  assertReadApproved(db, entityId, { root })
  const before = beforeTimestampMs == null ? Number.MAX_SAFE_INTEGER : Number(beforeTimestampMs)
  return db.prepare(`
    SELECT guid, entity_id, chat_id, sender_id, is_from_me, timestamp_ms, date_iso, service, text, source, created_at
    FROM messages
    WHERE entity_id = ? AND timestamp_ms < ?
    ORDER BY timestamp_ms DESC
    LIMIT ?
  `).all(entityId, before, normalizeLimit(limit, DEFAULT_LIMIT))
}

export function createOutboundMessage({ approvedDb, outboxDb, entityId, text, root = null }) {
  assertSendApproved(approvedDb, entityId, { root })
  const id = randomUUID()
  outboxDb.prepare(`
    INSERT INTO outbound_messages (id, entity_id, text)
    VALUES (?, ?, ?)
  `).run(id, entityId, text)
  return outboxDb.prepare(`
    SELECT id, entity_id, text, status, requested_at, sent_at, error
    FROM outbound_messages
    WHERE id = ?
  `).get(id)
}

export function listQueuedOutboundMessages(db, { limit = 10 } = {}) {
  return db.prepare(`
    SELECT id, entity_id, text, status, requested_at, sent_at, error
    FROM outbound_messages
    ORDER BY requested_at DESC
    LIMIT ?
  `).all(normalizeLimit(limit, 10))
}

export function exportContactsCatalog(db, { root = null, catalogPath = null } = {}) {
  const path = catalogPath ?? (root ? defaultCatalogPath(root) : null)
  if (!path) return []
  const rows = db.prepare(`
    SELECT id, kind, display_name, normalized_id, service, handle_rowid, chat_rowid,
      chat_identifier, is_group, participant_count, approved, read_allowed,
      send_allowed, approved_at, revoked_at, first_seen_at, last_seen_at,
      last_message_at, last_inbound_message_at, last_outbound_message_at
    FROM entities
    ORDER BY COALESCE(display_name, id) COLLATE NOCASE
  `).all().map(normalizeEntityRow)
  writeJsonAtomic(path, { generated_at: new Date().toISOString(), contacts: rows })
  return rows
}

export function readContactsCatalog({ root = null, catalogPath = null } = {}) {
  const path = catalogPath ?? (root ? defaultCatalogPath(root) : null)
  if (!path || !existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const rows = Array.isArray(parsed) ? parsed : parsed.contacts
  return Array.isArray(rows) ? rows.map(normalizeEntityRow) : []
}

export function writeActivityCatalog(root, events) {
  const path = defaultActivityPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const sorted = [...events].sort((a, b) => a.timestamp_ms - b.timestamp_ms || a.event_id.localeCompare(b.event_id))
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, sorted.map(event => JSON.stringify(event)).join('\n') + (sorted.length ? '\n' : ''))
  renameSync(tmp, path)
  return sorted.length
}

export function listCatalogActivity({ root, limit = DEFAULT_LIMIT, sinceIso = null, order = 'desc' } = {}) {
  const path = defaultActivityPath(root)
  if (!existsSync(path)) return []
  const sinceMs = sinceIso ? new Date(sinceIso).getTime() : null
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(row => sinceMs == null || row.timestamp_ms >= sinceMs)
    .sort((a, b) => order === 'asc' ? a.timestamp_ms - b.timestamp_ms : b.timestamp_ms - a.timestamp_ms)
  return rows.slice(0, normalizeLimit(limit, DEFAULT_LIMIT))
}

export function normalizeIdentifier(value) {
  const raw = String(value ?? '').trim()
  if (raw.includes('@')) return raw.toLowerCase()
  const digits = raw.replace(/[^\d+]/g, '')
  return digits || raw.toLowerCase()
}

function getCatalogEntity(id, options = {}) {
  if (!options.root && !options.catalogPath) return null
  return readContactsCatalog(options).find(row => row.id === id) ?? null
}

function assertReadApproved(db, entityId, options = {}) {
  if (!isReadApproved(db, entityId, options)) throw new Error('contact or conversation is not approved for reading')
}

function assertSendApproved(db, entityId, options = {}) {
  if (!isSendApproved(db, entityId, options)) throw new Error('contact or conversation is not approved for sending')
}

function normalizeLimit(value, fallback) {
  return Math.min(Math.max(Number(value) || fallback, 1), MAX_LIMIT)
}

function newer_iso(a, b) {
  if (!a) return b
  if (!b) return a
  return b > a ? b : a
}

function normalizeEntityRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    display_name: row.display_name ?? null,
    normalized_id: row.normalized_id ?? normalizeIdentifier(row.id),
    service: row.service ?? null,
    handle_rowid: row.handle_rowid ?? null,
    chat_rowid: row.chat_rowid ?? null,
    chat_identifier: row.chat_identifier ?? null,
    is_group: Number(row.is_group ?? 0),
    participant_count: Number(row.participant_count ?? 0),
    approved: Number(row.approved ?? 0),
    read_allowed: Number(row.read_allowed ?? 0),
    send_allowed: Number(row.send_allowed ?? 0),
    approved_at: row.approved_at ?? null,
    revoked_at: row.revoked_at ?? null,
    first_seen_at: row.first_seen_at ?? null,
    last_seen_at: row.last_seen_at ?? null,
    last_message_at: row.last_message_at ?? null,
    last_inbound_message_at: row.last_inbound_message_at ?? null,
    last_outbound_message_at: row.last_outbound_message_at ?? null,
  }
}

function compareEntities(a, b) {
  return String(a.display_name ?? a.id).localeCompare(String(b.display_name ?? b.id), undefined, { sensitivity: 'base' })
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, path)
}
