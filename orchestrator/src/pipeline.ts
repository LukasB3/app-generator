import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Config } from './config.js'
import { DatabaseDown, gateway } from './gate.js'
import { AppGone, createPublisher } from './publish.js'
import { NOT_SEEN, openApp, type Seen } from './render.js'
import { AgentError, JobTimeout, killContainer, runAgent } from './sandbox.js'
import { saveSources, seedWorkspace } from './sources.js'
import type { Job, JobStatus, Store } from './store.js'
import { signJobToken } from './token.js'
import { ValidationError, validateWorkspace } from './validate.js'

export interface Reporter {
  status: (status: JobStatus) => void
  file: (path: string) => void
  note: (text: string) => void
  cost: (microUsd: number) => void
}

export type Pipeline = (job: Job, report: Reporter) => Promise<string>

// What a visitor is told when a job fails. Internal details stay in the log.
export const publicError = (error: unknown) => {
  if (error instanceof JobTimeout) return 'The build took too long and was stopped.'
  if (error instanceof ValidationError) return `The generated app did not pass the safety checks: ${error.problems.slice(0, 3).join('; ')}`
  if (error instanceof AgentError) return 'The coding agent declined or could not finish this request. Try describing a simple, harmless app.'
  if (error instanceof AppGone) return 'This app has been removed in the meantime, so it was not changed.'
  if (error instanceof DatabaseDown) return 'The database for apps is not available at the moment. Please try again in a few minutes.'
  return 'Something went wrong while building your app.'
}

// The bundled libraries by their path under lib/: scripts at the top, and
// folders of files that belong together, such as a font with its stylesheet
// and licence. What documents the folder itself (the README, build scripts)
// is not part of it.
export const loadLibs = async (dir: string) => {
  const libs = new Map<string, Buffer>()
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.') || entry.name === 'README.md' || entry.name.endsWith('.mjs')) continue
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/')
    libs.set(path, await readFile(join(dir, path)))
  }
  return libs
}

