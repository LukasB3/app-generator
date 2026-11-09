import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotReady, type Gate } from '../src/db.js'
import { Refused } from '../src/schema.js'
import { createServer } from '../src/server.js'
import { signAdminToken } from '../src/token.js'

const SECRET = 'g'.repeat(40)
const APP = 'a'.repeat(20)
const pass = (secret = SECRET, seconds = 30) => ({ authorization: `Bearer ${signAdminToken(secret, Math.floor(Date.now() / 1000) + seconds)}` })

// A gateway without a database: it records what it was asked and answers as told.
let calls: unknown[][]
let failure: Error | undefined
const answer = <T>(value: T) => (failure ? Promise.reject(failure) : Promise.resolve(value))
const gate: Gate = {
  ready: () => answer(undefined),
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
  server = createServer({ gate, signingSecret: SECRET, log: (line) => logged.push(line) })
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

  it('knows no other routes', async () => {
    expect((await call('/')).status).toBe(404)
    expect((await call('/admin/tables', { headers: pass() })).status).toBe(404)
    expect((await call(`/admin/tables/${APP}/x`, { headers: pass() })).status).toBe(404)
    expect((await call('/admin/commit', { headers: pass() })).status).toBe(404)
    expect((await call(`/admin/tables/${APP}`, { method: 'DELETE', headers: pass() })).status).toBe(404)
  })
})
