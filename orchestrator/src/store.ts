// Node's built-in SQLite: no native dependency to compile on the server.
import { existsSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { buildReceipt, type Receipt, type Stored, type Usage } from './receipt.js'

export const STEPS = ['queued', 'preparing', 'coding', 'checking', 'publishing', 'done'] as const
export type JobStatus = (typeof STEPS)[number] | 'failed'
export type EventType = 'status' | 'file' | 'note'

// An app is what gets published and expires. A job is one build of it.
export interface App {
  id: string
  ownerId: string | null
  // The job whose build is published and whose files a change would start from. Empty for an app that cannot be changed.
  currentJobId: string | null
  // 1 once the app has tables in the database, 0 before.
  hasDb: number
  createdAt: number
  expiresAt: number
}

// An app as its owner sees it in their list: the request it was first built
// from, where it is published, and the state of the latest job on it.
export interface OwnedApp {
  id: string
  prompt: string
  url: string | null
  currentJobId: string | null
  latestJobId: string
  status: JobStatus
  createdAt: number
  expiresAt: number
  // How long the published build took and what it cost, if it has a receipt.
  built: { seconds: number; costUsd: number } | null
}

// An app on the website's start page: what its card shows, as it was when it
// was pinned. Kept apart from the job records, which go after 30 days.
export interface Pinned {
  appId: string
  // The build that is published, and whose picture the card shows.
  jobId: string
  position: number
  title: string
  prompt: string
  receipt: Receipt
  pinnedAt: number
}
export const MAX_PINNED = 6
export const MAX_TITLE = 40
export class PinError extends Error {}

// One visitor, known by address or by account.
export type Who = { ipHash: string } | { userId: string }

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
  // 4: accounts. Both stay empty for visitors who are not logged in.
  `ALTER TABLE jobs ADD COLUMN userId TEXT;
   ALTER TABLE apps ADD COLUMN ownerId TEXT;`,
  // 5: changing an app. Apps built before this step have no stored files, so theirs stays empty.
  `ALTER TABLE apps ADD COLUMN currentJobId TEXT;`,
  // 6: apps with tables in the database. Such an app cannot be changed without the database.
  `ALTER TABLE apps ADD COLUMN hasDb INTEGER NOT NULL DEFAULT 0;`,
  // 7: the receipt of a build, as JSON. Jobs from before this step have none.
  `ALTER TABLE jobs ADD COLUMN receipt TEXT;`,
  // 8: the apps on the start page. They stay online, with their files and tables, until they are taken off.
  `CREATE TABLE showcase (
     appId TEXT PRIMARY KEY,
     jobId TEXT NOT NULL,
     position INTEGER NOT NULL,
     title TEXT NOT NULL,
     prompt TEXT NOT NULL,
     receipt TEXT NOT NULL,
     pinnedAt INTEGER NOT NULL
   );`,
]

export class Store {
  private db: DatabaseSync
  private backup?: string

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    // A command run next to the service may find the file busy for a moment.
    this.db.exec('PRAGMA busy_timeout = 5000')
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

  // A job either starts a new app, which gets the job's id, an owner if someone
  // is logged in, and an end, or it changes the app named in `appId`.
  // `screenMs` is how long the prompt screen took before the job was made.
  createJob({
    id,
    prompt,
    ipHash,
    userId = null,
    screenMs,
    now = Date.now(),
    ...app
  }: { id: string; prompt: string; ipHash: string; userId?: string | null; screenMs?: number; now?: number } & ({ expiresAt: number } | { appId: string })) {
    if ('expiresAt' in app) this.db.prepare('INSERT INTO apps (id, ownerId, createdAt, expiresAt) VALUES (?, ?, ?, ?)').run(id, userId, now, app.expiresAt)
    this.db
      .prepare('INSERT INTO jobs (id, appId, prompt, ipHash, userId, createdAt, receipt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'appId' in app ? app.appId : id, prompt, ipHash, userId, now, JSON.stringify(screenMs === undefined ? {} : { screenMs: Math.round(screenMs) }))
    this.addEvent(id, 'status', 'queued', now)
  }

  getJob(id: string) {
    return this.db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id) as unknown as Job | undefined
  }

