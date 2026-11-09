// Node's built-in SQLite: no native dependency to compile on the server.
import { existsSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export const STEPS = ['queued', 'preparing', 'coding', 'checking', 'publishing', 'done'] as const
export type JobStatus = (typeof STEPS)[number] | 'failed'
export type EventType = 'status' | 'file' | 'note'

// An app is what gets published and expires. A job is one build of it.
export interface App {
  id: string
  createdAt: number
  expiresAt: number
}

export interface Job {
  id: string
  appId: string
  prompt: string
  status: JobStatus
  ipHash: string
  createdAt: number
  url: string | null
  error: string | null
}

export interface JobEvent {
  seq: number
  ts: number
  type: EventType
  data: string
}

const ACTIVE = `('preparing','coding','checking','publishing')`
const JOB_COLUMNS = 'id, appId, prompt, status, ipHash, createdAt, url, error'
const DAY = 24 * 3_600_000

// Each step moves the schema one version forward, and PRAGMA user_version
// records how far a file has come. A step is never edited once it is deployed.
const MIGRATIONS = [
  // 1: the schema from before versions were counted, so an existing file passes through unchanged.
  `CREATE TABLE IF NOT EXISTS jobs (
     n INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     prompt TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'queued',
     ipHash TEXT NOT NULL,
     createdAt INTEGER NOT NULL,
     url TEXT,
     error TEXT
   );
   CREATE INDEX IF NOT EXISTS jobs_created ON jobs (createdAt, ipHash);
   CREATE TABLE IF NOT EXISTS events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     jobId TEXT NOT NULL,
     ts INTEGER NOT NULL,
     type TEXT NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS events_job ON events (jobId, seq);`,
  // 2: apps get their own records. The ones that exist keep the 30 days they were promised.
  `ALTER TABLE jobs ADD COLUMN appId TEXT NOT NULL DEFAULT '';
   UPDATE jobs SET appId = id;
   CREATE TABLE apps (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
   INSERT INTO apps (id, createdAt, expiresAt) SELECT id, createdAt, createdAt + ${30 * DAY} FROM jobs WHERE status != 'failed';`,
  // 3: what each job cost, as the key proxy counted it, for the budgets.
  `ALTER TABLE jobs ADD COLUMN costMicroUsd INTEGER NOT NULL DEFAULT 0;`,
]

export class Store {
  private db: DatabaseSync
  private backup?: string

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    if (path !== ':memory:') this.backup = `${path}.bak`
    this.migrate()
  }

  private migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version >= MIGRATIONS.length) return
    // A copy of the records as they were, in case a step turns out to be wrong.
    if (this.backup && this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'jobs'`).get()) {
      rmSync(this.backup, { force: true })
      this.db.prepare('VACUUM INTO ?').run(this.backup)
    }
    for (const [index, step] of MIGRATIONS.entries()) {
      if (index < version) continue
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`${step} PRAGMA user_version = ${index + 1}; COMMIT`)
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  // A new job starts a new app under the same id.
  createJob(id: string, prompt: string, ipHash: string, expiresAt: number, now = Date.now()) {
    this.db.prepare('INSERT INTO apps (id, createdAt, expiresAt) VALUES (?, ?, ?)').run(id, now, expiresAt)
    this.db.prepare('INSERT INTO jobs (id, appId, prompt, ipHash, createdAt) VALUES (?, ?, ?, ?, ?)').run(id, id, prompt, ipHash, now)
    this.addEvent(id, 'status', 'queued', now)
  }

  getJob(id: string) {
    return this.db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id) as unknown as Job | undefined
  }

  getApp(id: string) {
    return this.db.prepare('SELECT id, createdAt, expiresAt FROM apps WHERE id = ?').get(id) as unknown as App | undefined
  }

  nextQueued() {
    return this.db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE status = 'queued' ORDER BY n LIMIT 1`).get() as unknown as Job | undefined
  }

  // 0 once the job is being worked on; otherwise its 1-based place among queued jobs.
  position(id: string) {
    const row = this.db
      .prepare(`SELECT count(*) AS c FROM jobs WHERE status = 'queued' AND n <= (SELECT n FROM jobs WHERE id = ? AND status = 'queued')`)
      .get(id) as { c: number }
    return row.c
  }

  queuedCount() {
    return (this.db.prepare(`SELECT count(*) AS c FROM jobs WHERE status = 'queued'`).get() as { c: number }).c
  }

  countSince(since: number, ipHash?: string) {
    const row = ipHash
      ? this.db.prepare('SELECT count(*) AS c FROM jobs WHERE createdAt >= ? AND ipHash = ?').get(since, ipHash)
      : this.db.prepare('SELECT count(*) AS c FROM jobs WHERE createdAt >= ?').get(since)
    return (row as { c: number }).c
  }

  setCost(id: string, microUsd: number) {
    this.db.prepare('UPDATE jobs SET costMicroUsd = ? WHERE id = ?').run(Math.ceil(microUsd), id)
  }

  // Micro-USD spent by jobs created since then, by everyone or by one visitor.
  costSince(since: number, ipHash?: string) {
    const row = ipHash
      ? this.db.prepare('SELECT coalesce(sum(costMicroUsd), 0) AS c FROM jobs WHERE createdAt >= ? AND ipHash = ?').get(since, ipHash)
      : this.db.prepare('SELECT coalesce(sum(costMicroUsd), 0) AS c FROM jobs WHERE createdAt >= ?').get(since)
    return (row as { c: number }).c
  }

  setStatus(id: string, status: JobStatus, result: { url?: string; error?: string } = {}) {
    this.db.prepare('UPDATE jobs SET status = ?, url = coalesce(?, url), error = coalesce(?, error) WHERE id = ?').run(status, result.url ?? null, result.error ?? null, id)
    // Only a first build shares its id with an app. If it fails there is no app to keep.
    if (status === 'failed') this.db.prepare('UPDATE apps SET expiresAt = min(expiresAt, ?) WHERE id = ?').run(Date.now(), id)
    return this.addEvent(id, 'status', status)
  }

  addEvent(jobId: string, type: EventType, data: string, ts = Date.now()): JobEvent {
    const { lastInsertRowid } = this.db.prepare('INSERT INTO events (jobId, ts, type, data) VALUES (?, ?, ?, ?)').run(jobId, ts, type, data)
    return { seq: Number(lastInsertRowid), ts, type, data }
  }

  events(jobId: string, afterSeq = 0) {
    return this.db.prepare('SELECT seq, ts, type, data FROM events WHERE jobId = ? AND seq > ? ORDER BY seq').all(jobId, afterSeq) as unknown as JobEvent[]
  }

  // A restart kills the running container, so whatever was in flight cannot finish.
  failInterrupted(message: string) {
    const ids = (this.db.prepare(`SELECT id FROM jobs WHERE status IN ${ACTIVE}`).all() as { id: string }[]).map((row) => row.id)
    for (const id of ids) this.setStatus(id, 'failed', { error: message })
    return ids
  }

  liveAppIds(now = Date.now()) {
    return (this.db.prepare('SELECT id FROM apps WHERE expiresAt > ?').all(now) as { id: string }[]).map((row) => row.id)
  }

  // Prompts and visitor hashes are not kept longer than needed for limits and
  // debugging. That includes the copy made before a schema change.
  purgeOlderThan(cutoff: number) {
    this.db.prepare('DELETE FROM events WHERE jobId IN (SELECT id FROM jobs WHERE createdAt < ?)').run(cutoff)
    this.db.prepare('DELETE FROM apps WHERE expiresAt < ?').run(cutoff)
    if (this.backup && existsSync(this.backup) && statSync(this.backup).mtimeMs < cutoff) rmSync(this.backup)
    return Number(this.db.prepare('DELETE FROM jobs WHERE createdAt < ?').run(cutoff).changes)
  }

  close() {
    this.db.close()
  }
}
