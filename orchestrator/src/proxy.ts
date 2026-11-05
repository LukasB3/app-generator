import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { verifyJobToken } from './token.js'

// The only door out of the sandbox network. It holds the real Anthropic key,
// accepts per-job tokens, and forwards nothing but vetted Messages API calls.
// Node built-ins only, so the process that holds the key has no dependencies.

export interface ProxyPolicy {
  models: string[]
  maxTokens: number
  maxBodyBytes: number
  maxRequestsPerJob: number
  maxOutputTokensPerJob: number
}

export interface ProxyOptions {
  apiKey: string
  signingSecret: string
  policy: ProxyPolicy
  upstream?: string
  log?: (line: string) => void
}

type Verdict = { ok: true; body: string } | { ok: false; message: string }

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
  if (typeof body.model !== 'string' || !policy.models.includes(body.model)) return { ok: false, message: `model not allowed: ${String(body.model).replace(/[^a-z0-9.-]/gi, '').slice(0, 60)}` }
  if ('mcp_servers' in body) return { ok: false, message: 'mcp_servers not allowed' }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return { ok: false, message: 'tools must be a list' }
    for (const tool of body.tools) if (typeof tool?.type === 'string' && tool.type !== 'custom') return { ok: false, message: 'server tools not allowed' }
  }
  if (typeof body.max_tokens !== 'number' || body.max_tokens > policy.maxTokens) body.max_tokens = policy.maxTokens
  return { ok: true, body: JSON.stringify(body) }
}

// Pulls output token counts out of a Messages response. A plain response is
// parsed, never pattern-matched: its tool inputs are raw JSON the model chose,
// so they could imitate a stream event. In a stream they only occur as strings.
export const outputTokensIn = (text: string, streamed: boolean) => {
  if (streamed) {
    let total = 0
    for (const match of text.matchAll(/"type"\s*:\s*"message_delta"[^\n]*?"output_tokens"\s*:\s*(\d+)/g)) total += Number(match[1])
    return total
  }
  try {
    const tokens: unknown = JSON.parse(text)?.usage?.output_tokens
    return typeof tokens === 'number' ? tokens : 0
  } catch {
    return 0
  }
}

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

export const createProxy = ({ apiKey, signingSecret, policy, upstream = 'https://api.anthropic.com', log = console.log }: ProxyOptions) => {
  const usage = new Map<string, { requests: number; outputTokens: number; exp: number }>()

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://proxy')
    if (req.method === 'GET' && url.pathname === '/healthz') return void res.writeHead(200).end('ok')
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') return reply(res, 404, 'not found')

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const job = verifyJobToken(signingSecret, String(req.headers['x-api-key'] ?? bearer ?? ''))
    if (!job) return reply(res, 401, 'invalid or expired job token')

    const now = Date.now() / 1000
    for (const [id, entry] of usage) if (entry.exp < now) usage.delete(id)
    const spent = usage.get(job.jobId) ?? { requests: 0, outputTokens: 0, exp: job.exp }
    usage.set(job.jobId, spent)
    if (spent.requests >= policy.maxRequestsPerJob || spent.outputTokens >= policy.maxOutputTokensPerJob) {
      log(`job=${job.jobId} refused: budget exhausted (${spent.requests} requests, ${spent.outputTokens} output tokens)`)
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
    const upstreamRes = await fetch(`${upstream}/v1/messages${url.search === '?beta=true' ? url.search : ''}`, { method: 'POST', headers, body: verdict.body, signal: abort.signal })

    res.writeHead(upstreamRes.status, { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' })
    const streamed = upstreamRes.headers.get('content-type')?.includes('event-stream') ?? false
    const decoder = new TextDecoder()
    let seen = ''
    for await (const chunk of upstreamRes.body ?? []) {
      res.write(chunk)
      seen += decoder.decode(chunk, { stream: true })
      const lastBreak = seen.lastIndexOf('\n')
      if (streamed && lastBreak >= 0) {
        spent.outputTokens += outputTokensIn(seen.slice(0, lastBreak), true)
        seen = seen.slice(lastBreak + 1)
      }
    }
    spent.outputTokens += outputTokensIn(seen, streamed)
    res.end()
    // Upstream error bodies describe what was wrong with the request; they are worth keeping.
    const detail = upstreamRes.ok ? '' : ` error=${seen.replace(/\s+/g, ' ').slice(0, 400)}`
    log(`job=${job.jobId} status=${upstreamRes.status} requests=${spent.requests} outputTokens=${spent.outputTokens}${detail}`)
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`proxy error: ${error instanceof Error ? error.message : 'unknown'}`)
      if (!res.headersSent) reply(res, 502, 'upstream error')
      else res.destroy()
    })
  })
}
