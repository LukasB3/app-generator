import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Config } from './config.js'

const run = promisify(execFile)

export class PublishError extends Error {}

// Publishing and cleanup share one working copy, so they take turns.
let turn: Promise<unknown> = Promise.resolve()
const withRepo = <T>(work: () => Promise<T>) => {
  const result = turn.then(work)
  turn = result.catch(() => {})
  return result
}

// All git work happens here, in orchestrator code, with a deploy key that is
// valid for the apps repository only. The agent never sees git or the key.
const appsRepo = (cfg: Config) => {
  const repoDir = join(cfg.DATA_DIR, 'apps-repo')
  const git = (...args: string[]) =>
    run('git', ['-C', repoDir, ...args], {
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        HOME: cfg.DATA_DIR,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: `ssh -i ${cfg.DEPLOY_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${cfg.KNOWN_HOSTS_PATH}`,
      },
    })

  const sync = async () => {
    if (!existsSync(join(repoDir, '.git'))) {
      await mkdir(repoDir, { recursive: true })
      await git('init', '--initial-branch=main')
      await git('remote', 'add', 'origin', cfg.APPS_REPO)
      await git('config', 'user.name', 'app-generator')
      await git('config', 'user.email', 'apps@app-generator.lukasbossert.com')
    }
    await git('fetch', '--depth=1', 'origin', 'main')
    await git('reset', '--hard', 'origin/main')
    await git('clean', '-fdx')
  }

  return { repoDir, git, sync }
}

export const createPublisher = (cfg: Config) => {
  const { repoDir, git, sync } = appsRepo(cfg)

  const waitUntilLive = async (jobId: string, url: string) => {
    const deadline = Date.now() + cfg.PUBLISH_WAIT_S * 1000
    while (Date.now() < deadline) {
      const res = await fetch(`${url}?t=${Date.now()}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => null)
      if (res?.ok && (await res.text()).includes(`content="${jobId}"`)) return
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
    throw new PublishError('published, but the page did not come online in time')
  }

  return async (jobId: string, files: Map<string, Buffer>) => {
    const url = `${cfg.APPS_BASE_URL}/apps/${jobId}/`
    await withRepo(async () => {
      await sync()
      const appDir = join(repoDir, 'apps', jobId)
      await rm(appDir, { recursive: true, force: true })
      for (const [path, bytes] of files) {
        await mkdir(dirname(join(appDir, path)), { recursive: true })
        await writeFile(join(appDir, path), bytes)
      }
      await git('add', '--', `apps/${jobId}`)
      await git('commit', '--quiet', '-m', `publish app ${jobId}`)
      await git('push', '--quiet', 'origin', 'HEAD:main')
    })
    await waitUntilLive(jobId, url)
    return url
  }
}

// Removes every published app whose job is not in the keep list: apps past
// retention, and orphans whose records are already gone. Returns the removed ids.
export const createAppCleanup = (cfg: Config) => {
  const { repoDir, git, sync } = appsRepo(cfg)

  return (keepIds: Iterable<string>) =>
    withRepo(async () => {
      await sync()
      const keep = new Set(keepIds)
      const entries = await readdir(join(repoDir, 'apps'), { withFileTypes: true }).catch(() => [])
      const stale = entries.filter((entry) => entry.isDirectory() && !keep.has(entry.name)).map((entry) => entry.name)
      if (stale.length === 0) return stale
      await git('rm', '-rq', '--', ...stale.map((id) => `apps/${id}`))
      await git('commit', '--quiet', '-m', `remove ${stale.length} expired app(s)`)
      await git('push', '--quiet', 'origin', 'HEAD:main')
      return stale
    })
}
