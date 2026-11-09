import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.js'
import { DatabaseDown, gateway } from './gate.js'
import { AppGone, createPublisher } from './publish.js'
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

const loadLibs = async (dir: string) => {
  const libs = new Map<string, Buffer>()
  for (const name of await readdir(dir)) if (name.endsWith('.js')) libs.set(name, await readFile(join(dir, name)))
  return libs
}

// What a job has cost, as the key proxy counted it. The job's own token may
// have run out with its deadline, so the question is asked with a fresh one.
export const jobCost = async (cfg: Pick<Config, 'PROXY_URL' | 'PROXY_SIGNING_SECRET'>, jobId: string) => {
  const token = signJobToken(cfg.PROXY_SIGNING_SECRET, jobId, Math.ceil(Date.now() / 1000) + 30)
  const res = await fetch(`${cfg.PROXY_URL}/v1/usage`, { headers: { 'x-api-key': token }, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`the key proxy answered ${res.status}`)
  return Number(((await res.json()) as { costMicroUsd: unknown }).costMicroUsd) || 0
}

// The agent and the publisher can be swapped out, which is how the tests run
// the steps in between without a container or a remote repository.
export const createPipeline = (cfg: Config, apps: Pick<Store, 'getApp' | 'setCurrentJob' | 'setHasDb'>, run = runAgent, publish = createPublisher(cfg), gate = gateway(cfg)): Pipeline => {
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

      const agent = (problems?: string[]) => run(cfg, { jobId: job.id, request: job.prompt, edit, problems, token, gateToken, deadline, onFile: report.file })
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
        })
        return { ...checked, changes }
      }

      report.status('coding')
      await agent()

      report.status('checking')
      const { files, sources, changes } = await check().catch(async (error: unknown) => {
        if (!(error instanceof ValidationError)) throw error
        // One repair round: the checker's findings go back to the agent.
        report.note('The checker found problems, asking the agent to fix them')
        report.status('coding')
        await agent(error.problems)
        report.status('checking')
        return check()
      })

      // Only now, with the checker passed, does anything happen in the
      // database, and all of it at once. Tables are only ever added, so the
      // version that is online keeps working if publishing fails after this.
      if (changes.length) {
        await gate.commit(job.appId, changes)
        apps.setHasDb(job.appId)
      }

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
