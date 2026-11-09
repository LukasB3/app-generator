import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { verifyJobToken } from './token.js'

// The only door out of the sandbox network. It holds the real Anthropic key,
// accepts per-job tokens, and forwards nothing but vetted Messages API calls.
// Node built-ins only, so the process that holds the key has no dependencies.

const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
// Token counts of each kind, or what one token of each kind costs. Prices are
// in USD per million tokens, which is the same number as micro-USD per token.
export type Usage = Record<(typeof KINDS)[number], number>

export interface ProxyPolicy {
  // The models a job may use are the ones that have a price.
  prices: Map<string, Usage>
  maxTokens: number
  maxBodyBytes: number
  maxRequestsPerJob: number
  maxOutputTokensPerJob: number
  maxCostUsdPerJob: number
}

export interface ProxyOptions {
  apiKey: string
  signingSecret: string
  policy: ProxyPolicy
  upstream?: string
  log?: (line: string) => void
}

type Verdict = { ok: true; body: string; model: string; maxTokens: number } | { ok: false; message: string }

// Only client-side tools may pass. Server tools (web search, web fetch, code
// execution) and MCP connectors would hand the sandbox internet access through
// Anthropic's side, so a request carrying them is refused outright.
export const vetRequest = (raw: Buffer, policy: ProxyPolicy): Verdict => {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return { ok: false, message: 'body is not JSON' }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, message: 'body is not an object' }
  if (typeof body.model !== 'string' || !policy.prices.has(body.model)) return { ok: false, message: `model not allowed: ${String(body.model).replace(/[^a-z0-9.-]/gi, '').slice(0, 60)}` }
  if ('mcp_servers' in body) return { ok: false, message: 'mcp_servers not allowed' }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return { ok: false, message: 'tools must be a list' }
    for (const tool of body.tools) if (typeof tool?.type === 'string' && tool.type !== 'custom') return { ok: false, message: 'server tools not allowed' }
  }
  if (typeof body.max_tokens !== 'number' || body.max_tokens > policy.maxTokens) body.max_tokens = policy.maxTokens
  return { ok: true, body: JSON.stringify(body), model: body.model, maxTokens: body.max_tokens as number }
}

const count = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0)
const usageFrom = (usage: any): Usage => ({
  input: count(usage?.input_tokens),
  output: count(usage?.output_tokens),
  cacheRead: count(usage?.cache_read_input_tokens),
  cacheWrite: count(usage?.cache_creation_input_tokens),
})

// Pulls the token counts out of a Messages response. `complete` says whether
// the final count arrived. Responses are parsed, never pattern-matched: tool
// inputs are JSON the model chose, so they could imitate a usage block. In a
// stream only an event's own type decides whether its usage is read, and the
// counts are running totals, so the largest one seen is the final one.
export const usageIn = (text: string, streamed: boolean, seen: Usage = noUsage()) => {
  const read = (usage: unknown) => {
    const found = usageFrom(usage)
    for (const kind of KINDS) seen[kind] = Math.max(seen[kind], found[kind])
  }
  const parse = (json: string) => {
    try {
      return JSON.parse(json)
    } catch {
      return undefined
    }
  }

  if (!streamed) {
    const usage = parse(text)?.usage
    if (usage) read(usage)
    return { usage: seen, complete: Boolean(usage) }
  }
  let complete = false
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:') || !line.includes('"usage"')) continue
    const event = parse(line.slice(5))
    if (event?.type === 'message_start') read(event.message?.usage)
    if (event?.type === 'message_delta' && event.usage) {
      read(event.usage)
      complete = true
    }
  }
  return { usage: seen, complete }
}

const noUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const costOf = (usage: Usage, price: Usage) => KINDS.reduce((sum, kind) => sum + usage[kind] * price[kind], 0)

const FORWARDED_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta']

const reply = (res: ServerResponse, status: number, message: string) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }))
}

const readBody = async (req: IncomingMessage, limit: number) => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

// A job's counters outlive its last token by this long, so the orchestrator
// can still read what a job cost after its deadline has passed.
const KEEP_S = 300

