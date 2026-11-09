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
    expect(store.getApp('done1')).toEqual({ id: 'done1', ownerId: null, createdAt: created, expiresAt: created + 30 * DAY })
    expect(store.getApp('failed1')).toBeUndefined()
    expect(store.liveAppIds().sort()).toEqual(['done1', 'queued1'])
    expect(store.nextQueued()).toMatchObject({ id: 'queued1', appId: 'queued1' })

    store.createJob({ id: 'fresh1', prompt: 'a new request', ipHash: 'h', expiresAt: Date.now() + DAY })
    expect(store.getJob('fresh1')!.appId).toBe('fresh1')
    expect(store.costSince(0)).toBe(0)
    store.close()
    expect(version()).toBe(4)
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
    expect(version()).toBe(4)
    expect(existsSync(`${path}.bak`)).toBe(false)

    const store = new Store(path)
    store.createJob({ id: 'fresh1', prompt: 'a new request', ipHash: 'h', expiresAt: Date.now() + DAY })
    store.close()
    new Store(path).close()
    expect(existsSync(`${path}.bak`)).toBe(false)
  })
})