  getApp(id: string) {
    return this.db.prepare('SELECT id, ownerId, currentJobId, hasDb, createdAt, expiresAt FROM apps WHERE id = ?').get(id) as unknown as App | undefined
  }

  setCurrentJob(appId: string, jobId: string) {
    this.db.prepare('UPDATE apps SET currentJobId = ? WHERE id = ?').run(jobId, appId)
  }

  setHasDb(appId: string) {
    this.db.prepare('UPDATE apps SET hasDb = 1 WHERE id = ?').run(appId)
  }

  // Whether a job on this app is still waiting or running.
  hasOpenJob(appId: string) {
    return this.db.prepare(`SELECT 1 FROM jobs WHERE appId = ? AND status NOT IN ('done', 'failed') LIMIT 1`).get(appId) !== undefined
  }

  // The live apps of one account, newest first.
  appsOf(ownerId: string, now = Date.now()): OwnedApp[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, first.prompt, a.currentJobId, latest.id AS latestJobId, latest.status, a.createdAt, a.expiresAt,
                (SELECT url FROM jobs WHERE appId = a.id AND url IS NOT NULL ORDER BY n DESC LIMIT 1) AS url
         FROM apps a
         JOIN jobs first ON first.id = a.id
         JOIN jobs latest ON latest.n = (SELECT max(n) FROM jobs WHERE appId = a.id)
         WHERE a.ownerId = ? AND a.expiresAt > ?
         ORDER BY a.createdAt DESC`,
      )
      .all(ownerId, now) as unknown as Omit<OwnedApp, 'built'>[]
    return rows.map((row) => {
      const receipt = row.currentJobId ? this.receipt(row.currentJobId) : null
      return { ...row, built: receipt && { seconds: receipt.seconds.total, costUsd: receipt.costUsd } }
    })
  }

  // The oldest job that waits, leaving out those a worker has already taken.
  nextQueued(taken: Iterable<string> = []) {
    const ids = [...taken]
    return this.db
      .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE status = 'queued' AND id NOT IN (${ids.map(() => '?').join(', ')}) ORDER BY n LIMIT 1`)
      .get(...ids) as unknown as Job | undefined
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

  // A figure over the jobs created since then: everyone's, or one visitor's.
  private total(figure: string, since: number, who?: Who) {
    const row = !who
      ? this.db.prepare(`SELECT ${figure} AS c FROM jobs WHERE createdAt >= ?`).get(since)
      : 'userId' in who
        ? this.db.prepare(`SELECT ${figure} AS c FROM jobs WHERE createdAt >= ? AND userId = ?`).get(since, who.userId)
        : this.db.prepare(`SELECT ${figure} AS c FROM jobs WHERE createdAt >= ? AND ipHash = ?`).get(since, who.ipHash)
    return (row as { c: number }).c
  }

  countSince(since: number, who?: Who) {
    return this.total('count(*)', since, who)
  }

  // In micro-USD.
  costSince(since: number, who?: Who) {
    return this.total('coalesce(sum(costMicroUsd), 0)', since, who)
  }

  setCost(id: string, microUsd: number) {
    this.db.prepare('UPDATE jobs SET costMicroUsd = ? WHERE id = ?').run(Math.ceil(microUsd), id)
  }

  // What the key proxy counted for a job: the cost for the budgets, the tokens for its receipt.
  setUsage(id: string, { costMicroUsd, ...usage }: Usage) {
    this.setCost(id, costMicroUsd)
    this.addToReceipt(id, { usage })
  }

  addToReceipt(id: string, part: Stored) {
    const row = this.db.prepare('SELECT receipt FROM jobs WHERE id = ?').get(id) as { receipt: string | null } | undefined
    if (!row) return
    this.db.prepare('UPDATE jobs SET receipt = ? WHERE id = ?').run(JSON.stringify({ ...(row.receipt ? JSON.parse(row.receipt) : {}), ...part }), id)
  }

