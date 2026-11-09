import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotReady, type Gate } from '../src/db.js'
import { createMcp } from '../src/mcp.js'
import { LIMITS, Refused } from '../src/schema.js'
import { createServer } from '../src/server.js'
import { signAdminToken, signGateToken } from '../src/token.js'

const SECRET = 'g'.repeat(40)
const APP = 'a'.repeat(20)
const JOB = 'j'.repeat(20)
const pass = (secret = SECRET, seconds = 30) => ({ authorization: `Bearer ${signAdminToken(secret, Math.floor(Date.now() / 1000) + seconds)}` })
const jobPass = (appId = APP, jobId = JOB, secret = SECRET) => ({ authorization: `Bearer ${signGateToken(secret, appId, jobId, Math.floor(Date.now() / 1000) + 600)}` })

// A gateway without a database: it records what it was asked and answers as told.
let calls: unknown[][]
let failure: Error | undefined
const answer = <T>(value: T) => (failure ? Promise.reject(failure) : Promise.resolve(value))
const gate: Gate = {
  limits: LIMITS,
  ready: () => answer(undefined),
  state: (appId) => (calls.push(['state', appId]), answer({ tables: [], overall: 0 })),
  tables: (appId) => (calls.push(['tables', appId]), answer([])),
  commit: (appId, changes) => (calls.push(['commit', appId, changes]), answer([{ name: 'entries', mode: 'append' as const, columns: [] }])),
  sweep: (keep) => (calls.push(['sweep', keep]), answer(['abbbbbbbbbbbbbbbbbbbb_old'])),
}

