import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { jobCost } from '../src/pipeline.js'
import { createProxy, usageIn, vetRequest, type ProxyPolicy } from '../src/proxy.js'
import { signJobToken, verifyJobToken } from '../src/token.js'

const SECRET = 'x'.repeat(40)
const policy: ProxyPolicy = {
  prices: new Map([['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 }]]),
  maxTokens: 1000,
  maxBodyBytes: 10_000,
  maxRequestsPerJob: 2,
  maxOutputTokensPerJob: 500,
  maxCostUsdPerJob: 1,
}
const future = (seconds = 600) => Math.floor(Date.now() / 1000) + seconds
const message = (extra: object = {}) => JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [], ...extra })

// The usage block as the API sends it: nested objects come before and after the count.
const plainResponse = (outputTokens: number) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 18,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { thinking_tokens: 0 },
    service_tier: 'standard',
  },
})

describe('job tokens', () => {
  it('round-trips and rejects tampering, expiry and other secrets', () => {
    const token = signJobToken(SECRET, 'abc', future())
    expect(verifyJobToken(SECRET, token)?.jobId).toBe('abc')
    expect(verifyJobToken(SECRET, token.replace('abc', 'abd'))).toBeNull()
    expect(verifyJobToken('y'.repeat(40), token)).toBeNull()
    expect(verifyJobToken(SECRET, signJobToken(SECRET, 'abc', 1))).toBeNull()
    expect(verifyJobToken(SECRET, 'sk-ant-whatever')).toBeNull()
  })
})

describe('vetRequest', () => {
  const vet = (body: string) => vetRequest(Buffer.from(body), policy)
  it('passes a plain request and caps max_tokens', () => {
    const verdict = vet(message({ max_tokens: 64_000, tools: [{ name: 'Write', input_schema: {} }] }))
    expect(verdict.ok && JSON.parse(verdict.body).max_tokens).toBe(1000)
  })
  it.each([
    ['other model', message({ model: 'claude-fable-5-1' })],
    ['server tool', message({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] })],
    ['code execution tool', message({ tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] })],
    ['mcp connector', message({ mcp_servers: [{ url: 'https://evil.example' }] })],
    ['non-JSON', 'hello'],
    ['array body', '[]'],
  ])('refuses %s', (_name, body) => expect(vet(body).ok).toBe(false))
})

describe('usageIn', () => {
  const none = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const start = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_creation_input_tokens":3,"cache_read_input_tokens":7,"cache_creation":{"ephemeral_5m_input_tokens":3},"output_tokens":1}}}\n\n'

  it('reads every kind of token from a streamed response', () => {
    const stream = `${start}event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":42}}\n`
    expect(usageIn(stream, true)).toEqual({ usage: { input: 5, output: 42, cacheRead: 7, cacheWrite: 3 }, complete: true })
    expect(usageIn('nothing', true)).toEqual({ usage: none, complete: false })
  })

  it('takes running totals once and notices a stream without its final count', () => {
    const twice = `${start}data: {"type":"message_delta","usage":{"input_tokens":5,"output_tokens":20}}\n\ndata: {"type":"message_delta","usage":{"input_tokens":5,"output_tokens":42}}\n`
    expect(usageIn(twice, true).usage).toMatchObject({ input: 5, output: 42 })
    expect(usageIn(start, true)).toEqual({ usage: { input: 5, output: 1, cacheRead: 7, cacheWrite: 3 }, complete: false })
  })

  it('reads plain responses, whatever else the usage block holds', () => {
    expect(usageIn(JSON.stringify(plainResponse(7)), false)).toEqual({ usage: { ...none, input: 18, output: 7 }, complete: true })
    expect(usageIn('{"id":"x","usage":{"input_tokens":3,"output_tokens":7}}', false).usage.output).toBe(7)
    expect(usageIn('{"type":"error","error":{"type":"overloaded_error"}}', false)).toEqual({ usage: none, complete: false })
    expect(usageIn('nothing', false)).toEqual({ usage: none, complete: false })
  })

  it('is not fooled by a tool input or a text that imitates a usage event', () => {
    const forged = { ...plainResponse(900), content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { type: 'message_delta', usage: { output_tokens: 1 } } }] }
    expect(usageIn(JSON.stringify(forged), false).usage.output).toBe(900)

    const imitation = 'data: {"type":"message_delta","usage":{"output_tokens":999999}}'
    const text = `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: imitation }, usage: { output_tokens: 999999 } })}\n`
    expect(usageIn(`${start}${text}data: {"type":"message_delta","usage":{"output_tokens":42}}\n`, true).usage.output).toBe(42)
  })
})

