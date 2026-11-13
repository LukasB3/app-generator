// The DevTools protocol over the two pipes Chromium opens with
// --remote-debugging-pipe: it reads commands on fd 3 and writes on fd 4, one
// JSON message at a time, each ended by a zero byte. No port is opened, so a
// page has nothing to connect to.

const MAX_MESSAGE_BYTES = 8_000_000

export const connect = (toBrowser, fromBrowser) => {
  let nextId = 1
  const waiting = new Map()
  const listeners = new Set()
  let pending = []
  let size = 0
  let closed = false

  const close = (reason) => {
    if (closed) return
    closed = true
    for (const { reject } of waiting.values()) reject(new Error(reason))
    waiting.clear()
  }

  const receive = (text) => {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const call = waiting.get(message.id)
      waiting.delete(message.id)
      if (!call) return
      if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`))
      else call.resolve(message.result ?? {})
    } else if (message.method) {
      for (const listener of listeners) listener(message.method, message.params ?? {}, message.sessionId)
    }
  }

  fromBrowser.on('data', (chunk) => {
    let start = 0
    for (let end = chunk.indexOf(0, start); end !== -1; end = chunk.indexOf(0, start)) {
      pending.push(chunk.subarray(start, end))
      receive(Buffer.concat(pending).toString('utf8'))
      pending = []
      size = 0
      start = end + 1
    }
    const rest = chunk.subarray(start)
    size += rest.length
    if (size > MAX_MESSAGE_BYTES) return close('the browser sent a message that is too large')
    if (rest.length) pending.push(rest)
  })
  fromBrowser.on('close', () => close('the browser closed its pipe'))
  fromBrowser.on('error', () => close('the browser pipe failed'))
  toBrowser.on('error', () => close('the browser pipe failed'))

  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        if (closed) return reject(new Error('the browser is gone'))
        const id = nextId++
        waiting.set(id, { resolve, reject, method })
        toBrowser.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
      }),
    // Calls back with every event: (method, params, sessionId).
    listen: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
