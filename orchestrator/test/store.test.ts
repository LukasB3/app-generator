import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store.js'

const DAY = 24 * 3_600_000
let dir: string
let path: string

// The file as the live server has it: created before schema versions were counted.
const unversioned = (jobs: [id: string, status: string, createdAt: number][]) => {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE jobs (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', ipHash TEXT NOT NULL, createdAt INTEGER NOT NULL, url TEXT, error TEXT);
    CREATE INDEX jobs_created ON jobs (createdAt, ipHash);
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, jobId TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX events_job ON events (jobId, seq);
  `)
  for (const [id, status, createdAt] of jobs) {
    db.prepare('INSERT INTO jobs (id, prompt, status, ipHash, createdAt) VALUES (?, ?, ?, ?, ?)').run(id, `request ${id}`, status, 'h', createdAt)
    db.prepare('INSERT INTO events (jobId, ts, type, data) VALUES (?, ?, ?, ?)').run(id, createdAt, 'status', status)
  }
  db.close()
}

const version = () => {
  const db = new DatabaseSync(path)
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  db.close()
  return row.user_version
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-store-'))
  path = join(dir, 'jobs.sqlite')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('schema migrations', () => {
  it('brings a file from before versions up to date and keeps its records', () => {
    const created = Date.now() - 3 * DAY
    unversioned([
      ['done1', 'done', created],
      ['failed1', 'failed', created],
      ['queued1', 'queued', created],
    ])
    const store = new Store(path)

    expect(store.getJob('done1')).toMatchObject({ appId: 'done1', prompt: 'request done1', status: 'done', createdAt: created })
    expect(store.events('done1')).toHaveLength(1)
    expect(store.getApp('done1')).toEqual({ id: 'done1', ownerId: null, currentJobId: null, hasDb: 0, createdAt: created, expiresAt: created + 30 * DAY })
    expect(store.getApp('failed1')).toBeUndefined()
    expect(store.liveAppIds().sort()).toEqual(['done1', 'queued1'])
    expect(store.nextQueued()).toMatchObject({ id: 'queued1', appId: 'queued1' })
    expect(store.nextQueued(['queued1'])).toBeUndefined()

    store.createJob({ id: 'fresh1', prompt: 'a new request', ipHash: 'h', expiresAt: Date.now() + DAY })
    expect(store.getJob('fresh1')!.appId).toBe('fresh1')
    expect(store.costSince(0)).toBe(0)
    // Jobs from before receipts were kept have none; new ones do.
    expect(store.receipt('done1')).toBeNull()
    expect(store.receipt('fresh1')).not.toBeNull()
    store.close()
    expect(version()).toBe(7)
  })

  it('keeps a copy of the old file and removes it with the records it mirrors', () => {
    unversioned([['done1', 'done', Date.now()]])
    const store = new Store(path)
    const backup = `${path}.bak`
    const copy = new DatabaseSync(backup)
    expect(copy.prepare('SELECT id FROM jobs').all()).toEqual([{ id: 'done1' }])
    expect(copy.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'apps'`).get()).toBeUndefined()
    copy.close()

    store.purgeOlderThan(Date.now() - 30 * DAY)
    expect(existsSync(backup)).toBe(true)
    const old = new Date(Date.now() - 31 * DAY)
    utimesSync(backup, old, old)
    store.purgeOlderThan(Date.now() - 30 * DAY)
    expect(existsSync(backup)).toBe(false)
    store.close()
  })

  it('undoes a step that fails halfway', () => {
    unversioned([['done1', 'done', Date.now()]])
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE apps (unexpected TEXT)')
    db.close()
    expect(() => new Store(path)).toThrow(/apps/)

    const after = new DatabaseSync(path)
    expect((after.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((column) => column.name)).not.toContain('appId')
    expect(after.prepare('SELECT id FROM jobs').all()).toEqual([{ id: 'done1' }])
    after.close()
    expect(version()).toBe(1)
  })

  it('adds up jobs and what they cost: for everyone, one address or one account', () => {
    const store = new Store(path)
    const now = Date.now()
    store.createJob({ id: 'a', prompt: 'first', ipHash: 'alice', userId: 'user-1', expiresAt: now + DAY, now: now - 2 * DAY })
    store.createJob({ id: 'b', prompt: 'second', ipHash: 'alice', expiresAt: now + DAY })
    store.createJob({ id: 'c', prompt: 'third', ipHash: 'bob', userId: 'user-1', expiresAt: now + DAY })
    store.setCost('a', 700_000)
    store.setCost('b', 250_000.4)
    store.setCost('c', 50_000)

    expect(store.costSince(0)).toBe(1_000_001)
    expect(store.costSince(now - DAY)).toBe(300_001)
    expect(store.costSince(now - DAY, { ipHash: 'alice' })).toBe(250_001)
    expect(store.costSince(now - DAY, { ipHash: 'nobody' })).toBe(0)
    expect(store.costSince(0, { userId: 'user-1' })).toBe(750_000)
    expect(store.countSince(0, { userId: 'user-1' })).toBe(2)
    expect(store.countSince(0, { ipHash: 'alice' })).toBe(2)
    store.close()
  })

  it('leaves an up-to-date file alone and makes no copy of an empty one', () => {
    new Store(path).close()
    expect(version()).toBe(7)
    expect(existsSync(`${path}.bak`)).toBe(false)

    const store = new Store(path)
    store.createJob({ id: 'fresh1', prompt: 'a new request', ipHash: 'h', expiresAt: Date.now() + DAY })
    store.close()
    new Store(path).close()
    expect(existsSync(`${path}.bak`)).toBe(false)
  })
})