// What a job has used, as the key proxy counted it: requests, tokens of each
// kind and their price. The job's own token may have run out with its
// deadline, so the question is asked with a fresh one.
export const jobUsage = async (cfg: Pick<Config, 'PROXY_URL' | 'PROXY_SIGNING_SECRET'>, jobId: string) => {
  const token = signJobToken(cfg.PROXY_SIGNING_SECRET, jobId, Math.ceil(Date.now() / 1000) + 30)
  const res = await fetch(`${cfg.PROXY_URL}/v1/usage`, { headers: { 'x-api-key': token }, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`the key proxy answered ${res.status}`)
  const used = (await res.json()) as Record<string, unknown>
  const count = (name: string) => Number(used[name]) || 0
  return { requests: count('requests'), input: count('input'), output: count('output'), cacheRead: count('cacheRead'), cacheWrite: count('cacheWrite'), costMicroUsd: count('costMicroUsd') }
}
export const jobCost = async (cfg: Pick<Config, 'PROXY_URL' | 'PROXY_SIGNING_SECRET'>, jobId: string) => (await jobUsage(cfg, jobId)).costMicroUsd

// What the published picture of an app may weigh.
const PREVIEW_MAX_BYTES = 300_000

// The agent, the publisher and the browser can be swapped out, which is how the
// tests run the steps in between without a container or a remote repository.
export const createPipeline = (cfg: Config, apps: Pick<Store, 'getApp' | 'setCurrentJob' | 'setHasDb'>, run = runAgent, publish = createPublisher(cfg), gate = gateway(cfg), open = openApp): Pipeline => {
  return async (job, report) => {
    // A first build shares its id with its app. Any other job changes an app that exists.
    const edit = job.appId !== job.id
    const deadline = Date.now() + cfg.JOB_TIMEOUT_S * 1000
    const workspace = join(cfg.DATA_DIR, 'jobs', job.id)
    const token = signJobToken(cfg.PROXY_SIGNING_SECRET, job.id, Math.ceil(deadline / 1000))
    const gateToken = gate.token(job.appId, job.id, Math.ceil(deadline / 1000))
    try {
      report.status('preparing')
      // An app that has tables cannot be changed without knowing them. If the
      // database is down, this fails here, before anything is spent.
      const tables = apps.getApp(job.appId)?.hasDb ? await gate.tables(job.appId) : []
      const libs = await loadLibs(cfg.LIBS_DIR)
      await rm(workspace, { recursive: true, force: true })
      await mkdir(workspace, { recursive: true })
      await cp(cfg.LIBS_DIR, join(workspace, 'lib'), { recursive: true })
      // A change starts from the files that passed the checker last time. They get no trust for that: the whole app is checked again.
      if (edit && !(await seedWorkspace(cfg, job.appId, workspace))) throw new AppGone()

      // A line for the visitor, said once however often it happens.
      const said = new Set<string>()
      const once = (text: string) => void (said.has(text) || (said.add(text), report.note(text)))
      const agent = (problems?: string[]) =>
        run(cfg, { jobId: job.id, request: job.prompt, edit, problems, token, gateToken, deadline, onFile: report.file, onDatabaseWish: () => once('Database requested through an MCP tool') })
      const check = async () => {
        // The agent cannot touch the database. It can ask the gateway for
        // tables, and the gateway writes that down. A gateway that cannot be
        // asked means no tables: the agent had no tools then either.
        const changes = await gate.plan(job.id).catch((error: unknown) => {
          console.error(`what job ${job.id} asked of the database is unknown`, error)
          return []
        })
        const hasTables = tables.length > 0 || changes.some((change) => change.action === 'create_table')
        const checked = await validateWorkspace(workspace, {
          jobId: job.id,
          libs,
          badgeUrl: cfg.WEB_ORIGIN,
          extraSecrets: [token, gate.enabled ? gateToken : '', cfg.PROXY_SIGNING_SECRET, cfg.TURNSTILE_SECRET, cfg.IP_HASH_SECRET, cfg.GATE_SIGNING_SECRET ?? ''],
          database: hasTables ? gate.database(job.appId) : undefined,
          liveData: cfg.API_ORIGIN && `${cfg.API_ORIGIN}/api/data/`,
        })
        return { ...checked, changes }
      }
      // The browser check: the app, exactly as it would be published, opened in
      // a browser that is told the internet is the app's files and stand-ins
      // for its tables and for live data. It never fails a build.
      const look = async ({ files, sources, uses, changes }: Awaited<ReturnType<typeof check>>): Promise<Seen> => {
        if (cfg.BROWSER_CHECK === 'off') return NOT_SEEN
        const created = changes.filter((change) => change.action === 'create_table').map((change) => String(change.table))
        return open(cfg, {
          jobId: job.id,
          base: `${cfg.APPS_BASE_URL}/apps/${job.appId}/`,
          files,
          sources,
          database: uses.has('database') ? { url: gate.database(job.appId).url, prefix: gate.database(job.appId).prefix, tables: [...tables.map((table) => table.name), ...created] } : undefined,
          liveData: uses.has('liveData') && cfg.API_ORIGIN ? `${cfg.API_ORIGIN}/api/data/` : undefined,
        })
      }
      const attempt = async () => {
        const checked = await check()
        return { checked, seen: await look(checked) }
      }

      report.status('coding')
      await agent()

      report.status('checking')
      // The checker and the browser check share one repair round.
      let chosen = await attempt().catch((error: unknown) => {
        if (!(error instanceof ValidationError)) throw error
        return error.problems
      })
      if (Array.isArray(chosen)) {
        // The app broke a rule. The agent gets one try at it, and a second failure fails the build.
        report.note('The checker found problems, asking the agent to fix them')
        report.status('coding')
        await agent(chosen)
        report.status('checking')
        chosen = await attempt()
      } else if (chosen.seen.problems.length) {
        // The app may be published as it is. Whatever the repair does, that version stands unless the new one is better.
        report.note('The browser check found problems, asking the agent to fix them')
        report.status('coding')
        const first = chosen
        const setAside = (error: unknown) => {
          console.error(`job ${job.id}: the repair after the browser check did not work out, the first version stands`, error)
          return first
        }
        const repaired = await agent(first.seen.problems).then(
          () => true,
          (error: unknown) => (setAside(error), false),
        )
        report.status('checking')
        if (repaired) chosen = await attempt().then((second) => (second.seen.problems.length < first.seen.problems.length ? second : first), setAside)
      }
      if (chosen.seen.problems.length) {
        console.error(`job ${job.id}: published with browser findings: ${chosen.seen.problems.join(' | ')}`)
        report.note('The browser check still has findings; the app is published as it is')
      }
      if (cfg.BROWSER_CHECK !== 'off' && !chosen.seen.ran) report.note('The browser check could not run')
      const { sources, uses, changes } = chosen.checked
      // A picture of the page goes out with the app. The agent cannot have written a file of that name.
      const preview = chosen.seen.pictures.get('phone')
      const files = preview && preview.length <= PREVIEW_MAX_BYTES ? new Map(chosen.checked.files).set('preview.png', preview) : chosen.checked.files

      // Only now, with the checker passed, does anything happen in the
      // database, and all of it at once. Tables are only ever added, so the
      // version that is online keeps working if publishing fails after this.
      if (changes.length) {
        await gate.commit(job.appId, changes)
        apps.setHasDb(job.appId)
        report.note('Database set up after the check passed')
      }
      if (uses.has('liveData')) report.note('Live data allowed: weather and exchange rates')

      report.status('publishing')
      return await publish(job.appId, job.id, files, {
        isLive: () => (apps.getApp(job.appId)?.expiresAt ?? 0) > Date.now(),
        // From here on the repository holds this build, whether or not the page
        // shows up in time, so this is what a later change has to start from.
        // Only an app with an owner can be changed.
        pushed: async () => {
          if (!apps.getApp(job.appId)?.ownerId) return
          await saveSources(cfg, job.appId, sources)
          apps.setCurrentJob(job.appId, job.id)
        },
      })
    } finally {
      await killContainer(cfg, job.id)
      await rm(workspace, { recursive: true, force: true })
      await jobCost(cfg, job.id).then(report.cost, (error: unknown) => console.error(`cost of job ${job.id} is unknown`, error))
    }
  }
}
