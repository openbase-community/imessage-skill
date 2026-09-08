import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { approveEntity, getEntity, openApprovedDb, openOutboxDb, revokeEntity, upsertEntity } from '../lib/imessage-db.js'
import { deliverMessage, messagesTransport, outboundStatus, sendMessage, sendTarget } from '../lib/imessage-delivery.js'

const entityId = '+15551234567'

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'imessage-delivery-test-'))
  const approvedDb = openApprovedDb({ root })
  const outboxDb = openOutboxDb({ root })
  try {
    approveEntity(approvedDb, entityId, { readAllowed: false, sendAllowed: true, root })
    fn({ approvedDb, outboxDb, root, entityId })
  } finally {
    approvedDb.close()
    outboxDb.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('approved send preflights, submits once, records metadata, and refuses duplicate delivery', () => fixture(ctx => {
  const calls = []
  let approved = false
  const transport = payload => { assert.equal(approved, true); calls.push(payload); return { ok: true } }
  const result = sendMessage({ ...ctx, text: 'Synthetic text', approve: info => { assert.equal(info.entityId, entityId); approved = true }, transport })
  assert.equal(result.status, 'submitted')
  assert.ok(result.sent_at)
  assert.equal(result.text, undefined)
  assert.deepEqual(calls.map(call => call.mode), ['check', 'send'])
  assert.equal(calls[1].text, 'Synthetic text')
  assert.throws(() => deliverMessage({ ...ctx, id: result.id, transport }), /duplicate/)
  assert.equal(calls.length, 2)
}))

test('unapproved sends fail before prompting or queueing', () => fixture(ctx => {
  revokeEntity(ctx.approvedDb, entityId, { root: ctx.root })
  assert.throws(() => sendMessage({ ...ctx, text: 'test', approve: () => assert.fail('prompted'), transport: () => assert.fail('sent') }), /not approved/)
  assert.equal(ctx.outboxDb.prepare('SELECT count(*) AS n FROM outbound_messages').get().n, 0)
}))

test('declined approval creates no outbox entry and performs no transport', () => fixture(ctx => {
  assert.throws(() => sendMessage({ ...ctx, text: 'test', approve: () => { throw new Error('declined') }, transport: () => assert.fail('sent') }), /declined/)
  assert.equal(ctx.outboxDb.prepare('SELECT count(*) AS n FROM outbound_messages').get().n, 0)
}))

test('queue-only never calls Messages; revocation before delivery blocks it', () => fixture(ctx => {
  const queued = sendMessage({ ...ctx, text: 'test', approve: () => {}, queueOnly: true, transport: () => assert.fail('sent') })
  assert.equal(queued.status, 'queued')
  revokeEntity(ctx.approvedDb, entityId, { root: ctx.root })
  assert.throws(() => deliverMessage({ ...ctx, id: queued.id, transport: () => assert.fail('sent') }), /not approved/)
}))

test('revocation during the approval prompt prevents queueing', () => fixture(ctx => {
  assert.throws(() => sendMessage({ ...ctx, text: 'test', approve: () => revokeEntity(ctx.approvedDb, entityId, { root: ctx.root }) }), /not approved/)
  assert.equal(ctx.outboxDb.prepare('SELECT count(*) AS n FROM outbound_messages').get().n, 0)
}))

test('read-only approvals cannot send', () => fixture(ctx => {
  approveEntity(ctx.approvedDb, entityId, { readAllowed: true, sendAllowed: false, root: ctx.root })
  assert.throws(() => sendTarget(ctx.approvedDb, entityId), /not approved/)
}))

test('preflight failure leaves a queued message without attempting a send', () => fixture(ctx => {
  const queued = sendMessage({ ...ctx, text: 'test', approve: () => {}, queueOnly: true })
  assert.throws(() => deliverMessage({ ...ctx, id: queued.id, transport: payload => { assert.equal(payload.mode, 'check'); throw new Error('no account') } }), /no account/)
  assert.equal(outboundStatus(ctx.outboxDb, queued.id).status, 'queued')
}))

test('timeout or ambiguous failure is recorded as unknown and cannot be automatically retried', () => fixture(ctx => {
  const queued = sendMessage({ ...ctx, text: 'test', approve: () => {}, queueOnly: true })
  const transport = payload => { if (payload.mode === 'send') throw new Error('timeout') }
  assert.throws(() => deliverMessage({ ...ctx, id: queued.id, transport }), /timeout/)
  assert.equal(outboundStatus(ctx.outboxDb, queued.id).status, 'unknown')
  assert.throws(() => deliverMessage({ ...ctx, id: queued.id, transport: () => assert.fail('sent') }), /duplicate/)
}))

test('atomic claim prevents concurrent duplicate submission', () => fixture(ctx => {
  const queued = sendMessage({ ...ctx, text: 'test', approve: () => {}, queueOnly: true })
  let sends = 0
  assert.throws(() => deliverMessage({ ...ctx, id: queued.id, transport: payload => {
    assert.equal(payload.mode, 'check')
    deliverMessage({ ...ctx, id: queued.id, transport: inner => { if (inner.mode === 'send') sends++ } })
  } }), /already claimed/)
  assert.equal(sends, 1)
}))

test('exact direct targets exclude group chats and reject name-only handles', () => fixture(ctx => {
  upsertEntity(ctx.approvedDb, { id: 'any;-;+15551234567', kind: 'chat', normalized_id: entityId, is_group: 0 })
  upsertEntity(ctx.approvedDb, { id: 'iMessage;+;chat123', kind: 'chat', normalized_id: entityId, is_group: 1 })
  assert.deepEqual(sendTarget(ctx.approvedDb, entityId).chatIds, ['any;-;+15551234567'])
  approveEntity(ctx.approvedDb, 'A name', { sendAllowed: true })
  assert.throws(() => sendTarget(ctx.approvedDb, 'A name'), /exact phone/)
  assert.equal(getEntity(ctx.approvedDb, entityId).read_allowed, 0)
}))

test('group requires its own exact approval', () => fixture(ctx => {
  assert.throws(() => sendTarget(ctx.approvedDb, 'iMessage;+;chat123'), /not approved/)
  approveEntity(ctx.approvedDb, 'iMessage;+;chat123', { kind: 'chat', sendAllowed: true })
  assert.deepEqual(sendTarget(ctx.approvedDb, 'iMessage;+;chat123'), { kind: 'chat', id: 'iMessage;+;chat123' })
}))

test('transport passes hostile text as JSON data, never executable code or argv', () => {
  const payload = { mode: 'send', target: { kind: 'handle', handle: entityId }, text: '"; do shell script "false"\n🎾' }
  messagesTransport(payload, { platform: 'darwin', run: (command, args, options) => {
    assert.equal(command, '/usr/bin/osascript')
    assert.equal(args.includes(payload.text), false)
    assert.deepEqual(JSON.parse(options.input), payload)
    return { status: 0, stdout: '{"ok":true,"status":"submitted"}' }
  } })
  assert.throws(() => messagesTransport(payload, { platform: 'darwin', run: () => ({ status: 1, stderr: 'SENSITIVE BODY' }) }), error => !error.message.includes('SENSITIVE BODY'))
})
