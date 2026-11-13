// Opens one app in headless Chromium and reports what happened. The app's
// files arrive as one JSON document on stdin, and one JSON document leaves on
// stdout. The container has no network and no mount: every request the page
// makes is answered here, from those files or from the stand-ins.
//
//   in:  { base, files: { path: base64 }, database: { url, prefix, tables } | null, liveData: string | null }
//   out: { views: [{ name, width, height, loaded, hung, dialog, errors, csp, missing, text, odd, overflow, noViewport, badge, png }] }
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect } from './cdp.mjs'
import { newState, respond } from './standins.mjs'

const VIEWS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1280, height: 900, mobile: false },
]
const BUDGET_MS = 10_000
const LOAD_MS = 4_000
const SETTLE_MIN_MS = 600
const SETTLE_MAX_MS = 2_500
const QUIET_MS = 400
const CALL_MS = 1_500
const MAX_INPUT_BYTES = 12_000_000
const started = Date.now()
const left = () => BUDGET_MS - (Date.now() - started)

const clip = (text, max = 300) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Resolves with undefined when the call takes longer than it may.
const within = (ms, promise) => Promise.race([promise.catch(() => undefined), sleep(Math.max(0, ms)).then(() => undefined)])

const raw = readFileSync(0)
if (raw.length > MAX_INPUT_BYTES) throw new Error('the app is too large to open')
const input = JSON.parse(raw.toString('utf8'))
const config = {
  base: String(input.base),
  files: new Map(Object.entries(input.files).map(([path, bytes]) => [path, Buffer.from(bytes, 'base64')])),
  database: input.database ?? null,
  liveData: input.liveData ?? null,
  now: Date.now(),
}
const inPage = readFileSync(new URL('./page.js', import.meta.url), 'utf8')

const browser = spawn(
  '/opt/chrome/chrome-headless-shell',
  [
    // No --no-sandbox, on purpose. The browser's own sandbox starts under gVisor
    // and nowhere else on this server, so without gVisor there is no browser check.
    '--remote-debugging-pipe',
    '--user-data-dir=/tmp/profile',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-breakpad',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-extensions',
    '--disable-sync',
    '--no-pings',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--lang=en-US',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'] },
)
browser.on('error', (error) => {
  console.error(`the browser did not start: ${error.message}`)
  process.exit(1)
})
const cdp = connect(browser.stdio[3], browser.stdio[4])

const look = async (view) => {
  const result = { name: view.name, width: view.width, height: view.height, loaded: false, hung: false, dialog: false, errors: [], csp: [], missing: [], text: 0, odd: [], overflow: null, noViewport: false, badge: null, png: null }
  const state = newState()
  const { browserContextId } = await cdp.send('Target.createBrowserContext')
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => cdp.send(method, params, sessionId)
  let loaded = () => {}
  const load = new Promise((resolve) => (loaded = resolve))
  let lastRequest = Date.now()

  const answer = ({ requestId, request }) => {
    lastRequest = Date.now()
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
    const reply = respond(config, state, { method: request.method, url: request.url, headers, body: request.postData })
    if (!reply) return send('Fetch.failRequest', { requestId, errorReason: 'AddressUnreachable' })
    if (reply.missing && reply.missing !== 'favicon.ico' && result.missing.length < 10) result.missing.push(clip(reply.missing, 120))
    return send('Fetch.fulfillRequest', {
      requestId,
      responseCode: reply.status,
      responseHeaders: Object.entries(reply.headers).map(([name, value]) => ({ name, value })),
      body: Buffer.from(reply.body).toString('base64'),
    })
  }

  const stop = cdp.listen((method, params, session) => {
    if (session !== sessionId) return
    if (method === 'Fetch.requestPaused') answer(params).catch(() => {})
    else if (method === 'Page.loadEventFired') loaded()
    else if (method === 'Page.javascriptDialogOpening') {
      result.dialog = true
      send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
    } else if (method === 'Runtime.exceptionThrown' && result.errors.length < 20) {
      const details = params.exceptionDetails ?? {}
      const where = details.url ? ` (${clip(details.url.split('/').pop().split('?')[0], 60)}:${(details.lineNumber ?? 0) + 1})` : ''
      result.errors.push({ kind: 'exception', text: clip((details.exception?.description ?? details.text ?? 'error').split('\n')[0]) + where })
    } else if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'assert') && result.errors.length < 20) {
      result.errors.push({ kind: 'console', text: clip((params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')) })
    } else if (method === 'Audits.issueAdded' && params.issue?.code === 'ContentSecurityPolicyIssue' && result.csp.length < 10) {
      const details = params.issue.details?.contentSecurityPolicyIssueDetails ?? {}
      result.csp.push({ directive: clip(details.violatedDirective, 40), blocked: clip((details.blockedURL ?? '').replace(config.base, ''), 120) })
    }
  })

  try {
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Audits.enable').catch(() => {})
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    await send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: 1, mobile: view.mobile })
    await send('Page.addScriptToEvaluateOnNewDocument', { source: inPage })
    const evaluate = (expression, awaitPromise = false) => within(Math.min(CALL_MS, left()), send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }))

    send('Page.navigate', { url: config.base }).catch(() => {})
    result.loaded = (await within(Math.min(LOAD_MS, left() - 1_500), load.then(() => true))) === true
    const loadedAt = Date.now()
    // Settled: nothing asked for and nothing changed in the document for a moment. A clock or a game ends on the cap.
    while (left() > 1_500) {
      const sinceLoad = Date.now() - loadedAt
      if (sinceLoad >= SETTLE_MAX_MS) break
      const quiet = await evaluate('__agCheck.quietFor()')
      if (quiet === undefined) {
        result.hung = true
        break
      }
      if (sinceLoad >= SETTLE_MIN_MS && quiet.result?.value >= QUIET_MS && Date.now() - lastRequest >= QUIET_MS) break
      await sleep(100)
    }
    if (!result.hung) {
      await evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))', true)
      const measured = await evaluate('__agCheck.measure()')
      if (measured === undefined) result.hung = true
      else Object.assign(result, measured.result?.value ?? {})
    }
    const shot = await within(Math.min(2_000, left()), send('Page.captureScreenshot', { format: 'png' }))
    result.png = shot?.data ?? null
  } finally {
    stop()
    await within(500, cdp.send('Target.disposeBrowserContext', { browserContextId }))
  }
  return result
}

const views = []
try {
  for (const view of VIEWS) if (left() > 2_500) views.push(await look(view))
} catch (error) {
  console.error(`the browser check stopped: ${clip(error?.message)}`)
}
browser.kill('SIGKILL')
process.stdout.write(JSON.stringify({ views }), () => process.exit(views.length ? 0 : 1))
