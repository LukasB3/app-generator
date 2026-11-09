import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// lib/db.js is the one bundled library that is this project's own, and the
// one script in a published app that talks to a server. It runs here against
// stand-ins for the page and the network.
const source = readFileSync(join(import.meta.dirname, '../../sandbox/libs/db.js'), 'utf8')
const settings = { url: 'https://project.example', key: 'public-key', prefix: 'aapp_' }

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}
type Answer = { status?: number; body?: unknown; range?: string } | Error

let sent: Sent[]
let answer: (request: Sent) => Answer
let page: { hidden: boolean }
let wake: (() => void) | undefined

const load = (meta: object | null = settings) => {
  const document = {
    get hidden() {
      return page.hidden
    },
    querySelector: (selector: string) => (selector === 'meta[name="app-generator-db"]' && meta ? { content: JSON.stringify(meta) } : null),
    addEventListener: (type: string, listener: () => void) => type === 'visibilitychange' && (wake = listener),
    removeEventListener: (type: string) => type === 'visibilitychange' && (wake = undefined),
  }
  const window: { db?: any } = {}
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const request = { url, method: init.method, headers: init.headers, body: init.body }
    sent.push(request)
    const reply = answer(request)
    if (reply instanceof Error) throw reply
    const status = reply.status ?? 200
    return { ok: status < 300, status, text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)), headers: { get: (name: string) => (name === 'content-range' ? (reply.range ?? null) : null) } }
  }
  runInNewContext(source, { document, window, fetch, setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer) })
  return window.db
}
const failureOf = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch (error) {
    const { message, status, detail } = error as { message: string; status: number; detail: string }
    return { message, status, detail }
  }
  return expect.unreachable('the call should have failed')
}

