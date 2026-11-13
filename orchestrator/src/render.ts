import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { Config } from './config.js'
import { featureless, readPng, writePng } from './png.js'
import { killContainer } from './sandbox.js'

// The browser check. After the checker has passed an app, it is opened in a
// headless browser inside a second throwaway container: no network, no mount,
// no credential. This is the one place where generated code runs on the
// server. What comes back is hostile data: it is read against a strict schema,
// the pictures are rebuilt, and what counts as a problem is decided here.
//
// Nothing depends on this step. It makes apps better, not safer: every app it
// looks at has already passed the checker, and if it cannot run, the build
// goes on without it.

export interface AppToOpen {
  jobId: string
  // The address the app will be published at. The browser is told it is there.
  base: string
  // The checker's output, exactly as it would be published.
  files: Map<string, Buffer>
  // The agent's own files as text, to tell a finding from words the app means to show.
  sources: Map<string, string>
  database?: { url: string; prefix: string; tables: string[] }
  liveData?: string
}

export interface Seen {
  ran: boolean
  // Findings, phrased for the agent's repair round.
  problems: string[]
  // Pictures of the page by view ("phone", "desktop"), rebuilt here.
  pictures: Map<string, Buffer>
}
export const NOT_SEEN: Seen = { ran: false, problems: [], pictures: new Map() }

const MAX_OUTPUT_BYTES = 4_000_000
const LIMIT_MS = 20_000
const MAX_PROBLEMS = 12

const text = (max: number) => z.string().max(max)
const whole = z.number().int().min(-100_000).max(100_000)
const view = z.strictObject({
  name: z.enum(['phone', 'desktop']),
  width: whole,
  height: whole,
  loaded: z.boolean(),
  hung: z.boolean(),
  dialog: z.boolean(),
  errors: z.array(z.strictObject({ kind: z.enum(['exception', 'console']), text: text(400) })).max(20),
  csp: z.array(z.strictObject({ directive: text(60), blocked: text(200) })).max(10),
  missing: z.array(text(200)).max(10),
  text: z.number().int().min(0),
  odd: z.array(z.strictObject({ where: z.enum(['text', 'field', 'canvas']), token: text(40), snippet: text(200) })).max(40),
  overflow: z.strictObject({ by: whole, offenders: z.array(text(80)).max(3) }).nullable(),
  noViewport: z.boolean(),
  badge: z.strictObject({ x: whole, y: whole, width: whole, height: whole }).nullable(),
  png: z.string().max(3_000_000).nullable(),
})
const SIZES: Record<string, [number, number]> = { phone: [390, 844], desktop: [1280, 900] }
const report = z.strictObject({ views: z.array(view).min(1).max(2) })
export type Report = z.infer<typeof report>

export const parseReport = (output: string): Report | null => {
  try {
    const parsed = report.parse(JSON.parse(output))
    const names = parsed.views.map((each) => each.name)
    const sized = parsed.views.every((each) => each.width === SIZES[each.name]![0] && each.height === SIZES[each.name]![1])
    return sized && new Set(names).size === names.length ? parsed : null
  } catch {
    return null
  }
}

// Text that a page had a hand in: one line, no control characters, and short.
const quoted = (value: string, max = 200) =>
  value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

