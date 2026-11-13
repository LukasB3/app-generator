import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig, type Config } from './config.js'
import { gateway, type Gateway } from './gate.js'
import { createPipeline, jobUsage, type Reporter } from './pipeline.js'
import { openApp, type Seen } from './render.js'
import { AgentError, JobTimeout, runAgent } from './sandbox.js'
import { newJobId } from './server.js'
import type { Job } from './store.js'
import { ValidationError } from './validate.js'

// The eval run: a fixed list of requests, each built by the real pipeline.
// The agent, the key proxy, the checker and the browser check are the ones
// the website uses. Two things are swapped: the app is written into the run's
// folder instead of the apps repository, and no table is created. Builds made
// here are not jobs of the site, so they count against none of its limits.
//
//   node dist/eval.js --variant baseline [--reps 2] [--only poll,todo] [--budget-usd 10] [--model claude-sonnet-5-5]
//
// Results go to <DATA_DIR>/evals/<variant>/: one line per build in
// results.jsonl, builds that never got a fair try in errors.jsonl, each app
// with its two pictures under apps/. A build that is already in results.jsonl
// is not made again, so a run that stopped can be started once more.

export interface Case {
  id: string
  tags: string[]
  prompt: string
}

export interface Row {
  prompt_id: string
  rep: number
  prompt: string
  tags: string[]
  status: 'ok'
  // 1 or 0 each: an app came out; it did so without the repair round; the browser check ran and found nothing.
  grade: { built: number; first_try: number; clean: number }
  // Why no app came out: it broke a rule twice, the agent gave up, or time ran out.
  failure?: 'rule' | 'agent' | 'timeout'
  latency_s: number
  steps_s: Record<string, number>
  cost_usd: number
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
  requests: number
  model: string
  findings: string[]
  notes: string[]
  files: number
  bytes: number
  meta: { job: string; error?: string }
}

type Usage = Awaited<ReturnType<typeof jobUsage>>
export interface Tools {
  run: typeof runAgent
  open: typeof openApp
  gate: Gateway
  usage: (cfg: Config, jobId: string) => Promise<Usage>
  newId: () => string
  log: (line: string) => void
}

const line = (file: string, value: object) => appendFileSync(file, `${JSON.stringify(value)}\n`)
const seconds = (ms: number) => Math.round(ms / 100) / 10

// Builds one request once. Returns the row for results.jsonl, or an error for
// a build that failed for a reason that says nothing about the agent.
export const buildCase = async (cfg: Config, tools: Tools, dir: string, each: Case, rep: number, expectModel?: string): Promise<Row | { error: string; job: string }> => {
  const id = tools.newId()
  const appDir = join(dir, 'apps', `${each.id}_rep${rep}`)
  const statuses: { status: string; at: number }[] = []
  const notes: string[] = []
  const looks: Seen[] = []
  const models = new Map<string, number>()
  let published: Map<string, Buffer> | undefined
  const report: Reporter = { status: (status) => void statuses.push({ status, at: Date.now() }), file: () => {}, note: (text) => void notes.push(text), cost: () => {} }

  const pipeline = createPipeline(
    cfg,
    { getApp: () => undefined, setCurrentJob: () => {}, setHasDb: () => {} },
    (config, job) => tools.run(config, { ...job, onModel: (model) => void models.set(model, (models.get(model) ?? 0) + 1) }),
    async (_appId, _jobId, files) => {
      published = files
      for (const [path, bytes] of files) {
        mkdirSync(dirname(join(appDir, path)), { recursive: true })
        writeFileSync(join(appDir, path), bytes)
      }
      return appDir
    },
    { ...tools.gate, commit: async () => {} },
    async (config, app) => {
      const seen = await tools.open(config, app)
      looks.push(seen)
      return seen
    },
  )

  const started = Date.now()
  let failure: Row['failure']
  let error: string | undefined
  try {
    await pipeline({ id, appId: id, prompt: each.prompt } as Job, report)
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 500) : String(caught)
    if (caught instanceof JobTimeout) failure = 'timeout'
    else if (caught instanceof ValidationError) failure = 'rule'
    else if (caught instanceof AgentError && !error.startsWith('could not start sandbox')) failure = 'agent'
    else return { error, job: id }
  }
  const ended = Date.now()
  const used = await tools.usage(cfg, id).catch(() => undefined)
  if (!used) return { error: 'what the build used is unknown: the key proxy did not answer', job: id }
  const model = [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  if (expectModel && model && model !== expectModel) return { error: `answered by ${model}, not by ${expectModel}`, job: id }

  // The pictures of the version that came out, which is the one whose phone picture was published.
  const chosen = looks.findLast((look) => published?.get('preview.png') === look.pictures.get('phone')) ?? looks.at(-1)
  mkdirSync(appDir, { recursive: true })
  for (const [view, bytes] of chosen?.pictures ?? []) writeFileSync(join(appDir, `${view}.png`), bytes)

  const built = published !== undefined
  // How long the build spent in each step, a repair round included.
  const spentMs: Record<string, number> = {}
  statuses.forEach(({ status, at }, index) => (spentMs[status] = (spentMs[status] ?? 0) + (statuses[index + 1]?.at ?? ended) - at))
  const steps = Object.fromEntries(Object.entries(spentMs).map(([status, ms]) => [status, seconds(ms)]))
  const own = [...(published ?? [])].filter(([path]) => !path.startsWith('lib/') && path !== 'preview.png')
  return {
    prompt_id: each.id,
    rep,
    prompt: each.prompt,
    tags: each.tags,
    status: 'ok',
    grade: {
      built: Number(built),
      first_try: Number(built && !notes.some((note) => note.includes('asking the agent to fix them'))),
      clean: Number(built && chosen?.ran === true && chosen.problems.length === 0),
    },
    ...(failure ? { failure } : {}),
    latency_s: seconds(ended - started),
    steps_s: steps,
    cost_usd: used.costMicroUsd / 1e6,
    usage: { input_tokens: used.input, output_tokens: used.output, cache_read_input_tokens: used.cacheRead, cache_creation_input_tokens: used.cacheWrite },
    requests: used.requests,
    model,
    findings: chosen?.problems ?? [],
    notes,
    files: own.length,
    bytes: own.reduce((sum, [, bytes]) => sum + bytes.length, 0),
    meta: { job: id, ...(error ? { error } : {}) },
  }
}