  // The receipt of a job, or null for one from before receipts were kept.
  receipt(id: string): Receipt | null {
    const row = this.db.prepare('SELECT receipt, costMicroUsd FROM jobs WHERE id = ?').get(id) as { receipt: string | null; costMicroUsd: number } | undefined
    if (!row?.receipt) return null
    const statuses = this.db.prepare(`SELECT ts, data FROM events WHERE jobId = ? AND type = 'status' ORDER BY seq`).all(id) as { ts: number; data: string }[]
    return buildReceipt(JSON.parse(row.receipt) as Stored, row.costMicroUsd, statuses)
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

  // The apps whose pages, files and tables are kept: those that have not
  // expired, and those on the start page whatever their end.
  liveAppIds(now = Date.now()) {
    return (this.db.prepare('SELECT id FROM apps WHERE expiresAt > ? UNION SELECT appId FROM showcase').all(now) as { id: string }[]).map((row) => row.id)
  }

  // Puts a published app on the start page, or brings its card up to date.
  // Only a build with a receipt can be pinned: the card shows its figures.
  pin({ appId, title, position }: { appId: string; title: string; position?: number }, now = Date.now()) {
    const name = title.replace(/\s+/g, ' ').trim()
    if (!name || name.length > MAX_TITLE) throw new PinError(`A title has 1 to ${MAX_TITLE} characters.`)
    const app = this.getApp(appId)
    const pinned = this.isPinned(appId)
    if (!app || (app.expiresAt <= now && !pinned)) throw new PinError('There is no live app with this id.')
    const first = this.getJob(appId)
    if (!first) throw new PinError('The request this app was built from is no longer on record.')
    const published = this.db.prepare(`SELECT id FROM jobs WHERE appId = ? AND status = 'done' AND url IS NOT NULL ORDER BY n DESC LIMIT 1`).get(appId) as { id: string } | undefined
    const receipt = published && this.receipt(published.id)
    if (!published || !receipt) throw new PinError('The published build of this app has no receipt: it was built before receipts were kept.')
    const count = (this.db.prepare('SELECT count(*) AS c FROM showcase').get() as { c: number }).c
    if (!pinned && count >= MAX_PINNED) throw new PinError(`At most ${MAX_PINNED} apps can be on the start page. Take one off first.`)
    const last = (this.db.prepare('SELECT coalesce(max(position), 0) AS p FROM showcase WHERE appId != ?').get(appId) as { p: number }).p
    const place = position ?? (this.db.prepare('SELECT position FROM showcase WHERE appId = ?').get(appId) as { position: number } | undefined)?.position ?? last + 1
    this.db
      .prepare('INSERT OR REPLACE INTO showcase (appId, jobId, position, title, prompt, receipt, pinnedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(appId, published.id, place, name, first.prompt, JSON.stringify(receipt), now)
    return this.showcase().find((each) => each.appId === appId)!
  }

  unpin(appId: string) {
    return this.db.prepare('DELETE FROM showcase WHERE appId = ?').run(appId).changes > 0
  }

  isPinned(appId: string) {
    return this.db.prepare('SELECT 1 FROM showcase WHERE appId = ?').get(appId) !== undefined
  }

  // The cards on the start page, in their order.
  showcase(): Pinned[] {
    const rows = this.db.prepare('SELECT appId, jobId, position, title, prompt, receipt, pinnedAt FROM showcase ORDER BY position, pinnedAt').all() as unknown as (Omit<Pinned, 'receipt'> & { receipt: string })[]
    return rows.map((row) => ({ ...row, receipt: JSON.parse(row.receipt) as Receipt }))
  }

  // The apps on the start page that have tables, which are emptied once a day.
  pinnedWithTables() {
    return (this.db.prepare('SELECT s.appId AS id FROM showcase s JOIN apps a ON a.id = s.appId WHERE a.hasDb = 1 ORDER BY s.position').all() as { id: string }[]).map((row) => row.id)
  }

  // Prompts and visitor hashes are not kept longer than needed for limits and
  // debugging. That includes the copy made before a schema change.
  purgeOlderThan(cutoff: number) {
    this.db.prepare('DELETE FROM events WHERE jobId IN (SELECT id FROM jobs WHERE createdAt < ?)').run(cutoff)
    this.db.prepare('DELETE FROM apps WHERE expiresAt < ? AND id NOT IN (SELECT appId FROM showcase)').run(cutoff)
    if (this.backup && existsSync(this.backup) && statSync(this.backup).mtimeMs < cutoff) rmSync(this.backup)
    return Number(this.db.prepare('DELETE FROM jobs WHERE createdAt < ?').run(cutoff).changes)
  }

  close() {
    this.db.close()
  }
}