beforeEach(() => {
  sent = []
  page = { hidden: false }
  wake = undefined
  answer = () => ({ body: [] })
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('lib/db.js requests', () => {
  it('reads a table of this app with the public key', async () => {
    answer = () => ({ body: [{ id: 1, author: 'Ada' }] })
    const db = load()
    expect(db.available).toBe(true)
    expect(await db.table('entries').list()).toEqual([{ id: 1, author: 'Ada' }])
    expect(sent).toEqual([{ url: 'https://project.example/rest/v1/aapp_entries?select=*&order=id.asc&limit=500', method: 'GET', headers: { apikey: 'public-key', 'Accept-Profile': 'apps' }, body: undefined }])

    await db.table('entries').list({ newestFirst: true, limit: 20 })
    expect(sent[1]!.url).toBe('https://project.example/rest/v1/aapp_entries?select=*&order=id.desc&limit=20')
    await db.table('entries').list({ limit: 100000 })
    await db.table('entries').list({ limit: '5&select=secret' })
    expect(sent.slice(2).map((request) => request.url.split('limit=')[1])).toEqual(['500', '500'])
  })

  it('adds, changes and deletes rows by id', async () => {
    answer = () => ({ status: 201, body: [{ id: 7, author: 'Ada' }] })
    const entries = load().table('entries')
    expect(await entries.insert({ author: 'Ada' })).toEqual({ id: 7, author: 'Ada' })
    expect(sent[0]).toEqual({ url: 'https://project.example/rest/v1/aapp_entries', method: 'POST', headers: { apikey: 'public-key', 'Content-Profile': 'apps', 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: '{"author":"Ada"}' })

    answer = () => ({ body: [{ id: 7, author: 'Grace' }] })
    expect(await entries.update(7, { author: 'Grace' })).toEqual({ id: 7, author: 'Grace' })
    expect(sent[1]).toMatchObject({ url: 'https://project.example/rest/v1/aapp_entries?id=eq.7', method: 'PATCH', body: '{"author":"Grace"}' })

    answer = () => ({ status: 204 })
    await entries.remove('7')
    expect(sent[2]).toMatchObject({ url: 'https://project.example/rest/v1/aapp_entries?id=eq.7', method: 'DELETE', headers: { apikey: 'public-key', 'Content-Profile': 'apps' } })
  })

  it('sends nothing for a name or an id that could be more than a name or an id', async () => {
    const db = load()
    for (const name of ['Entries', 'entries?select=*', '../auth/v1/user', 'a.b', '', 'a'.repeat(31), undefined, 7]) expect(() => db.table(name)).toThrow('Not the name of a table.')
    const entries = db.table('entries')
    for (const id of ['7,id.gt.0', '1 or 1=1', 0, -1, 1.5, null, undefined, {}, '']) {
      expect((await failureOf(() => entries.update(id, { a: 1 }))).message).toBe('Not the id of a row.')
      expect((await failureOf(() => entries.remove(id))).message).toBe('Not the id of a row.')
    }
    for (const values of [null, 'text', [{ a: 1 }], 5]) expect((await failureOf(() => entries.insert(values))).message).toBe('A row is an object of column names and values.')
    expect(sent).toEqual([])
  })

  it('turns refusals into sentences for visitors and keeps what the server said apart', async () => {
    const entries = load().table('entries')
    answer = () => ({ status: 400, body: { code: 'P0001', message: 'table is full' } })
    expect(await failureOf(() => entries.insert({ a: 1 }))).toEqual({ message: 'This list is full. Nothing more can be added.', status: 400, detail: 'table is full' })
    answer = () => ({ status: 400, body: { code: 'P0001', message: 'row too large' } })
    expect((await failureOf(() => entries.insert({ a: 1 }))).message).toBe('That is too long to be saved.')
    answer = () => ({ status: 401, body: { code: '42501', message: 'permission denied for table aapp_entries' } })
    expect((await failureOf(() => entries.remove(1))).message).toBe('That is not allowed here.')
    answer = () => ({ status: 404, body: { message: 'relation does not exist' } })
    expect((await failureOf(() => entries.list())).message).toBe('This app has no such table.')
    answer = () => ({ status: 400, body: { message: '<img src=x onerror=alert(1)>' } })
    expect(await failureOf(() => entries.insert({ a: 1 }))).toEqual({ message: 'The database did not accept that.', status: 400, detail: '<img src=x onerror=alert(1)>' })
    answer = () => new TypeError('Failed to fetch')
    expect(await failureOf(() => entries.list())).toEqual({ message: 'The database could not be reached.', status: 0, detail: '' })
  })

  it('says so when the page was given no database', async () => {
    const db = load(null)
    expect(db.available).toBe(false)
    expect((await failureOf(() => db.table('entries').list())).message).toBe('This app has no database.')
    expect(sent).toEqual([])
  })
})

describe('lib/db.js subscribe', () => {
  // The table as the server would describe it: its rows, and when one was last written.
  let rows: { id: number; updated_at: string }[]
  const serve = () => {
    answer = (request) => {
      if (request.url.includes('select=updated_at')) return { body: [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 1).map(({ updated_at }) => ({ updated_at })), range: rows.length ? `0-0/${rows.length}` : '*/0' }
      if (request.method === 'POST') {
        rows.push({ id: rows.length + 1, updated_at: `2026-11-09T10:00:0${rows.length}Z` })
        return { status: 201, body: [rows.at(-1)] }
      }
      return { body: rows }
    }
  }
  const questions = () => sent.filter((request) => request.url.includes('select=updated_at')).length
  const reads = () => sent.filter((request) => request.url.includes('select=*')).length

  beforeEach(() => {
    rows = [{ id: 1, updated_at: '2026-11-09T10:00:00Z' }]
    serve()
  })

  it('hands over the rows at once, then asks a small question and reads again only when the answer changed', async () => {
    const seen: number[] = []
    load().table('entries').subscribe((all: unknown[]) => seen.push(all.length))
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([1])
    expect(sent[0]).toMatchObject({ url: 'https://project.example/rest/v1/aapp_entries?select=updated_at&order=updated_at.desc&limit=1', headers: { apikey: 'public-key', 'Accept-Profile': 'apps', Prefer: 'count=exact' } })

    await vi.advanceTimersByTimeAsync(2000)
    expect([questions(), reads(), seen]).toEqual([2, 1, [1]])

    // Someone else adds a row, changes one, deletes one: each is noticed.
    rows.push({ id: 2, updated_at: '2026-11-09T10:00:05Z' })
    await vi.advanceTimersByTimeAsync(3000)
    expect([reads(), seen]).toEqual([2, [1, 2]])
    rows[0]!.updated_at = '2026-11-09T10:00:09Z'
    await vi.advanceTimersByTimeAsync(2000)
    expect([reads(), seen]).toEqual([3, [1, 2, 2]])
    rows.pop()
    await vi.advanceTimersByTimeAsync(2000)
    expect([reads(), seen]).toEqual([4, [1, 2, 2, 1]])
  })

  it('asks less and less often while nothing changes, down to three times a minute', async () => {
    load().table('entries').subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    const times: number[] = []
    let last = questions()
    for (let second = 1; second <= 120; second++) {
      await vi.advanceTimersByTimeAsync(1000)
      if (questions() > last) times.push(second)
      last = questions()
    }
    expect(times.slice(0, 5)).toEqual([2, 5, 10, 17, 27])
    expect(times.slice(-3).map((second, index, all) => (index ? second - all[index - 1]! : 20))).toEqual([20, 20, 20])
    expect(reads()).toBe(1)
  })

  it('shows a change made from this page at once', async () => {
    const seen: number[] = []
    const entries = load().table('entries')
    entries.subscribe((all: unknown[]) => seen.push(all.length))
    await vi.advanceTimersByTimeAsync(0)
    await entries.insert({ author: 'Ada' })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([1, 2])
  })

  it('asks nothing while the tab is hidden and catches up when it is shown again', async () => {
    const seen: number[] = []
    page.hidden = true
    load().table('entries').subscribe((all: unknown[]) => seen.push(all.length))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toEqual([])

    page.hidden = false
    wake!()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([1])

    page.hidden = true
    const before = sent.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent.length).toBe(before)
  })

  it('keeps asking after a failure, and stops when told to', async () => {
    const seen: number[] = []
    answer = () => new TypeError('Failed to fetch')
    const stop = load().table('entries').subscribe((all: unknown[]) => seen.push(all.length))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(seen).toEqual([])
    expect(sent.length).toBeGreaterThan(1)

    serve()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(seen).toEqual([1])

    stop()
    const before = sent.length
    rows.push({ id: 2, updated_at: '2026-11-09T11:00:00Z' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sent.length).toBe(before)
    expect(wake).toBeUndefined()
  })
})
