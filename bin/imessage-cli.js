#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  appendApprovalAudit,
  approveEntity,
  createOutboundMessage,
  listApprovedEntities,
  listCatalogActivity,
  listCatalogEntities,
  listQueuedOutboundMessages,
  listRecentMessages,
  openApprovedDb,
  openOutboxDb,
  revokeEntity,
  searchCatalogEntities,
} from '../lib/imessage-db.js'
import { importFromBackups } from '../lib/imessage-import.js'
import { ensureRuntimeLayout, runtimeRootFromOptions } from '../lib/imessage-paths.js'

async function main(argv = process.argv.slice(2)) {
  const { command, args, options } = parseArgs(argv)
  if (!command || command === 'help' || options.help) return printHelp()

  const root = runtimeRootFromOptions({ root: options.root })
  ensureRuntimeLayout({ root })
  let approvedDb = null
  let outboxDb = null
  try {
    switch (command) {
      case 'contacts':
        return output(listCatalogEntities({ root, kind: 'handle', limit: intOption(options.limit, 50), offset: intOption(options.offset, 0) }), options)
      case 'conversations':
        return output(listCatalogEntities({ root, kind: 'chat', limit: intOption(options.limit, 50), offset: intOption(options.offset, 0) }), options)
      case 'search':
        requireArgs(command, args, 1)
        return output(searchCatalogEntities(args.join(' '), { root, limit: intOption(options.limit, 25) }), options)
      case 'activity':
        return output(listCatalogActivity({ root, limit: intOption(options.limit, 25), sinceIso: sinceIsoOption(options.since), order: options.order ?? 'desc' }), options)
      case 'approved':
        return output(listApprovedEntities({ root }), options)
      case 'recent':
        requireArgs(command, args, 1)
        approvedDb = openApprovedDb({ root, readOnly: true })
        return output({
          entity_id: args[0],
          messages: listRecentMessages(approvedDb, args[0], {
            root,
            limit: intOption(options.limit, 25),
            beforeTimestampMs: options.before ? Number(options.before) : null,
          }),
        }, options)
      case 'approve':
        requireArgs(command, args, 1)
        {
          const entityId = requireExactEntityId(command, args[0])
          const approvalMode = approvalModeFromOptions(options)
          if (approvalMode === 'sudo') {
            requirePrivileged(command)
          } else {
            requestOpenbaseApproval({
              action: 'approve-imessage-entity',
              description: `Approve iMessage contact or conversation ${entityId}`,
              command: formatApprovalCommand(command, [entityId]),
              details: {
                entity_id: entityId,
                approval_mode: approvalMode,
                entity_kind: options.kind ?? inferKind(entityId),
                read_allowed: !options['no-read'],
                send_allowed: Boolean(options.send),
                display_name_present: Boolean(options.name),
              },
            })
          }
          approvedDb = openApprovedDb({ root })
          const entity = approveEntity(approvedDb, entityId, {
            displayName: options.name ?? null,
            readAllowed: !options['no-read'],
            sendAllowed: Boolean(options.send),
            kind: options.kind ?? inferKind(entityId),
            root,
          })
          const audit = appendApprovalAudit(approvedDb, {
            action: 'approve-imessage-entity',
            entityId,
            approvalMode,
            metadata: {
              entity_kind: entity.kind,
              read_allowed: Boolean(entity.read_allowed),
              send_allowed: Boolean(entity.send_allowed),
            },
          })
          return output({ entity, audit }, options)
        }
      case 'revoke':
        requireArgs(command, args, 1)
        {
          const entityId = requireExactEntityId(command, args[0])
          const approvalMode = approvalModeFromOptions(options)
          if (approvalMode === 'sudo') {
            requirePrivileged(command)
          } else {
            requestOpenbaseApproval({
              action: 'revoke-imessage-entity',
              description: `Revoke iMessage contact or conversation ${entityId}`,
              command: formatApprovalCommand(command, [entityId]),
              details: {
                entity_id: entityId,
                approval_mode: approvalMode,
              },
            })
          }
          approvedDb = openApprovedDb({ root })
          const entity = revokeEntity(approvedDb, entityId, { root })
          const audit = appendApprovalAudit(approvedDb, {
            action: 'revoke-imessage-entity',
            entityId,
            approvalMode,
            metadata: {
              approved_after: Boolean(entity?.approved),
            },
          })
          return output({ entity, audit }, options)
        }
      case 'send':
        requireArgs(command, args, 2)
        {
          const entityId = requireExactEntityId(command, args[0])
          const messageText = args.slice(1).join(' ')
          requestOpenbaseApproval({
            action: 'send-imessage-message',
            description: `Queue an iMessage to ${entityId}`,
            command: formatApprovalCommand(command, [entityId, '[message text redacted]']),
            details: {
              entity_id: entityId,
              approval_mode: 'openbase',
              message_length: messageText.length,
            },
          })
          approvedDb = openApprovedDb({ root })
          outboxDb = openOutboxDb({ root })
          const queued = createOutboundMessage({
            approvedDb,
            outboxDb,
            entityId,
            text: messageText,
            root,
          })
          const audit = appendApprovalAudit(approvedDb, {
            action: 'send-imessage-message',
            entityId,
            approvalMode: 'openbase',
            metadata: {
              outbox_id: queued.id,
              message_length: messageText.length,
            },
          })
          return output({
            queued,
            audit,
            note: 'Queued locally. Delivery is not implemented in v1.',
          }, options)
        }
      case 'queued':
        outboxDb = openOutboxDb({ root, readOnly: true })
        return output(listQueuedOutboundMessages(outboxDb, { limit: intOption(options.limit, 10) }), options)
      case 'import':
        requirePrivileged(command)
        return output(importFromBackups({ root, sourceDir: options.source ?? null }), options)
      default:
        throw new Error(`unknown command: ${command}`)
    }
  } finally {
    approvedDb?.close()
    outboxDb?.close()
  }
}

