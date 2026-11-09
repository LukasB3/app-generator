import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.js'
import { createPublisher } from './publish.js'
import { AgentError, JobTimeout, killContainer, runAgent } from './sandbox.js'
import type { Job, JobStatus } from './store.js'
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

export const createPipeline = (cfg: Config): Pipeline => {
  const publish = createPublisher(cfg)

  return async (job, report) => {
    const deadline = Date.now() + cfg.JOB_TIMEOUT_S * 1000
    const workspace = join(cfg.DATA_DIR, 'jobs', job.id)
    const token = signJobToken(cfg.PROXY_SIGNING_SECRET, job.id, Math.ceil(deadline / 1000))
    try {
      report.status('preparing')
      const libs = await loadLibs(cfg.LIBS_DIR)
      await rm(workspace, { recursive: true, force: true })
      await mkdir(workspace, { recursive: true })
      await cp(cfg.LIBS_DIR, join(workspace, 'lib'), { recursive: true })

      const agent = (problems?: string[]) => runAgent(cfg, { jobId: job.id, request: job.prompt, problems, token, deadline, onFile: report.file })
      const check = () =>
        validateWorkspace(workspace, {
          jobId: job.id,
          libs,
          badgeUrl: cfg.WEB_ORIGIN,
          extraSecrets: [token, cfg.PROXY_SIGNING_SECRET, cfg.TURNSTILE_SECRET, cfg.IP_HASH_SECRET],
        })

      report.status('coding')
      await agent()

      report.status('checking')
      const files = await check().catch(async (error: unknown) => {
        if (!(error instanceof ValidationError)) throw error
        // One repair round: the checker's findings go back to the agent.
        report.note('The checker found problems, asking the agent to fix them')
        report.status('coding')
        await agent(error.problems)
        report.status('checking')
        return check()
      })

      report.status('publishing')
      return await publish(job.appId, job.id, files)
    } finally {
      await killContainer(cfg, job.id)
      await rm(workspace, { recursive: true, force: true })
      await jobCost(cfg, job.id).then(report.cost, (error: unknown) => console.error(`cost of job ${job.id} is unknown`, error))
    }
  }
}