export const createProxy = ({ apiKey, signingSecret, policy, upstream = 'https://api.anthropic.com', log = console.log }: ProxyOptions) => {
  const jobs = new Map<string, { requests: number; tokens: Usage; costMicroUsd: number; exp: number }>()

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://proxy')
    if (req.method === 'GET' && url.pathname === '/healthz') return void res.writeHead(200).end('ok')
    const wantsUsage = req.method === 'GET' && url.pathname === '/v1/usage'
    if (!wantsUsage && (req.method !== 'POST' || url.pathname !== '/v1/messages')) return reply(res, 404, 'not found')

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const job = verifyJobToken(signingSecret, String(req.headers['x-api-key'] ?? bearer ?? ''))
    if (!job) return reply(res, 401, 'invalid or expired job token')

    const now = Date.now() / 1000
    for (const [id, entry] of jobs) if (entry.exp + KEEP_S < now) jobs.delete(id)
    const spent = jobs.get(job.jobId) ?? { requests: 0, tokens: noUsage(), costMicroUsd: 0, exp: job.exp }
    jobs.set(job.jobId, spent)
    // A job is seen with more than one token: the prompt screen's lasts 30 seconds, the build's until its deadline.
    spent.exp = Math.max(spent.exp, job.exp)

    // What the job has used so far, for the holder of one of its tokens.
    if (wantsUsage) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ requests: spent.requests, ...spent.tokens, costMicroUsd: Math.ceil(spent.costMicroUsd) }))

    if (spent.requests >= policy.maxRequestsPerJob || spent.tokens.output >= policy.maxOutputTokensPerJob || spent.costMicroUsd >= policy.maxCostUsdPerJob * 1e6) {
      log(`job=${job.jobId} refused: budget exhausted (${spent.requests} requests, ${spent.tokens.output} output tokens, $${(spent.costMicroUsd / 1e6).toFixed(4)})`)
      return reply(res, 400, 'job budget exhausted')
    }

    const raw = await readBody(req, policy.maxBodyBytes)
    if (!raw) return reply(res, 413, 'request too large')
    const verdict = vetRequest(raw, policy)
    if (!verdict.ok) {
      log(`job=${job.jobId} refused: ${verdict.message}`)
      return reply(res, 400, verdict.message)
    }
    spent.requests++

    const headers: Record<string, string> = { 'x-api-key': apiKey }
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const used = noUsage()
    let complete = false
    let status = 0
    let seen = ''
    try {
      const upstreamRes = await fetch(`${upstream}/v1/messages${url.search === '?beta=true' ? url.search : ''}`, { method: 'POST', headers, body: verdict.body, signal: abort.signal })
      status = upstreamRes.status

      res.writeHead(status, { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' })
      const streamed = upstreamRes.headers.get('content-type')?.includes('event-stream') ?? false
      const decoder = new TextDecoder()
      for await (const chunk of upstreamRes.body ?? []) {
        res.write(chunk)
        seen += decoder.decode(chunk, { stream: true })
        const lastBreak = seen.lastIndexOf('\n')
        if (streamed && lastBreak >= 0) {
          complete = usageIn(seen.slice(0, lastBreak), true, used).complete || complete
          seen = seen.slice(lastBreak + 1)
        }
      }
      complete = usageIn(seen, streamed, used).complete || complete
      res.end()
    } finally {
      // An answer that was cut short is charged as if it had run in full, so
      // breaking off before the final count arrives is no way around the budget.
      // That covers a caller that hangs up before the first byte (status 0).
      if (!complete && (status === 200 || (status === 0 && abort.signal.aborted))) {
        used.output = Math.max(used.output, verdict.maxTokens)
        if (used.input + used.cacheRead + used.cacheWrite === 0) used.input = Math.ceil(raw.length / 3)
      }
      for (const kind of KINDS) spent.tokens[kind] += used[kind]
      spent.costMicroUsd += costOf(used, policy.prices.get(verdict.model)!)
      // Upstream error bodies describe what was wrong with the request; they are worth keeping.
      const detail = status === 200 ? (complete ? '' : ' cut short') : ` error=${seen.replace(/\s+/g, ' ').slice(0, 400)}`
      log(`job=${job.jobId} status=${status} requests=${spent.requests} outputTokens=${spent.tokens.output} cost=$${(spent.costMicroUsd / 1e6).toFixed(4)}${detail}`)
    }
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`proxy error: ${error instanceof Error ? error.message : 'unknown'}`)
      if (!res.headersSent) reply(res, 502, 'upstream error')
      else res.destroy()
    })
  })
}