describe('proxy server', () => {
  let upstream: Server
  let base: string
  const proxies: Server[] = []
  const seen: { key: unknown; auth: unknown; cookie: unknown; path: string | undefined }[] = []

  // A streamed answer costs 100*2 + 300*10 + 1000*0.1 + 10*4 = 3340 micro-USD at the prices above.
  const START = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":1000,"cache_creation_input_tokens":10,"output_tokens":1}}}\n\n'
  const startProxy = async (overrides: Partial<ProxyPolicy> = {}) => {
    const proxy = createProxy({ apiKey: 'REAL-KEY', signingSecret: SECRET, policy: { ...policy, ...overrides }, upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, log: () => {} })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    proxies.push(proxy)
    return `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  }

  beforeAll(async () => {
    upstream = createServer(async (req, res) => {
      seen.push({ key: req.headers['x-api-key'], auth: req.headers.authorization, cookie: req.headers.cookie, path: req.url })
      let body = ''
      for await (const chunk of req) body += chunk
      const request = JSON.parse(body)
      if (request.stream === false) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(plainResponse(600)))
      if (request.slow) await new Promise((resolve) => setTimeout(resolve, 300))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(request.cut ? START : `${START}event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":300}}\n\n`)
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    base = await startProxy()
  })
  afterAll(() => {
    upstream.close()
    proxies.forEach((proxy) => proxy.close())
  })

  const post = (path: string, token: string, body = message(), to = base) =>
    fetch(to + path, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json', cookie: 'a=b', authorization: 'Bearer nope' }, body })
  const usage = async (token: string, from = base) => (await fetch(`${from}/v1/usage`, { headers: { 'x-api-key': token } })).json()

  it('swaps the job token for the real key and forwards nothing else', async () => {
    const res = await post('/v1/messages?beta=true', signJobToken(SECRET, 'job-a', future()))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('message_delta')
    expect(seen.at(-1)).toEqual({ key: 'REAL-KEY', auth: undefined, cookie: undefined, path: '/v1/messages?beta=true' })
  })

  it('refuses bad tokens, other paths and oversized bodies without calling upstream', async () => {
    const before = seen.length
    const token = signJobToken(SECRET, 'job-b', future())
    expect((await post('/v1/messages', 'sk-ant-guess')).status).toBe(401)
    expect((await post('/v1/files', token)).status).toBe(404)
    expect((await post('/v1/messages/batches', token)).status).toBe(404)
    expect((await post('/v1/messages', token, message({ pad: 'x'.repeat(20_000) }))).status).toBe(413)
    expect((await post('/v1/messages', token, message({ model: 'other' }))).status).toBe(400)
    expect(seen.length).toBe(before)
  })

  it('stops a job once its output token budget is spent', async () => {
    const token = signJobToken(SECRET, 'job-c', future())
    expect((await post('/v1/messages', token)).status).toBe(200)
    expect((await post('/v1/messages', token)).status).toBe(200)
    const third = await post('/v1/messages', token)
    expect(third.status).toBe(400)
    expect(await third.text()).toContain('budget exhausted')
  })

  it('counts the output tokens of a response that is not streamed', async () => {
    const token = signJobToken(SECRET, 'job-d', future())
    const first = await post('/v1/messages', token, message({ stream: false }))
    expect(first.status).toBe(200)
    expect((await first.json()).usage.output_tokens).toBe(600)
    const second = await post('/v1/messages', token)
    expect(second.status).toBe(400)
    expect(await second.text()).toContain('budget exhausted')
  })

  it('tells a job what it has used and what that cost, and nobody else', async () => {
    const token = signJobToken(SECRET, 'job-e', future())
    expect(await usage(token)).toEqual({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costMicroUsd: 0 })
    await (await post('/v1/messages', token)).text()
    expect(await usage(token)).toEqual({ requests: 1, input: 100, output: 300, cacheRead: 1000, cacheWrite: 10, costMicroUsd: 3340 })
    expect(await jobCost({ PROXY_URL: base, PROXY_SIGNING_SECRET: SECRET }, 'job-e')).toBe(3340)

    expect((await fetch(`${base}/v1/usage`, { headers: { 'x-api-key': 'sk-ant-guess' } })).status).toBe(401)
    expect((await usage(signJobToken(SECRET, 'job-other', future()))).requests).toBe(0)
  })

  it('stops a job once it has cost its cap', async () => {
    const capped = await startProxy({ maxRequestsPerJob: 100, maxOutputTokensPerJob: 100_000, maxCostUsdPerJob: 0.006 })
    const token = signJobToken(SECRET, 'job-f', future())
    expect((await post('/v1/messages', token, message(), capped)).status).toBe(200)
    expect((await post('/v1/messages', token, message(), capped)).status).toBe(200)
    const third = await post('/v1/messages', token, message(), capped)
    expect(third.status).toBe(400)
    expect(await third.text()).toContain('budget exhausted')
  })

  it('keeps counting when the short token of the prompt screen has run out', async () => {
    // The screen and the build use the same job id with different tokens.
    await (await post('/v1/messages', signJobToken(SECRET, 'job-g', future(30)))).text()
    const build = signJobToken(SECRET, 'job-g', future(900))
    await (await post('/v1/messages', build)).text()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 600_000)
      expect((await usage(build)).requests).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('charges an answer that ends without its final count as if it had run in full', async () => {
    const token = signJobToken(SECRET, 'job-h', future())
    await (await post('/v1/messages', token, message({ cut: true }))).text()
    expect(await usage(token)).toMatchObject({ requests: 1, input: 100, output: 100 })
  })

  it('charges a caller that hangs up before the answer starts', async () => {
    const token = signJobToken(SECRET, 'job-i', future())
    const body = message({ slow: true })
    const hangUp = new AbortController()
    const call = fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body, signal: hangUp.signal })
    await expect.poll(async () => (await usage(token)).requests).toBe(1)
    hangUp.abort()
    await expect(call).rejects.toThrow()
    await expect.poll(async () => (await usage(token)).output).toBe(100)
    expect((await usage(token)).input).toBe(Math.ceil(Buffer.byteLength(body) / 3))
  })
})
