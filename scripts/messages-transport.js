// JXA, run by osascript. Only metadata is inspected; message bodies are never read.
ObjC.import('Foundation')

function run() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  const payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)))
  const app = Application('Messages')
  const target = payload.target
  let recipient = null
  try {
    if (target.kind === 'chat') {
      const chats = app.chats.whose({ id: target.id })()
      if (chats.length === 1) recipient = chats[0]
    } else {
      for (const id of target.chatIds) {
        const chats = app.chats.whose({ id })()
        if (chats.length !== 1) continue
        const participants = chats[0].participants()
        if (participants.length === 1 && normalize(participants[0].handle()) === normalize(target.handle)) {
          recipient = chats[0]
          break
        }
      }
      if (!recipient && target.service === 'iMessage') {
        const accounts = app.accounts.whose({ serviceType: 'iMessage', enabled: true })()
        if (accounts.length === 1 && accounts[0].connectionStatus() === 'connected') {
          const participant = accounts[0].participants.byName(target.handle)
          if (participant.exists() && normalize(participant.handle()) === normalize(target.handle)) recipient = participant
        }
      }
    }
    if (!recipient) return JSON.stringify({ ok: false, error: 'no-target' })
    if (payload.mode === 'send') app.send(payload.text, { to: recipient })
    else if (payload.mode !== 'check') return JSON.stringify({ ok: false, error: 'invalid-mode' })
    return JSON.stringify({ ok: true, status: payload.mode === 'send' ? 'submitted' : 'ready' })
  } catch (error) {
    // Never print native errors: they can include the outbound message text.
    return JSON.stringify({ ok: false, error: 'automation', code: Number(error.errorNumber) || null })
  }
}

function normalize(value) {
  const text = String(value).trim()
  return text.includes('@') ? text.toLowerCase() : text.replace(/[^\d+]/g, '')
}
