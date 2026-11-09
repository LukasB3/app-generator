import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { AppGone, createAppCleanup, createPublisher, PublishError } from '../src/publish.js'

let dir: string
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example', ...args], { cwd, encoding: 'utf8' })

const config = (overrides: Record<string, string> = {}) =>
  loadConfig({
    DATA_DIR: join(dir, 'data'),
    APPS_REPO: `file://${join(dir, 'remote.git')}`,
    WEB_ORIGIN: 'https://app-generator.example',
    TURNSTILE_SECRET: 't',
    IP_HASH_SECRET: 'i'.repeat(32),
    PROXY_SIGNING_SECRET: 'p'.repeat(32),
    ...overrides,
  })

const published = () => git(dir, '-C', 'remote.git', 'ls-tree', '-r', '--name-only', 'main', 'apps/').trim().split('\n')
const lastCommit = () => git(dir, '-C', 'remote.git', 'log', '--format=%s', 'main').split('\n')[0]

// A bare repository stands in for GitHub; a seed clone fills it with three apps.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-publish-'))
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', 'remote.git')
  git(dir, 'clone', '--quiet', 'remote.git', 'seed')
  const seed = join(dir, 'seed')
  for (const id of ['keep1', 'old1', 'old2']) {
    mkdirSync(join(seed, 'apps', id), { recursive: true })
    writeFileSync(join(seed, 'apps', id, 'index.html'), `<p>${id}</p>`)
  }
  writeFileSync(join(seed, 'apps', '.gitkeep'), '')
  git(seed, 'add', '.')
  git(seed, 'commit', '--quiet', '-m', 'seed')
  git(seed, 'push', '--quiet', 'origin', 'HEAD:main')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('app cleanup', () => {
  it('removes every app not in the keep list and leaves the rest', async () => {
    const cleanup = createAppCleanup(config())
    expect((await cleanup(() => ['keep1', 'unknown'])).sort()).toEqual(['old1', 'old2'])
    expect(published()).toEqual(['apps/.gitkeep', 'apps/keep1/index.html'])
    expect(lastCommit()).toBe('remove 2 expired app(s)')

    expect(await cleanup(() => ['keep1'])).toEqual([])
  })

  it('reads the keep list only once it holds the working copy', async () => {
    const cleanup = createAppCleanup(config())
    let keep = ['keep1']
    const run = cleanup(() => keep)
    // What a publish does while the cleanup waits for its turn.
    keep = ['keep1', 'old1']
    expect(await run).toEqual(['old2'])
  })
})

describe('publishing', () => {
  it('writes the files to the folder of the app, whichever job built them', async () => {
    // No waiting for the page: there is no web server behind this repository.
    const publish = createPublisher(config({ PUBLISH_WAIT_S: '0' }))
    const files = new Map([
      ['index.html', Buffer.from('<p>second version</p>')],
      ['lib/qrcode.js', Buffer.from('// lib')],
    ])
    // The hook runs once the files are in the repository, even though the page then fails to show up.
    let remoteWhenPushed = ''
    const hooks = { isLive: () => true, pushed: async () => void (remoteWhenPushed = lastCommit()!) }
    await expect(publish('keep1', 'job2', files, hooks)).rejects.toThrow(PublishError)
    expect(remoteWhenPushed).toBe('publish app keep1')

    expect(published()).toContain('apps/keep1/lib/qrcode.js')
    expect(git(dir, '-C', 'remote.git', 'show', 'main:apps/keep1/index.html')).toBe('<p>second version</p>')
  })

  it('publishes nothing for an app that has ended while its change waited', async () => {
    const publish = createPublisher(config({ PUBLISH_WAIT_S: '0' }))
    let pushed = false
    const hooks = { isLive: () => false, pushed: async () => void (pushed = true) }
    await expect(publish('keep1', 'job2', new Map([['index.html', Buffer.from('<p>too late</p>')]]), hooks)).rejects.toThrow(AppGone)
    expect(pushed).toBe(false)
    expect(lastCommit()).toBe('seed')
    expect(git(dir, '-C', 'remote.git', 'show', 'main:apps/keep1/index.html')).toBe('<p>keep1</p>')
  })
})
