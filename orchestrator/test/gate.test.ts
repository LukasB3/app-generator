import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseDown, gateway } from '../src/gate.js'

const SECRET = 'g'.repeat(40)
const APP = 'a'.repeat(20)
const JOB = 'j'.repeat(20)
const changes = [{ action: 'create_table', table: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }] }]

// A stand-in for the database gateway that keeps what it was sent.
let server: Server
let url: string
let seen: { method?: string; path?: string; authorization?: string; body: string }[]
let status: number
const answers: Record<string, object> = {
  [`/admin/tables/${APP}`]: { tables: [{ name: 'entries', mode: 'append', columns: [] }] },
  [`/admin/plan/${JOB}`]: { appId: APP, changes },
  '/admin/commit': { tables: [] },
  '/admin/sweep': { dropped: [`a${'b'.repeat(20)}_entries`] },
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body })
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 200 ? answers[req.url!] : { error: 'database not ready' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())
beforeEach(() => {
  seen = []
  status = 200
})

const full = () => gateway({ GATE_URL: url, GATE_SIGNING_SECRET: SECRET, SUPABASE_URL: 'https://project.example', SUPABASE_KEY: 'public-key' })

describe('gateway client', () => {
  it('asks with a pass that is good for 30 seconds', async () => {
    const before = Math.floor(Date.now() / 1000)
    expect(await full().sweep(new Set([APP]))).toEqual([`a${'b'.repeat(20)}_entries`])

    const [request] = seen
    expect(request).toMatchObject({ method: 'POST', path: '/admin/sweep', body: JSON.stringify({ keep: [APP] }) })
    const [prefix, expiry, mac] = /^Bearer (.+)$/.exec(request!.authorization!)![1]!.split('.')
    expect(prefix).toBe('aga1')
    expect(Number(expiry) - before).toBeGreaterThanOrEqual(30)
    expect(Number(expiry) - before).toBeLessThanOrEqual(31)
    expect(mac).toBe(createHmac('sha256', SECRET).update(`aga1.${expiry}`).digest('hex'))
  })

  it('fetches tables and what a job asked for, and has changes applied', async () => {
    const gate = full()
    expect(await gate.tables(APP)).toEqual([{ name: 'entries', mode: 'append', columns: [] }])
    expect(await gate.plan(JOB)).toEqual(changes)
    await gate.commit(APP, changes)
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([`GET /admin/tables/${APP}`, `GET /admin/plan/${JOB}`, 'POST /admin/commit'])
    expect(JSON.parse(seen[2]!.body)).toEqual({ appId: APP, changes })
  })

  it('gives a job a pass for its app, and pages the place of their tables', () => {
    const gate = full()
    expect(gate.enabled).toBe(true)
    const [prefix, app, job, expiry, mac] = gate.token(APP, JOB, 1_900_000_000).split('.')
    expect([prefix, app, job, expiry]).toEqual(['agd1', APP, JOB, '1900000000'])
    expect(mac).toBe(createHmac('sha256', SECRET).update(`agd1.${APP}.${JOB}.1900000000`).digest('hex'))
    expect(gate.database(APP)).toEqual({ url: 'https://project.example', key: 'public-key', prefix: `a${APP}_` })
  })

  it('fails as "database down" when the gateway does not do it or is not there', async () => {
    status = 503
    await expect(full().tables(APP)).rejects.toThrow(DatabaseDown)
    await expect(full().commit(APP, changes)).rejects.toThrow('the database gateway answered 503 to /admin/commit')
    await expect(full().plan(JOB)).rejects.toThrow(DatabaseDown)
    const nowhere = gateway({ GATE_URL: 'http://127.0.0.1:9', GATE_SIGNING_SECRET: SECRET, SUPABASE_URL: 'https://project.example', SUPABASE_KEY: 'public-key' })
    await expect(nowhere.tables(APP)).rejects.toThrow(DatabaseDown)
  })

  it('offers no database without the gateway\'s secret or without the address pages would need', async () => {
    for (const cfg of [
      { GATE_URL: url, GATE_SIGNING_SECRET: undefined, SUPABASE_URL: 'https://project.example', SUPABASE_KEY: 'public-key' },
      { GATE_URL: url, GATE_SIGNING_SECRET: SECRET, SUPABASE_URL: undefined, SUPABASE_KEY: 'public-key' },
      { GATE_URL: url, GATE_SIGNING_SECRET: SECRET, SUPABASE_URL: 'https://project.example', SUPABASE_KEY: undefined },
    ]) {
      const gate = gateway(cfg)
      expect(gate.enabled).toBe(false)
      expect(gate.token(APP, JOB, 1_900_000_000)).toBe('-')
      expect(await gate.plan(JOB)).toEqual([])
    }
    expect(seen).toEqual([])
    // Tables that exist are still swept as long as the gateway can be asked.
    expect(await gateway({ GATE_URL: url, GATE_SIGNING_SECRET: undefined, SUPABASE_URL: undefined, SUPABASE_KEY: undefined }).sweep([APP])).toEqual([])
    expect(seen).toEqual([])
    await gateway({ GATE_URL: url, GATE_SIGNING_SECRET: SECRET, SUPABASE_URL: undefined, SUPABASE_KEY: undefined }).sweep([APP])
    expect(seen).toHaveLength(1)
  })
})
