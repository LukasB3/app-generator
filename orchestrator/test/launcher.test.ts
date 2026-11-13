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
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${dir}/args"\nprintf '%s' "$ANTHROPIC_API_KEY" > "${dir}/key"\nprintf '%s' "$AG_DB_TOKEN" > "${dir}/dbkey"\ncat > "${dir}/stdin"\n`)
  chmodSync(join(dir, 'docker'), 0o755)
  writeFileSync(
    join(dir, 'sandbox.conf'),
    `IMAGE=ag-sandbox:latest\nNETWORK=ag-sandbox\nRUNTIME=runc\nMEMORY=1g\nCPUS=1.5\nPIDS=256\nPROXY_URL=http://ag-proxy:8080\nMODEL=claude-sonnet-5-5\nJOBS_DIR=${dir}/jobs\nRUN_AS=${userInfo().username}\nRENDER_IMAGE=ag-render:latest\nRENDER_RUNTIME=runsc\nRENDER_MEMORY=768m\nRENDER_CPUS=1\nRENDER_PIDS=256\n`,
  )
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const launch = (args: string[], input = '') =>
  spawnSync(LAUNCHER, args, { input, encoding: 'utf8', env: { PATH: process.env.PATH, PG_DOCKER: join(dir, 'docker'), PG_SANDBOX_CONF: join(dir, 'sandbox.conf'), PG_TRIAL_CONF: join(dir, 'sandbox-trial.conf') } })

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

describe('ag-sandbox try', () => {
  const onTrial = (text: string) => writeFileSync(join(dir, 'sandbox-trial.conf'), text)

  it('starts the image and the model that are on trial, locked down like any other job', () => {
    onTrial('IMAGE=ag-sandbox:trial\nMODEL=claude-opus-5-5\n')
    const result = launch(['try', ID], `${token()}\n${gate()}\nBuild a clock`)
    expect(result.status).toBe(0)
    const args = out('args').split('\n').join(' ')
    for (const flag of [`--name ag-job-${ID}`, '--network ag-sandbox', '--runtime runc', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--pids-limit 256', '--memory 1g', '--cpus 1.5', `source=${dir}/jobs/${ID},target=/workspace`, '--env ANTHROPIC_MODEL=claude-opus-5-5'])
      expect(args).toContain(flag)
    expect(args.trim().endsWith('ag-sandbox:trial')).toBe(true)
    expect(args).not.toContain('claude-sonnet-5-5')
    expect(out('key')).toBe(token())
    expect(out('stdin')).toBe('Build a clock')
  })

  it('takes the image and the model from the trial and nothing else', () => {
    onTrial('IMAGE=ag-sandbox:trial\nMODEL=claude-opus-5-5\nNETWORK=host\nRUNTIME=evil\nMEMORY=64g\nPIDS=99999\nJOBS_DIR=/etc\nRUN_AS=root\nPROXY_URL=http://evil.example\n')
    expect(launch(['try', ID], `${token()}\n-\nBuild a clock`).status).toBe(0)
    const args = out('args').split('\n').join(' ')
    expect(args).toContain('--network ag-sandbox')
    expect(args).toContain('--runtime runc')
    expect(args).toContain('--memory 1g')
    expect(args).toContain('--pids-limit 256')
    expect(args).toContain(`source=${dir}/jobs/${ID},target=/workspace`)
    expect(args).toContain('ANTHROPIC_BASE_URL=http://ag-proxy:8080')
    expect(args).toContain(`--user ${userInfo().uid}:${userInfo().gid}`)
  })

  it.each([
    ['nothing is on trial', undefined],
    ['the trial names no image', 'MODEL=claude-opus-5-5\n'],
    ['the trial names no model', 'IMAGE=ag-sandbox:trial\n'],
  ])('refuses when %s', (_name, text) => {
    if (text) onTrial(text)
    expect(launch(['try', ID], `${token()}\n-\nBuild a clock`).status).toBe(64)
    expect(existsSync(join(dir, 'args'))).toBe(false)
  })

  it('refuses a trial file that is a symlink, and a token for another job', () => {
    symlinkSync(join(dir, 'sandbox.conf'), join(dir, 'sandbox-trial.conf'))
    expect(launch(['try', ID], `${token()}\n-\nBuild a clock`).status).toBe(64)
    rmSync(join(dir, 'sandbox-trial.conf'))
    onTrial('IMAGE=ag-sandbox:trial\nMODEL=claude-opus-5-5\n')
    expect(launch(['try', ID], `${token(OTHER)}\n-\nBuild a clock`).status).toBe(64)
    expect(existsSync(join(dir, 'args'))).toBe(false)
  })

  it('leaves a plain run on the website\'s image and model while something is on trial', () => {
    onTrial('IMAGE=ag-sandbox:trial\nMODEL=claude-opus-5-5\n')
    expect(launch(['run', ID], `${token()}\n-\nBuild a clock`).status).toBe(0)
    const args = out('args').split('\n').join(' ')
    expect(args.trim().endsWith('ag-sandbox:latest')).toBe(true)
    expect(args).toContain('--env ANTHROPIC_MODEL=claude-sonnet-5-5')
  })
})

describe('ag-sandbox render', () => {
  it('starts the browser with no network, no mount and no token, and hands it the app on stdin', () => {
    const result = launch(['render', ID], '{"base":"https://apps.example/"}')
    expect(result.status).toBe(0)
    const args = out('args').split('\n').join(' ')
    for (const flag of [`--name ag-render-${ID}`, '--network none', '--runtime runsc', '--user 65534:65534', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--pids-limit 256', '--memory 768m', '--cpus 1', '--rm'])
      expect(args).toContain(flag)
    expect(args).not.toMatch(/--mount|--volume|-v |ANTHROPIC|AG_DB_TOKEN|privileged|docker\.sock|ag-sandbox/)
    expect(args.trim().endsWith('ag-render:latest')).toBe(true)
    expect(out('key')).toBe('')
    expect(out('dbkey')).toBe('')
    expect(out('stdin')).toBe('{"base":"https://apps.example/"}')
  })

  it.each([
    ['a path as job id', ['render', '../../etc']],
    ['an option as job id', ['render', '--privileged']],
    ['extra arguments', ['render', ID, '--network=host']],
  ])('refuses %s', (_name, args) => {
    expect(launch(args, '{}').status).toBe(64)
    expect(existsSync(join(dir, 'args'))).toBe(false)
  })
})

describe('ag-sandbox kill', () => {
  it('kills the two containers of that job and no other', () => {
    expect(launch(['kill', ID]).status).toBe(0)
    expect(out('args').trim().split('\n')).toEqual(['kill', `ag-job-${ID}`, 'kill', `ag-render-${ID}`])
  })
})
