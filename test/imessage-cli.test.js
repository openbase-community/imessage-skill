import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  approveEntity,
  openApprovedDb,
  openOutboxDb,
} from '../lib/imessage-db.js'

const CLI = new URL('../bin/imessage-cli.js', import.meta.url).pathname
const NODE = process.execPath

test('metadata import excludes unapproved message text from catalogs', () => {
  withFixture(({ root, source }) => {
    runCli(root, ['import', '--source', source, '--json'], { IMESSAGE_ALLOW_UNPRIVILEGED_ADMIN: '1' })

    const contacts = JSON.parse(readFileSync(join(root, 'data/catalog/contacts.json'), 'utf8'))
    const activity = readFileSync(join(root, 'data/catalog/activity.jsonl'), 'utf8')
    assert.equal(JSON.stringify(contacts).includes('private hello'), false)
    assert.equal(activity.includes('private hello'), false)

    const search = JSON.parse(runCli(root, ['search', 'Person', '--json']))
    assert.equal(search.find(row => row.id === '+15551234567')?.display_name, 'Synthetic Person')

    assert.throws(
      () => runCli(root, ['recent', '+15551234567', '--json']),
      /not approved/,
    )
  })
})

test('approved direct sender imports readable message rows', () => {
  withFixture(({ root, source }) => {
    const db = openApprovedDb({ root })
    approveEntity(db, '+15551234567', { displayName: 'Synthetic Person', readAllowed: true, root })
    db.close()

    runCli(root, ['import', '--source', source, '--json'], { IMESSAGE_ALLOW_UNPRIVILEGED_ADMIN: '1' })
    const result = JSON.parse(runCli(root, ['recent', '+15551234567', '--json']))
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].text, 'private hello')
  })
})

test('approved group imports by chat guid', () => {
  withFixture(({ root, source }) => {
    const chatGuid = 'iMessage;+;chat123'
    const db = openApprovedDb({ root })
    approveEntity(db, chatGuid, { displayName: 'Synthetic Group', readAllowed: true, kind: 'chat', root })
    db.close()

    runCli(root, ['import', '--source', source, '--json'], { IMESSAGE_ALLOW_UNPRIVILEGED_ADMIN: '1' })
    const result = JSON.parse(runCli(root, ['recent', chatGuid, '--json']))
    assert.equal(result.messages.some(row => row.text === 'group secret'), true)
  })
})

test('approve supports Openbase approval mode without sudo', () => {
  withFixture(({ root }) => {
    const approvalBin = join(root, 'openbase-coder')
    const approvalArgsPath = join(root, 'approval-args.txt')
    writeFileSync(approvalBin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${approvalArgsPath}"\n`)
    chmodSync(approvalBin, 0o755)

    const result = JSON.parse(runCli(
      root,
      ['approve', '+15551234567', '--approval-mode', 'openbase', '--name', 'Synthetic Person', '--send', '--json'],
      {
        PATH: `${root}:${process.env.PATH}`,
        OPENBASE_CODER_APPROVAL_TIMEOUT_SECONDS: '5',
      },
    ))
    assert.equal(result.entity.approved, 1)
    assert.equal(result.entity.send_allowed, 1)
    assert.equal(result.audit.action, 'approve-imessage-entity')
    assert.equal(result.audit.entity_id, '+15551234567')
    assert.equal(result.audit.approval_mode, 'openbase')
    const approvalArgs = readFileSync(approvalArgsPath, 'utf8').trim().split('\n')
    assert.ok(approvalArgs.includes('approve-imessage-entity'))
    assert.ok(approvalArgs.includes('entity_id=+15551234567'))
  })
})

test('sudo approval mode still requires sudo-equivalent privilege', () => {
  withFixture(({ root }) => {
    assert.throws(
      () => runCli(root, ['approve', '+15551234567', '--approval-mode', 'sudo', '--json']),
      /requires sudo/,
    )
  })
})

test('revoke uses Openbase approval mode and writes an audit row', () => {
  withFixture(({ root }) => {
    const entityId = '+15551234567'
    const db = openApprovedDb({ root })
    approveEntity(db, entityId, { displayName: 'Synthetic Person', readAllowed: true, sendAllowed: true, root })
    db.close()

    const approvalBin = join(root, 'openbase-coder')
    const approvalArgsPath = join(root, 'approval-args.txt')
    writeFileSync(approvalBin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${approvalArgsPath}"\n`)
    chmodSync(approvalBin, 0o755)

    const result = JSON.parse(runCli(root, ['revoke', entityId, '--approval-mode', 'openbase', '--json'], {
      PATH: `${root}:${process.env.PATH}`,
      OPENBASE_CODER_APPROVAL_TIMEOUT_SECONDS: '5',
    }))

    assert.equal(result.entity.approved, 0)
    assert.equal(result.audit.action, 'revoke-imessage-entity')
    assert.equal(result.audit.entity_id, entityId)
    assert.equal(result.audit.approval_mode, 'openbase')
    const approvalArgs = readFileSync(approvalArgsPath, 'utf8').trim().split('\n')
    assert.ok(approvalArgs.includes('revoke-imessage-entity'))
    assert.ok(approvalArgs.includes(`entity_id=${entityId}`))
  })
})

test('send requires send approval and Openbase Coder approval before queueing', () => {
  withFixture(({ root }) => {
    const entityId = '+15551234567'
    const db = openApprovedDb({ root })
    approveEntity(db, entityId, { displayName: 'Synthetic Person', readAllowed: true, sendAllowed: true, root })
    db.close()

    const approvalBin = join(root, 'openbase-coder')
    const approvalArgsPath = join(root, 'approval-args.txt')
    writeFileSync(approvalBin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${approvalArgsPath}"\n`)
    chmodSync(approvalBin, 0o755)

    const result = JSON.parse(runCli(root, ['send', entityId, 'hello', 'there', '--json'], {
      PATH: `${root}:${process.env.PATH}`,
      OPENBASE_CODER_APPROVAL_TIMEOUT_SECONDS: '5',
    }))
    assert.equal(result.queued.entity_id, entityId)
    assert.equal(result.queued.text, 'hello there')

    const approvalArgs = readFileSync(approvalArgsPath, 'utf8').trim().split('\n')
    assert.deepEqual(approvalArgs.slice(0, 5), ['user', 'approval', 'request', '--skill', 'imessage'])
    assert.ok(approvalArgs.includes('send-imessage-message'))
    assert.ok(approvalArgs.includes(`entity_id=${entityId}`))
    assert.ok(approvalArgs.includes('message_length=11'))
    assert.equal(approvalArgs.includes('message_preview=hello there'), false)
    assert.equal(approvalArgs.join('\n').includes('hello there'), false)
    assert.equal(result.audit.action, 'send-imessage-message')
    assert.equal(result.audit.approval_mode, 'openbase')

    const outbox = openOutboxDb({ root, readOnly: true })
    const queued = outbox.prepare('SELECT COUNT(*) as n FROM outbound_messages').get()
    outbox.close()
    assert.equal(queued.n, 1)
  })
})

test('CLI rejects wildcard approval targets', () => {
  withFixture(({ root }) => {
    assert.throws(
      () => runCli(root, ['approve', 'all', '--json'], { IMESSAGE_SKIP_OPENBASE_APPROVAL: '1' }),
      /wildcard approvals are not allowed/,
    )
  })
})

function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'imessage-cli-test-'))
  const source = join(root, 'source')
  try {
    createSource(source)
    fn({ root, source })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function runCli(root, args, env = {}) {
  const result = spawnSync(NODE, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      IMESSAGE_RUNTIME_HOME: root,
      IMESSAGE_SKIP_OPENBASE_APPROVAL: env.IMESSAGE_SKIP_OPENBASE_APPROVAL ?? process.env.IMESSAGE_SKIP_OPENBASE_APPROVAL,
      ...env,
    },
  })
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim())
  return result.stdout
}