export interface Plan {
  variant: string
  cases: Case[]
  reps: number
  budgetUsd: number
  expectModel?: string
}

// Builds every request of the plan that has no line in results.jsonl yet, one at a time.
export const runEval = async (cfg: Config, tools: Tools, root: string, plan: Plan) => {
  if (!/^(baseline|v\d+)$/.test(plan.variant)) throw new Error('a variant is called "baseline" or "v1", "v2", …')
  const dir = join(root, plan.variant)
  mkdirSync(dir, { recursive: true })
  const results = join(dir, 'results.jsonl')
  const done: Row[] = existsSync(results)
    ? readFileSync(results, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((text) => JSON.parse(text) as Row)
    : []
  let spent = done.reduce((sum, row) => sum + row.cost_usd, 0)
  for (let rep = 0; rep < plan.reps; rep++)
    for (const each of plan.cases) {
      if (done.some((row) => row.prompt_id === each.id && row.rep === rep)) continue
      if (spent >= plan.budgetUsd) {
        tools.log(`stopped: $${spent.toFixed(2)} spent of $${plan.budgetUsd}`)
        return done
      }
      const row = await buildCase(cfg, tools, dir, each, rep, plan.expectModel)
      if ('error' in row) {
        line(join(dir, 'errors.jsonl'), { prompt_id: each.id, rep, at: new Date().toISOString(), ...row })
        tools.log(`${each.id} #${rep}: not counted: ${row.error}`)
        continue
      }
      line(results, row)
      done.push(row)
      spent += row.cost_usd
      const outcome = row.grade.built ? (row.grade.clean ? 'built, clean' : `built, ${row.findings.length || 'unchecked'} finding(s)`) : `no app (${row.failure})`
      tools.log(`${each.id} #${rep}: ${outcome}${row.grade.built && !row.grade.first_try ? ', after repair' : ''}, ${row.latency_s} s, $${row.cost_usd.toFixed(3)}, ${row.model}`)
    }
  const share = (pick: (row: Row) => number) => (done.length ? `${Math.round((100 * done.reduce((sum, row) => sum + pick(row), 0)) / done.length)}%` : '-')
  tools.log(`${done.length} builds: built ${share((row) => row.grade.built)}, first try ${share((row) => row.grade.first_try)}, clean ${share((row) => row.grade.clean)}, $${spent.toFixed(2)}`)
  return done
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { variant: { type: 'string' }, cases: { type: 'string' }, out: { type: 'string' }, reps: { type: 'string', default: '1' }, only: { type: 'string' }, 'budget-usd': { type: 'string', default: '10' }, model: { type: 'string' } },
  })
  const cfg = loadConfig()
  const all = JSON.parse(readFileSync(values.cases ?? join(import.meta.dirname, '../evals/cases.json'), 'utf8')) as Case[]
  const only = values.only?.split(',')
  await runEval(
    cfg,
    { run: runAgent, open: openApp, gate: gateway(cfg), usage: jobUsage, newId: newJobId, log: (text) => console.log(text) },
    values.out ?? join(cfg.DATA_DIR, 'evals'),
    { variant: values.variant ?? '', cases: only ? all.filter((each) => only.includes(each.id)) : all, reps: Number(values.reps), budgetUsd: Number(values['budget-usd']), expectModel: values.model },
  )
}
