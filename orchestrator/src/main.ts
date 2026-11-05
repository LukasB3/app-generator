import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { createPipeline } from './pipeline.js'
import { createAppCleanup } from './publish.js'
import { promptScreen } from './screen.js'
import { buildServer } from './server.js'
import { Store } from './store.js'
import { turnstile } from './turnstile.js'
import { Worker } from './worker.js'

const cfg = loadConfig()
mkdirSync(join(cfg.DATA_DIR, 'jobs'), { recursive: true })

const store = new Store(join(cfg.DATA_DIR, 'jobs.sqlite'))
store.failInterrupted('The server restarted while this app was being built. Please submit it again.')

// Apps and job records both live for 30 days. The app goes first, so a job
// whose record is gone never leaves its page behind.
const RETENTION_MS = 30 * 24 * 3_600_000
const removeExpiredApps = createAppCleanup(cfg)
const purge = async () => {
  const cutoff = Date.now() - RETENTION_MS
  await removeExpiredApps(store.idsCreatedSince(cutoff)).catch((error: unknown) => console.error('app cleanup failed', error))
  store.purgeOlderThan(cutoff)
}
void purge()
setInterval(() => void purge(), 24 * 3_600_000).unref()

const worker = new Worker(store, createPipeline(cfg))
const app = await buildServer({ cfg, store, worker, captcha: turnstile(cfg.TURNSTILE_SECRET), screen: promptScreen(cfg) })

await app.listen({ host: cfg.HOST, port: cfg.PORT })
worker.kick()

process.on('SIGTERM', () => void app.close().then(() => process.exit(0)))