// Turns a report into findings and pictures. Each finding is a sentence of
// ours with at most a short quote from the page in it.
export const judge = (seen: Report, sources: Map<string, string>): Seen => {
  const written = [...sources.values()].join('\n').replace(/\s+/g, ' ')
  const problems = new Set<string>()
  const pictures = new Map<string, Buffer>()
  for (const each of seen.views) {
    const [width, height] = SIZES[each.name]!
    const picture = each.png ? readPng(Buffer.from(each.png, 'base64'), width, height) : null
    if (picture) pictures.set(each.name, writePng(picture))

    if (!each.loaded) problems.add('The page did not finish loading in a browser within four seconds.')
    if (each.hung) problems.add('The page stops responding in a browser shortly after it loads: a script keeps it busy.')
    if (each.dialog) problems.add('The page opens a dialog box (alert, confirm or prompt) while it loads. Show messages inside the page instead.')
    for (const error of each.errors) problems.add(`${error.kind === 'exception' ? 'A script fails when the page loads' : 'The page logs an error when it loads'}: ${quoted(error.text)}`)
    for (const blocked of each.csp)
      problems.add(`The published page's policy blocks something the page tries when it loads (${quoted(blocked.directive, 40)}${blocked.blocked ? `, ${quoted(blocked.blocked, 80)}` : ''}). A page cannot fetch files or load anything from outside the app: keep data in a .js file.`)
    for (const path of each.missing) problems.add(`The page asks for a file that does not exist: ${quoted(path, 80)}`)
    // Words the app means to show stand in its files as they are. A value that went missing does not.
    for (const hit of each.odd)
      if (hit.where === 'field' || !written.includes(quoted(hit.snippet)))
        problems.add(`The page shows "${quoted(hit.snippet, 120)}" when it loads${hit.where === 'canvas' ? ' (drawn on a canvas)' : hit.where === 'field' ? ' (in a form field)' : ''}: a value is missing where a number or a text should be.`)
    if (each.loaded && !each.hung && each.text === 0 && picture && featureless(picture, each.badge)) problems.add('The page shows nothing when it loads: no text and no picture.')
    if (each.name === 'phone') {
      if (each.noViewport) problems.add('On a phone the page is laid out far wider than the screen. Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head.')
      else if (each.overflow)
        problems.add(
          `On a phone (390 px wide) the page is ${each.overflow.by} px wider than the screen and scrolls sideways.${each.overflow.offenders.length ? ` The widest elements: ${each.overflow.offenders.map((name) => quoted(name, 60)).join(', ')}.` : ''}`,
        )
    }
  }
  return { ran: true, problems: [...problems].slice(0, MAX_PROBLEMS), pictures }
}

// The orchestrator has no access to Docker. Like the agent's container, the
// browser's is started by the root-owned launcher, which fixes every detail.
// The app goes in on stdin and the report comes back on stdout.
const launch = (cfg: Config, jobId: string, document: string) =>
  new Promise<string | null>((resolve) => {
    const child = spawn('sudo', ['-n', cfg.SANDBOX_LAUNCHER, 'render', jobId], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    let gaveUp = ''
    const giveUp = (why: string) => {
      gaveUp ||= why
      void killContainer(cfg, jobId)
    }
    const timer = setTimeout(() => giveUp('it took too long'), LIMIT_MS)

    child.stdin.on('error', () => {})
    child.stdin.end(document)
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-1000)))
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) giveUp('it sent too much')
      else chunks.push(chunk)
    })
    const done = (why: string) => {
      clearTimeout(timer)
      if (why) console.error(`browser check of job ${jobId} did not run: ${why}: ${stderr.trim().slice(-300)}`)
      resolve(why ? null : Buffer.concat(chunks).toString('utf8'))
    }
    child.on('error', (error) => done(`could not start: ${error.message}`))
    child.on('close', (code) => done(gaveUp || (code === 0 ? '' : `exit code ${code}`)))
  })

// One browser at a time, so that two builds finishing together neither double
// the memory nor slow each other's page down.
let turn: Promise<unknown> = Promise.resolve()

// Opens the app in the browser container. Never throws: a check that cannot
// run is reported as such, and the build goes on.
export const openApp = (cfg: Config, app: AppToOpen): Promise<Seen> => {
  const run = async () => {
    try {
      const document = JSON.stringify({
        base: app.base,
        files: Object.fromEntries([...app.files].map(([path, bytes]) => [path, bytes.toString('base64')])),
        database: app.database ?? null,
        liveData: app.liveData ?? null,
      })
      const output = await launch(cfg, app.jobId, document)
      if (output === null) return NOT_SEEN
      const seen = parseReport(output)
      if (!seen) console.error(`browser check of job ${app.jobId}: the report is not what was asked for`)
      return seen ? judge(seen, app.sources) : NOT_SEEN
    } catch (error) {
      console.error(`browser check of job ${app.jobId} failed`, error)
      return NOT_SEEN
    }
  }
  const mine = turn.then(run)
  turn = mine
  return mine
}
