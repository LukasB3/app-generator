import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { noAuth, supabaseAuth } from './auth.js'
import { loadConfig } from './config.js'
import { sweepTables } from './gate.js'
import { createPipeline } from './pipeline.js'
import { createAppCleanup } from './publish.js'
import { killContainer } from './sandbox.js'
import { promptScreen } from './screen.js'
import { removeSourcesExcept } from './sources.js'
import { buildServer } from './server.js'
import { Store } from './store.js'
import { turnstile } from './turnstile.js'
import { Worker } from './worker.js'

const cfg = loadConfig()
const jobsDir = join(cfg.DATA_DIR, 'jobs')
mkdirSync(jobsDir, { recursive: true })

const store = new Store(join(cfg.DATA_DIR, 'jobs.sqlite'))

// Nothing is being built when the service starts. Jobs that were in flight are
// marked as failed, their containers stopped and every leftover workspace removed.
const interrupted = store.failInterrupted('The server restarted while this app was being built. Please submit it again.')
await Promise.all(interrupted.map((id) => killContainer(cfg, id)))
for (const name of readdirSync(jobsDir)) rmSync(join(jobsDir, name), { recursive: true, force: true })

// A published app is removed when it expires, and with it the files kept for
// changing it and its tables in the database. Job records, with the prompt
// and the visitor hash, are kept for 30 days for the limits and for debugging.
const RETENTION_MS = 30 * 24 * 3_600_000
const removeExpiredApps = createAppCleanup(cfg)
// A free Supabase project is paused after a week without database activity,
// and logins would stop with it. Reading one row counts as activity.
const touchSupabase = async () => {
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) return
  const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/heartbeat?select=id`, { headers: { apikey: cfg.SUPABASE_KEY, 'accept-profile': 'apps' }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`Supabase answered ${res.status}`)
}

const purge = async () => {
  await removeExpiredApps(() => store.liveAppIds()).catch((error: unknown) => console.error('app cleanup failed', error))
  await removeSourcesExcept(cfg, store.liveAppIds()).catch((error: unknown) => console.error('removing stored sources failed', error))
  await sweepTables(cfg, store.liveAppIds()).catch((error: unknown) => console.error('removing database tables failed', error))
  store.purgeOlderThan(Date.now() - RETENTION_MS)
  await touchSupabase().catch((error: unknown) => console.error('Supabase keep-alive failed', error))
}
void purge()
setInterval(() => void purge(), 3_600_000).unref()

const worker = new Worker(store, createPipeline(cfg, store))
const auth = cfg.SUPABASE_URL ? supabaseAuth(cfg.SUPABASE_URL) : noAuth
const app = await buildServer({ cfg, store, worker, captcha: turnstile(cfg.TURNSTILE_SECRET), screen: promptScreen(cfg), auth })

await app.listen({ host: cfg.HOST, port: cfg.PORT })
worker.kick()

process.on('SIGTERM', () => void app.close().then(() => process.exit(0)))