describe('the receipt of a build', () => {
  it('adds up the time of each step, a repair round included, and keeps what the build reported', () => {
    const store = new Store(':memory:')
    const t = 1_700_000_000_000
    store.createJob({ id: 'job1', prompt: 'a counter', ipHash: 'h', screenMs: 812.4, expiresAt: t + DAY, now: t })
    const steps: [string, number][] = [
      ['preparing', 100],
      ['coding', 400],
      ['checking', 40_400],
      ['coding', 46_400],
      ['checking', 58_400],
      ['publishing', 62_400],
      ['done', 90_000],
    ]
    for (const [status, after] of steps) store.addEvent('job1', 'status', status, t + after)
    store.addEvent('job1', 'note', 'The browser check found problems, asking the agent to fix them', t + 46_000)
    store.addToReceipt('job1', { model: 'claude-sonnet-5-5', tools: { Read: 3, Write: 5 }, files: { count: 4, bytes: 38_000 }, libs: ['chart.js', 'fonts/inter'], repair: 'browser', browser: 'clean' })
    store.setUsage('job1', { requests: 12, input: 2_000, output: 9_000, cacheRead: 30_000, cacheWrite: 7_000, costMicroUsd: 131_250.5 })

    expect(store.receipt('job1')).toEqual({
      seconds: { screening: 0.8, queued: 0.1, preparing: 0.3, coding: 52, checking: 10, publishing: 27.6, total: 90.8 },
      costUsd: 0.131251,
      tokens: { input: 2_000, output: 9_000, cacheRead: 30_000, cacheWrite: 7_000 },
      requests: 12,
      model: 'claude-sonnet-5-5',
      tools: { Read: 3, Write: 5 },
      files: { count: 4, bytes: 38_000 },
      libs: ['chart.js', 'fonts/inter'],
      repair: 'browser',
      browser: 'clean',
    })
    expect(store.costSince(0)).toBe(131_251)
    store.close()
  })

  it('is there for a job that has not reported anything yet, and missing for one that does not exist', () => {
    const store = new Store(':memory:')
    store.createJob({ id: 'job1', prompt: 'a counter', ipHash: 'h', expiresAt: Date.now() + DAY })
    expect(store.receipt('job1')).toMatchObject({ seconds: { screening: 0, total: 0 }, costUsd: 0, tokens: null, model: null, tools: {}, files: null, libs: [], repair: null })
    expect(store.receipt('nothing')).toBeNull()
    store.addToReceipt('nothing', { model: 'claude-sonnet-5-5' })
    expect(store.receipt('nothing')).toBeNull()
    store.close()
  })

  it('gives an owner the time and cost of the build that is published', () => {
    const store = new Store(':memory:')
    const t = Date.now()
    store.createJob({ id: 'app1', prompt: 'a counter', ipHash: 'h', userId: 'user-anna', screenMs: 1000, expiresAt: t + DAY, now: t })
    store.addEvent('app1', 'status', 'done', t + 60_000)
    store.setUsage('app1', { requests: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costMicroUsd: 120_000 })
    expect(store.appsOf('user-anna')[0]!.built).toBeNull()
    store.setCurrentJob('app1', 'app1')
    expect(store.appsOf('user-anna')[0]!.built).toEqual({ seconds: 61, costUsd: 0.12 })
    store.close()
  })
})