let server: Server
let base: string
let logged: string[]
const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(base + path, init)
  return { status: res.status, body: await res.json() }
}
const post = (path: string, body: unknown, headers: Record<string, string> = pass()) => call(path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

beforeAll(async () => {
  server = createServer({ gate, mcp: createMcp(gate, { log: (line) => logged.push(line) }), signingSecret: SECRET, log: (line) => logged.push(line) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())
beforeEach(() => {
  calls = []
  logged = []
  failure = undefined
})

describe('gateway routes', () => {
  it('says whether the database is ready, to anyone, and nothing more', async () => {
    expect(await call('/healthz')).toEqual({ status: 200, body: { ready: true } })
    failure = new NotReady('it is a member of another role')
    expect(await call('/healthz')).toEqual({ status: 503, body: { ready: false } })
  })

  it('lets nobody onto the admin routes without a valid pass', async () => {
    const stale = { authorization: `Bearer ${signAdminToken(SECRET, Math.floor(Date.now() / 1000) - 1)}` }
    for (const headers of [{}, { authorization: 'Bearer nonsense' }, pass('h'.repeat(40)), stale, pass(SECRET, 3600), { authorization: pass().authorization.replace('Bearer ', '') }]) {
      expect((await call(`/admin/tables/${APP}`, { headers })).status).toBe(401)
      expect((await post('/admin/commit', { appId: APP, changes: [] }, headers)).status).toBe(401)
      expect((await post('/admin/sweep', { keep: [] }, headers)).status).toBe(401)
    }
    expect(calls).toEqual([])
  })

  it('passes each request to the gateway and answers with its result', async () => {
    const changes = [{ action: 'create_table', table: 'entries', columns: [{ name: 'author', type: 'text' }] }]
    expect(await call(`/admin/tables/${APP}`, { headers: pass() })).toEqual({ status: 200, body: { tables: [] } })
    expect(await post('/admin/commit', { appId: APP, changes })).toEqual({ status: 200, body: { tables: [{ name: 'entries', mode: 'append', columns: [] }] } })
    expect(await post('/admin/sweep', { keep: [APP] })).toEqual({ status: 200, body: { dropped: ['abbbbbbbbbbbbbbbbbbbb_old'] } })
    expect(calls).toEqual([['tables', APP], ['commit', APP, changes], ['sweep', [APP]]])
    expect(logged).toEqual([`app=${APP} changed, 1 tables now`, 'swept abbbbbbbbbbbbbbbbbbbb_old'])
  })

  it('answers a refusal with its sentence', async () => {
    failure = new Refused('An app can have 3 tables at most.')
    expect(await post('/admin/commit', { appId: APP, changes: [] })).toEqual({ status: 400, body: { error: 'An app can have 3 tables at most.' } })
    expect(logged).toEqual([])
  })

  it('keeps the reason to itself when the database is not ready or fails', async () => {
    failure = new NotReady('it can use the schemas auth')
    expect(await post('/admin/sweep', { keep: [] })).toEqual({ status: 503, body: { error: 'database not ready' } })
    failure = new Error('relation "apps.aaaa_secret" already exists')
    expect(await post('/admin/commit', { appId: APP, changes: [] })).toEqual({ status: 500, body: { error: 'database error' } })
    expect(logged).toEqual(['gateway error: relation "apps.aaaa_secret" already exists'])
  })

  it('refuses bodies that are not JSON objects or are too large', async () => {
    for (const body of ['', 'not json', '[]', '"text"', 'null']) expect(await post('/admin/commit', body)).toEqual({ status: 400, body: { error: 'The request body is not a JSON object.' } })
    expect(await post('/admin/sweep', { keep: ['a'.repeat(70_000)] })).toEqual({ status: 400, body: { error: 'The request is too large.' } })
    expect(calls).toEqual([])
  })

  it('opens the tools to a job with its pass, and to nobody else', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    const listed = await post('/mcp', list, jobPass())
    expect(listed.status).toBe(200)
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_tables', 'create_table', 'add_column'])
    for (const headers of [{}, pass(), jobPass(APP, JOB, 'h'.repeat(40)), { authorization: 'Bearer ${AG_DB_TOKEN}' }, { authorization: 'Bearer none' }]) expect((await post('/mcp', list, headers)).status).toBe(401)
    // The other way round: a job's pass is no admin pass.
    expect((await call(`/admin/tables/${APP}`, { headers: jobPass() })).status).toBe(401)
    expect((await post('/admin/sweep', { keep: [] }, jobPass())).status).toBe(401)
    expect((await call(`/admin/plan/${JOB}`, { headers: jobPass() })).status).toBe(401)
  })

  it('writes down what a job asks for and hands it to the orchestrator', async () => {
    const create = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_table', arguments: { table: 'entries', columns: [{ name: 'author', type: 'text' }] } } }
    const noted = await post('/mcp', create, jobPass())
    expect(noted.body).toMatchObject({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: expect.stringContaining('Noted.') }] } })
    expect(await call(`/admin/plan/${JOB}`, { headers: pass() })).toEqual({
      status: 200,
      body: { appId: APP, changes: [{ action: 'create_table', table: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }] }] },
    })
    expect(await call(`/admin/plan/${'k'.repeat(20)}`, { headers: pass() })).toEqual({ status: 200, body: { appId: null, changes: [] } })
    expect((await call('/admin/plan/not-a-job', { headers: pass() })).status).toBe(404)
    // Nothing was applied: the gateway was only asked what exists.
    expect(calls).toEqual([['state', APP]])
  })

  it('answers a notification with nothing and has no stream to offer', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: jobPass(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    expect([res.status, await res.text()]).toEqual([202, ''])
    const stream = await fetch(`${base}/mcp`, { headers: jobPass() })
    expect([stream.status, stream.headers.get('allow')]).toEqual([405, 'POST'])
  })

  it('knows no other routes', async () => {
    expect((await call('/')).status).toBe(404)
    expect((await call('/admin/tables', { headers: pass() })).status).toBe(404)
    expect((await call(`/admin/tables/${APP}/x`, { headers: pass() })).status).toBe(404)
    expect((await call('/admin/commit', { headers: pass() })).status).toBe(404)
    expect((await call(`/admin/tables/${APP}`, { method: 'DELETE', headers: pass() })).status).toBe(404)
  })
})
