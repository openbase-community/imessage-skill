import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const script = readFileSync(new URL('../scripts/messages-transport.js', import.meta.url), 'utf8')
const handle = '+15551234567'
const target = { kind: 'handle', id: handle, handle, service: 'SMS', chatIds: [`any;-;${handle}`] }

function execute(payload, chats) {
  const sent = []
  const app = {
    chats: { whose: ({ id }) => () => chats.filter(chat => chat.id === id) },
    send: (text, { to }) => sent.push({ text, to: to.id }),
  }
  const response = JSON.parse(runInNewContext(`${script}\nrun()`, {
    ObjC: { import: () => {}, unwrap: value => value },
    $: { NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: JSON.stringify(payload) } }, NSString: { alloc: { initWithDataEncoding: value => value } }, NSUTF8StringEncoding: 4 },
    Application: () => app,
  }))
  return { response, sent }
}

test('native preflight checks exact chat metadata without sending', () => {
  const chat = { id: target.chatIds[0], participants: () => [{ handle: () => handle }] }
  const { response, sent } = execute({ mode: 'check', target }, [chat])
  assert.equal(response.status, 'ready')
  assert.equal(sent.length, 0)
})

test('native delivery submits the body unchanged to the exact matching participant', () => {
  const chat = { id: target.chatIds[0], participants: () => [{ handle: () => handle }] }
  const text = 'Synthetic text "quotes"\n🎾'
  const { response, sent } = execute({ mode: 'send', target, text }, [chat])
  assert.equal(response.status, 'submitted')
  assert.deepEqual(sent, [{ text, to: chat.id }])
})

test('native direct sender refuses a group or a different participant even with the same chat ID', () => {
  for (const participants of [[{ handle: () => '+15557654321' }], [{ handle: () => handle }, { handle: () => '+15557654321' }]]) {
    const chat = { id: target.chatIds[0], participants: () => participants }
    const { response, sent } = execute({ mode: 'send', target, text: 'test' }, [chat])
    assert.equal(response.error, 'no-target')
    assert.equal(sent.length, 0)
  }
})

test('native group sends match the exact approved chat ID only', () => {
  const chat = { id: 'iMessage;+;chat123' }
  const { response, sent } = execute({ mode: 'send', target: { kind: 'chat', id: chat.id }, text: 'test' }, [chat, { id: 'iMessage;+;chat456' }])
  assert.equal(response.status, 'submitted')
  assert.deepEqual(sent, [{ text: 'test', to: chat.id }])
})