function createSource(source) {
  mkdirSync(source, { recursive: true })
  const chat = new DatabaseSync(join(source, 'chat.db'))
  try {
    chat.exec(`
      CREATE TABLE handle (
        ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        service TEXT NOT NULL,
        uncanonicalized_id TEXT,
        person_centric_id TEXT
      );
      CREATE TABLE chat (
        ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT UNIQUE NOT NULL,
        chat_identifier TEXT,
        display_name TEXT,
        service_name TEXT,
        room_name TEXT,
        style INTEGER
      );
      CREATE TABLE chat_handle_join (
        chat_id INTEGER,
        handle_id INTEGER
      );
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT UNIQUE NOT NULL,
        text TEXT,
        handle_id INTEGER,
        service TEXT,
        date INTEGER,
        is_from_me INTEGER DEFAULT 0
      );
      CREATE TABLE chat_message_join (
        chat_id INTEGER,
        message_id INTEGER,
        message_date INTEGER
      );
    `)
    chat.prepare('INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)').run(1, '+15551234567', 'iMessage')
    chat.prepare('INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)').run(2, '+15557654321', 'iMessage')
    chat.prepare('INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name, style) VALUES (?, ?, ?, ?, ?, ?)').run(1, 'iMessage;-;+15551234567', '+15551234567', null, 'iMessage', 45)
    chat.prepare('INSERT INTO chat (ROWID, guid, chat_identifier, display_name, service_name, room_name, style) VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 'iMessage;+;chat123', 'chat123', 'Synthetic Group', 'iMessage', 'chat123', 43)
    chat.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(1, 1)
    chat.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(2, 1)
    chat.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(2, 2)

    const base = 700_000_000_000_000_000
    chat.prepare('INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)').run(1, 'm1', 'private hello', 1, 'iMessage', base, 0)
    chat.prepare('INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 'm2', 'group secret', 2, 'iMessage', base + 1_000_000_000, 0)
    chat.prepare('INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)').run(1, 1, base)
    chat.prepare('INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)').run(2, 2, base + 1_000_000_000)
  } finally {
    chat.close()
  }

  const ab = new DatabaseSync(join(source, 'AddressBook-v22.abcddb'))
  try {
    ab.exec(`
      CREATE TABLE ZABCDRECORD (
        Z_PK INTEGER PRIMARY KEY,
        Z_ENT INTEGER,
        ZFIRSTNAME VARCHAR,
        ZLASTNAME VARCHAR,
        ZORGANIZATION VARCHAR,
        ZNICKNAME VARCHAR
      );
      CREATE TABLE ZABCDPHONENUMBER (
        ZOWNER INTEGER,
        ZFULLNUMBER VARCHAR
      );
      CREATE TABLE ZABCDEMAILADDRESS (
        ZOWNER INTEGER,
        ZADDRESS VARCHAR
      );
      CREATE TABLE ZABCDMESSAGINGADDRESS (
        ZOWNER INTEGER,
        ZADDRESS VARCHAR
      );
    `)
    ab.prepare('INSERT INTO ZABCDRECORD (Z_PK, Z_ENT, ZFIRSTNAME, ZLASTNAME) VALUES (?, ?, ?, ?)').run(1, 1, 'Synthetic', 'Person')
    ab.prepare('INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)').run(1, '+15551234567')
  } finally {
    ab.close()
  }
}
