import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signGateToken, signJobToken } from '../src/token.js'

// Exercises the real launcher script with a stand-in for the docker binary.
const LAUNCHER = join(import.meta.dirname, '../../infra/ag-sandbox')
const SECRET = 's'.repeat(32)
const ID = 'abcdefghij234567abcd'
const OTHER = 'zzzzzzzzzzzzzzzzzzzz'
const token = (id = ID) => signJobToken(SECRET, id, 2_000_000_000)
const APP = 'appappappappappappap'
const gate = (id = ID, app = APP) => signGateToken(SECRET, app, id, 2_000_000_000)

let dir: string
const out = (name: string) => readFileSync(join(dir, name), 'utf8')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-launcher-'))
  mkdirSync(join(dir, 'jobs', ID), { recursive: true })
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\nprintf '%s' "$ANTHROPIC_API_KEY" > "${dir}/key"\nprintf '%s' "$AG_DB_TOKEN" > "${dir}/dbkey"\ncat > "${dir}/stdin"\n`)
  chmodSync(join(dir, 'docker'), 0o755)
  writeFileSync(
    join(dir, 'sandbox.conf'),
    `IMAGE=ag-sandbox:latest\nNETWORK=ag-sandbox\nRUNTIME=runc\nMEMORY=1g\nCPUS=1.5\nPIDS=256\nPROXY_URL=http://ag-proxy:8080\nMODEL=claude-sonnet-5-5\nJOBS_DIR=${dir}/jobs\nRUN_AS=${userInfo().username}\n`,
  )
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const launch = (args: string[], input = '') =>
  spawnSync(LAUNCHER, args, { input, encoding: 'utf8', env: { PATH: process.env.PATH, PG_DOCKER: join(dir, 'docker'), PG_SANDBOX_CONF: join(dir, 'sandbox.conf') } })

describe('ag-sandbox run', () => {
  it('starts a locked-down container and keeps the tokens off the command line', () => {
    const result = launch(['run', ID], `${token()}\n${gate()}\nBuild a clock\nsecond line`)
    expect(result.status).toBe(0)
    const args = out('args').split('\n').join(' ')
    for (const flag of [
      `--name ag-job-${ID}`,
      '--network ag-sandbox',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--pids-limit 256',
      '--memory 1g',
      '--cpus 1.5',
      `--user ${userInfo().uid}:${userInfo().gid}`,
      `source=${dir}/jobs/${ID},target=/workspace`,
      '--env ANTHROPIC_API_KEY --env AG_DB_TOKEN --env',
      '--rm',
    ])
      expect(args).toContain(flag)
    expect(args).not.toMatch(/privileged|docker\.sock|--network host|pgj1\.|agd1\./)
    expect(args.trim().endsWith('ag-sandbox:latest')).toBe(true)
    expect(out('key')).toBe(token())
    expect(out('dbkey')).toBe(gate())
    expect(out('stdin')).toBe('Build a clock\nsecond line')
  })

  it('takes "-" where there is no database, and a first build whose app has the id of its job', () => {
    expect(launch(['run', ID], `${token()}\n-\nBuild a clock`).status).toBe(0)
    expect(out('dbkey')).toBe('-')
    expect(out('stdin')).toBe('Build a clock')
    expect(launch(['run', ID], `${token()}\n${gate(ID, ID)}\nBuild a clock`).status).toBe(0)
    expect(out('dbkey')).toBe(gate(ID, ID))
  })

  it.each([
    ['a path as job id', ['run', '../../etc'], token()],
    ['shell characters in the job id', ['run', 'abc;id>x&&abcdefghijk'], token()],
    ['an option as job id', ['run', '--privileged'], token()],
    ['extra arguments', ['run', ID, '--privileged'], token()],
    ['an unknown action', ['exec', ID], token()],
    ['a token for another job', ['run', ID], token(OTHER)],
    ['a malformed token', ['run', ID], 'sk-ant-something'],
    ['no token', ['run', ID], ''],
    ['a job without workspace', ['run', OTHER], token(OTHER)],
  ])('refuses %s', (_name, args, input) => {
    const result = launch(args, `${input}\n-\nprompt`)
    expect(result.status).toBe(64)
    expect(existsSync(join(dir, 'args'))).toBe(false)
  })

  it.each([
    ['no database token line', ''],
    ['a prompt where the database token belongs', 'Build a clock'],
    ['a database token for another job', gate(OTHER)],
    ['a database token whose app, not job, is this one', gate(OTHER, ID)],
    ['a job token as database token', token()],
    ['a database token with something after it', `${gate()} --privileged`],
  ])('refuses %s', (_name, second) => {
    const result = launch(['run', ID], `${token()}\n${second}`)
    expect(result.status).toBe(64)
    expect(existsSync(join(dir, 'args'))).toBe(false)
  })

  it('refuses a workspace that is a symlink', () => {
    symlinkSync('/etc', join(dir, 'jobs', OTHER))
    expect(launch(['run', OTHER], `${token(OTHER)}\n-\nprompt`).status).toBe(64)
    expect(existsSync(join(dir, 'args'))).toBe(false)
  })
})

describe('ag-sandbox kill', () => {
  it('kills only the container of that job', () => {
    expect(launch(['kill', ID]).status).toBe(0)
    expect(out('args').trim().split('\n')).toEqual(['kill', `ag-job-${ID}`])
  })
})
