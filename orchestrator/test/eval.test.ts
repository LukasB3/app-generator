import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { runEval, type Case, type Row, type Tools } from '../src/eval.js'
import type { Change } from '../src/gate.js'
import type { Seen } from '../src/render.js'
import type { AgentRun } from '../src/sandbox.js'

const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}<script src="lib/chart.js"></script><script src="app.js"></script></body></html>`
const counter: Case = { id: 'counter', tags: ['tool'], prompt: 'a counter' }
const timer: Case = { id: 'timer', tags: ['tool'], prompt: 'a timer' }
const clean: Seen = { ran: true, problems: [], pictures: new Map([['phone', Buffer.from('phone picture')], ['desktop', Buffer.from('desktop picture')]]) }

let dir: string
let cfg: Config
let runs: AgentRun[]
let agent: (workspace: string, run: AgentRun) => void
let sees: Seen[]
let commits: Change[][]
let asked: Change[]
let logged: string[]
let ids: number
let tools: Tools
const rows = (variant = 'baseline') =>
  readFileSync(join(dir, 'evals', variant, 'results.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((text) => JSON.parse(text) as Row)
const errors = () =>
  readFileSync(join(dir, 'evals/baseline/errors.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((text) => JSON.parse(text) as { prompt_id: string; rep: number; error: string })
const evaluate = (plan: Partial<Parameters<typeof runEval>[3]> = {}) => runEval(cfg, tools, join(dir, 'evals'), { variant: 'baseline', cases: [counter], reps: 1, budgetUsd: 10, ...plan })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-eval-'))
  cfg = loadConfig({
    DATA_DIR: dir,
    LIBS_DIR: join(import.meta.dirname, '../../sandbox/libs'),
    WEB_ORIGIN: 'https://app-generator.example',
    TURNSTILE_SECRET: 'turnstile-secret',
    IP_HASH_SECRET: 'i'.repeat(32),
    PROXY_SIGNING_SECRET: 'p'.repeat(32),
    PROXY_URL: 'http://127.0.0.1:9',
    SANDBOX_LAUNCHER: '/bin/false',
  })
  runs = []
  sees = []
  commits = []
  asked = []
  logged = []
  ids = 0
  agent = (workspace) => {
    writeFileSync(join(workspace, 'index.html'), page('<h1>Counter</h1>'))
    writeFileSync(join(workspace, 'app.js'), 'let count = 0')
  }
  tools = {
    run: async (_cfg, job) => {
      runs.push(job)
      job.onModel?.('claude-sonnet-5-5')
      agent(join(dir, 'jobs', job.jobId), job)
    },
    open: async () => sees.shift() ?? clean,
    gate: {
      enabled: true,
      token: () => 'agd1.pass',
      database: (appId) => ({ url: 'https://project.example', key: 'public-key', prefix: `a${appId}_` }),
      tables: async () => [],
      plan: async () => asked,
      commit: async (_appId, changes) => void commits.push(changes),
      sweep: async () => [],
    },
    usage: async () => ({ requests: 9, input: 1200, output: 5400, cacheRead: 30_000, cacheWrite: 8000, costMicroUsd: 91_000 }),
    newId: () => `job${ids++}`,
    log: (text) => void logged.push(text),
  }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('the eval run', () => {
  it('builds a request with the real pipeline and writes down what happened', async () => {
    await evaluate()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ jobId: 'job0', request: 'a counter', edit: false })
    const [row] = rows()
    expect(row).toMatchObject({
      prompt_id: 'counter',
      rep: 0,
      prompt: 'a counter',
      tags: ['tool'],
      status: 'ok',
      grade: { built: 1, first_try: 1, clean: 1 },
      cost_usd: 0.091,
      usage: { input_tokens: 1200, output_tokens: 5400, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 8000 },
      requests: 9,
      model: 'claude-sonnet-5-5',
      findings: [],
      // The agent's own files: not the library and not the picture.
      files: 2,
      meta: { job: 'job0' },
    })
    expect(row!.failure).toBeUndefined()
    expect(Object.keys(row!.steps_s)).toEqual(['preparing', 'coding', 'checking', 'publishing'])
    const app = join(dir, 'evals/baseline/apps/counter_rep0')
    expect(readFileSync(join(app, 'index.html'), 'utf8')).toContain('Content-Security-Policy')
    expect(existsSync(join(app, 'lib/chart.js'))).toBe(true)
    expect(readFileSync(join(app, 'phone.png'), 'utf8')).toBe('phone picture')
    expect(readFileSync(join(app, 'desktop.png'), 'utf8')).toBe('desktop picture')
    expect(logged.at(-1)).toBe('1 builds: built 100%, first try 100%, clean 100%, $0.09')
  })

  it('publishes nothing and creates no table', async () => {
    asked = [{ action: 'create_table', table: 'entries', mode: 'append', columns: [] }]
    agent = (workspace) => {
      writeFileSync(join(workspace, 'index.html'), page('<script src="lib/db.js"></script>'))
      writeFileSync(join(workspace, 'app.js'), 'db.table("entries").list()')
    }
    await evaluate()
    expect(rows()[0]!.grade.built).toBe(1)
    expect(commits).toEqual([])
    expect(existsSync(join(dir, 'apps-repo'))).toBe(false)
    expect(existsSync(join(dir, 'sources'))).toBe(false)
  })

  it('does not build again what it has a result for, and builds the rest', async () => {
    await evaluate()
    await evaluate({ cases: [counter, timer], reps: 2 })
    expect(runs.map((run) => run.request)).toEqual(['a counter', 'a timer', 'a counter', 'a timer'])
    expect(rows().map((row) => `${row.prompt_id} ${row.rep}`)).toEqual(['counter 0', 'timer 0', 'counter 1', 'timer 1'])
  })

  it('counts the repair round, and findings that stay', async () => {
    sees = [
      { ran: true, problems: ['one', 'two'], pictures: new Map([['phone', Buffer.from('before the repair')]]) },
      { ran: true, problems: ['two'], pictures: new Map([['phone', Buffer.from('after the repair')]]) },
    ]
    await evaluate()
    expect(runs).toHaveLength(2)
    expect(rows()[0]).toMatchObject({ grade: { built: 1, first_try: 0, clean: 0 }, findings: ['two'] })
    expect(readFileSync(join(dir, 'evals/baseline/apps/counter_rep0/phone.png'), 'utf8')).toBe('after the repair')
    expect(rows()[0]!.notes).toEqual(['The browser check found problems, asking the agent to fix them', 'The browser check still has findings; the app is published as it is'])
  })

  it('keeps the pictures and findings of the first version when the repair is set aside', async () => {
    sees = [
      { ran: true, problems: ['one'], pictures: new Map([['phone', Buffer.from('before the repair')]]) },
      { ran: true, problems: ['one', 'two'], pictures: new Map([['phone', Buffer.from('after the repair')]]) },
    ]
    await evaluate()
    expect(rows()[0]).toMatchObject({ grade: { built: 1, first_try: 0, clean: 0 }, findings: ['one'] })
    expect(readFileSync(join(dir, 'evals/baseline/apps/counter_rep0/phone.png'), 'utf8')).toBe('before the repair')
  })

  it('counts a browser check that could not run as not clean', async () => {
    sees = [{ ran: false, problems: [], pictures: new Map() }]
    await evaluate()
    expect(rows()[0]!.grade).toEqual({ built: 1, first_try: 1, clean: 0 })
  })

  it('writes down an app that broke the rules twice as a result, with the reason', async () => {
    agent = (workspace) => {
      writeFileSync(join(workspace, 'index.html'), page('<script>alert(1)</script>'))
      writeFileSync(join(workspace, 'app.js'), 'let count = 0')
    }
    await evaluate()
    expect(rows()[0]).toMatchObject({ grade: { built: 0, first_try: 0, clean: 0 }, failure: 'rule', files: 0 })
    expect(rows()[0]!.meta.error).toContain('inline <script> is not allowed')
    expect(logged[0]).toContain('counter #0: no app (rule)')
  })

  it('keeps a build that never got a fair try out of the results, and tries it again next time', async () => {
    const usage = tools.usage
    tools.usage = async () => {
      throw new Error('the key proxy answered 502')
    }
    await evaluate()
    expect(existsSync(join(dir, 'evals/baseline/results.jsonl'))).toBe(false)
    expect(errors()).toMatchObject([{ prompt_id: 'counter', rep: 0, error: 'what the build used is unknown: the key proxy did not answer' }])
    tools.usage = usage
    await evaluate()
    expect(rows()).toHaveLength(1)
  })

  it('does not count a build that another model answered', async () => {
    await evaluate({ expectModel: 'claude-opus-5-5' })
    expect(existsSync(join(dir, 'evals/baseline/results.jsonl'))).toBe(false)
    expect(errors()[0]!.error).toBe('answered by claude-sonnet-5-5, not by claude-opus-5-5')
  })

  it('asks for what is on trial only when told to', async () => {
    await evaluate()
    expect(runs[0]!.trial).toBe(false)
    await evaluate({ variant: 'v1', trial: true })
    expect(runs[1]!.trial).toBe(true)
  })

  it('stops starting builds once the money for the run is spent', async () => {
    await evaluate({ cases: [counter, timer], reps: 3, budgetUsd: 0.15 })
    expect(runs).toHaveLength(2)
    expect(logged.at(-1)).toBe('stopped: $0.18 spent of $0.15')
  })

  it('keeps each variant in a folder of its own, under a name the report understands', async () => {
    await evaluate({ variant: 'v1' })
    expect(rows('v1')).toHaveLength(1)
    await expect(evaluate({ variant: 'new-prompt' })).rejects.toThrow('a variant is called')
  })
})
