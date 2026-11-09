import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sweepTables } from '../src/gate.js'

const SECRET = 'g'.repeat(40)
const APP = 'a'.repeat(20)

// A stand-in for the database gateway that keeps what it was sent.
let server: Server
let url: string
let seen: { method?: string; path?: string; authorization?: string; body: string }[]
let status: number

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body })
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 200 ? { dropped: [`a${'b'.repeat(20)}_entries`] } : { error: 'database not ready' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())
beforeEach(() => {
  seen = []
  status = 200
})

describe('sweepTables', () => {
  it('sends the live apps with a pass that is good for 30 seconds', async () => {
    const before = Math.floor(Date.now() / 1000)
    expect(await sweepTables({ GATE_URL: url, GATE_SIGNING_SECRET: SECRET }, new Set([APP]))).toEqual([`a${'b'.repeat(20)}_entries`])

    const [request] = seen
    expect(request).toMatchObject({ method: 'POST', path: '/admin/sweep', body: JSON.stringify({ keep: [APP] }) })
    const [prefix, expiry, mac] = /^Bearer (.+)$/.exec(request!.authorization!)![1]!.split('.')
    expect(prefix).toBe('aga1')
    expect(Number(expiry) - before).toBeGreaterThanOrEqual(30)
    expect(Number(expiry) - before).toBeLessThanOrEqual(31)
    expect(mac).toBe(createHmac('sha256', SECRET).update(`aga1.${expiry}`).digest('hex'))
  })

  it('leaves the gateway alone when it has no secret for it', async () => {
    expect(await sweepTables({ GATE_URL: url, GATE_SIGNING_SECRET: undefined }, [APP])).toEqual([])
    expect(seen).toEqual([])
  })

  it('fails when the gateway does not do it', async () => {
    status = 503
    await expect(sweepTables({ GATE_URL: url, GATE_SIGNING_SECRET: SECRET }, [APP])).rejects.toThrow('the database gateway answered 503')
  })
})
