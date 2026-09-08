import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createOutboundMessage, getEntity } from './imessage-db.js'

const SCRIPT = fileURLToPath(new URL('../scripts/messages-transport.js', import.meta.url))

export function sendTarget(db, entityId) {
  // The protected approval store is authoritative, not its exported catalog.
  const entity = getEntity(db, entityId)
  if (!entity?.approved || !entity.send_allowed) throw new Error('contact or conversation is not approved for sending')
  if (entity.kind === 'chat') return { kind: 'chat', id: entity.id }
  const handle = entity.normalized_id || entity.id
  if (!/^\+?[0-9]{7,15}$/.test(handle) && !/^[^\s@;]+@[^\s@;]+\.[^\s@;]+$/.test(handle)) {
    throw new Error('send requires an exact phone number, email address, or approved chat ID')
  }
  const chats = db.prepare('SELECT id FROM entities WHERE kind = ? AND is_group = 0 AND normalized_id = ?').all('chat', handle)
  return { kind: 'handle', id: entity.id, handle, service: entity.service, chatIds: chats.map(chat => chat.id) }
}

export function messagesTransport(payload, { run = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('Messages delivery requires macOS')
  // JSON goes over stdin, never into executable script text or process arguments.
  const result = run('/usr/bin/osascript', ['-l', 'JavaScript', SCRIPT], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024,
  })
  if (result.error || result.status !== 0) {
    // Native errors may contain a message body. Do not echo them to logs/output.
    throw new Error('Messages automation failed or timed out. Check macOS Automation permission and the signed-in Messages account; do not automatically retry a send.')
  }
  const response = JSON.parse(result.stdout.trim())
  if (!response.ok) throw new Error(response.error === 'no-target'
    ? 'No exact recipient/chat is available in Messages. Check the account and SMS forwarding setup.'
    : 'Messages automation failed. Check Automation permission; do not automatically retry a send.')
  return response
}

export function outboundStatus(db, id) {
  const row = db.prepare('SELECT id, entity_id, status, requested_at, sent_at, error FROM outbound_messages WHERE id = ?').get(id)
  if (!row) throw new Error('outbound message not found')
  return row
}

export function deliverMessage({ approvedDb, outboxDb, id, transport = messagesTransport }) {
  const message = outboxDb.prepare('SELECT * FROM outbound_messages WHERE id = ?').get(id)
  if (!message) throw new Error('outbound message not found')
  if (message.status !== 'queued') throw new Error(`message is ${message.status}; refusing a possible duplicate send`)
  const target = sendTarget(approvedDb, message.entity_id)
  // Preflight is read-only and failures leave the message queued.
  transport({ mode: 'check', target })
  sendTarget(approvedDb, message.entity_id)
  const claim = outboxDb.prepare("UPDATE outbound_messages SET status = 'submitting', error = NULL WHERE id = ? AND status = 'queued'").run(id)
  if (claim.changes !== 1) throw new Error('message was already claimed by another sender')
  try {
    transport({ mode: 'send', target, text: message.text })
  } catch (error) {
    // An interrupted Apple Event may have sent the text. Never retry automatically.
    outboxDb.prepare("UPDATE outbound_messages SET status = 'unknown', error = ? WHERE id = ?").run('Submission outcome unknown; verify in Messages before any new send.', id)
    throw error
  }
  outboxDb.prepare("UPDATE outbound_messages SET status = 'submitted', sent_at = ?, error = NULL WHERE id = ?").run(new Date().toISOString(), id)
  return outboundStatus(outboxDb, id)
}

export function sendMessage({ approvedDb, outboxDb, entityId, text, approve, queueOnly = false, transport = messagesTransport }) {
  if (!String(text).trim()) throw new Error('message text must not be empty')
  sendTarget(approvedDb, entityId)
  approve({ entityId, messageLength: text.length })
  sendTarget(approvedDb, entityId)
  const queued = createOutboundMessage({ approvedDb, outboxDb, entityId, text })
  return queueOnly ? outboundStatus(outboxDb, queued.id) : deliverMessage({ approvedDb, outboxDb, id: queued.id, transport })
}