function parseArgs(argv) {
  const options = {}
  const args = []
  let command = null
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === '--') {
      args.push(...argv.slice(i + 1))
      break
    }
    if (value.startsWith('--')) {
      const [rawName, inlineValue] = value.slice(2).split('=', 2)
      const name = rawName.trim()
      if (['json', 'help', 'send', 'no-read'].includes(name)) options[name] = true
      else if (inlineValue !== undefined) options[name] = inlineValue
      else {
        i += 1
        if (i >= argv.length) throw new Error(`missing value for --${name}`)
        options[name] = argv[i]
      }
      continue
    }
    if (!command) command = value
    else args.push(value)
  }
  return { command, args, options }
}

function output(value, options) {
  if (options.json) console.log(JSON.stringify(value, null, 2))
  else if (Array.isArray(value)) printRows(value)
  else if (value?.messages) {
    console.log(`entity_id: ${value.entity_id}`)
    printRows(value.messages)
  } else console.log(JSON.stringify(value, null, 2))
}

function printRows(rows) {
  for (const row of rows) {
    console.log(Object.entries(row).map(([key, value]) => `${key}=${value ?? ''}`).join('\t'))
  }
}

function requireArgs(command, args, count) {
  if (args.length < count) throw new Error(`${command} requires ${count} argument(s)`)
}

function requirePrivileged(command) {
  if (process.env.IMESSAGE_ALLOW_UNPRIVILEGED_ADMIN === '1') return
  if (isRootUser()) return
  throw new Error(`${command} requires sudo because it changes the approved iMessage surface`)
}

function approvalModeFromOptions(options) {
  const mode = options['approval-mode'] ?? (isRootUser() ? 'sudo' : 'openbase')
  if (!['openbase', 'sudo'].includes(mode)) {
    throw new Error('--approval-mode must be "openbase" or "sudo"')
  }
  return mode
}

function isRootUser() {
  return typeof process.getuid === 'function' && process.getuid() === 0
}

function requireExactEntityId(command, id) {
  const value = String(id ?? '').trim()
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '-')
  if (!value || value === '*' || ['all', 'any', 'everyone', 'all-contacts', 'all-chats'].includes(normalized)) {
    throw new Error(`${command} requires one exact contact or conversation id; wildcard approvals are not allowed`)
  }
  return value
}

function requestOpenbaseApproval({ action, description, command, details }) {
  if (process.env.IMESSAGE_SKIP_OPENBASE_APPROVAL === '1') return
  const approvalCommand = process.env.OPENBASE_CODER_APPROVAL_COMMAND ?? 'openbase-coder'
  const timeoutSeconds = process.env.OPENBASE_CODER_APPROVAL_TIMEOUT_SECONDS ?? '300'
  const approvalArgs = [
    'user',
    'approval',
    'request',
    '--skill',
    'imessage',
    '--action',
    action,
    '--description',
    description,
    '--timeout',
    timeoutSeconds,
  ]
  if (command) approvalArgs.push('--command', command)
  for (const [key, value] of Object.entries(details ?? {})) approvalArgs.push('--detail', `${key}=${value}`)
  const result = spawnSync(approvalCommand, approvalArgs, {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH].filter(Boolean).join(':'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error(`Openbase Coder approval failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || '').trim() || 'Openbase Coder approval was not accepted.')
}

function formatApprovalCommand(command, args) {
  return ['imessage-local', command, ...args.map(formatCommandArg)].join(' ')
}

function formatCommandArg(value) {
  const raw = String(value)
  if (/^[A-Za-z0-9_@.+:/=-]+$/.test(raw)) return raw
  return JSON.stringify(raw)
}

function intOption(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function sinceIsoOption(value) {
  const date = parseSinceDate(value)
  return date ? date.toISOString() : null
}

function parseSinceDate(value) {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (raw.toLowerCase() === 'today') {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return today
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number)
    return new Date(year, month - 1, day)
  }
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid --since value: ${value}`)
  return parsed
}

function inferKind(id) {
  return String(id).startsWith('iMessage;') || String(id).includes('chat') ? 'chat' : 'handle'
}

function printHelp() {
  console.log(`Usage: imessage-local <command> [options]

Commands:
  contacts [--limit N] [--offset N] [--json]
  conversations [--limit N] [--offset N] [--json]
  search QUERY [--limit N] [--json]
  activity [--limit N] [--since today|YYYY-MM-DD|ISO] [--json]
  approved [--json]
  recent CONTACT_OR_CHAT_ID [--limit N] [--before TIMESTAMP_MS] [--json]
  approve CONTACT_OR_CHAT_ID [--approval-mode openbase|sudo] [--name NAME] [--send] [--no-read] [--kind handle|chat] [--json]
  revoke CONTACT_OR_CHAT_ID [--approval-mode openbase|sudo] [--json]
  send CONTACT_OR_CHAT_ID TEXT [--json]
  queued [--limit N] [--json]
  import [--source DIR] [--json]

Options:
  --approval-mode openbase|sudo
                  openbase asks Openbase Coder; sudo uses the strong local-permissions path.
`)
}

main().catch(err => {
  console.error(err?.message ?? err)
  process.exit(1)
})
