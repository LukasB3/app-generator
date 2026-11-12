import '@fontsource/ibm-plex-mono/latin-400.css'
import './page'
import { API, authHeader, hasLogin, timeLeft } from './account'
import { mountCaptcha } from './captcha'
import { account } from './header'

// Cloudflare's always-pass test key, used when no real key is configured.
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITEKEY ?? '1x00000000000000000000AA'

type Status = 'queued' | 'preparing' | 'coding' | 'checking' | 'publishing' | 'done' | 'failed'
interface JobState {
  id: string
  status: Status
  position: number
  url: string | null
  error: string | null
  expiresAt?: number | null
  now?: number
}
interface Progress {
  seq: number
  ts: number
  // 'file' names a file the agent wrote. The page does not list those.
  type: 'status' | 'file' | 'note'
  data: string
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const form = $<HTMLFormElement>('order')
const prompt = $<HTMLTextAreaElement>('prompt')
const submit = $<HTMLButtonElement>('submit')
const narrow = matchMedia('(max-width: 52rem)')
const formError = $('form-error')
const board = $('job')
const result = $('result')
const resultLink = $<HTMLAnchorElement>('result-link')
// The steps stand in the page, in the order every request takes them. The
// first has no job status: the server screens a request before it makes a job.
const stages = [...document.querySelectorAll<HTMLLIElement>('#stages > li')]
const ORDER = stages.map((stage) => stage.dataset.status)
const IDLE_TITLE = $('status-title').textContent

let captchaToken = ''
let source: EventSource | undefined
let clock: number | undefined
let startedAt = 0
// How far this device's clock runs ahead of the server's.
let clockAhead = 0
let busy = false
let finished = false
// Set while a build the visitor asked for waits for the captcha's answer.
let tokenArrived: (() => void) | undefined

const el = (tag: string, text = '', className = '') => {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

// The line above the steps: what is happening to this visitor's job right now.
const setStatus = (state: 'idle' | 'screening' | 'waiting' | 'building' | 'done' | 'failed', title: string, note = '') => {
  board.dataset.state = state
  board.classList.remove('intro')
  $('status-title').textContent = title
  $('status-note').textContent = note
  $('status-note').hidden = !note
  $('clock').hidden = state !== 'building'
}

const refreshSubmit = () => {
  submit.disabled = busy && !finished
  submit.textContent = finished ? 'Build another app' : busy ? 'Building…' : 'Build my app'
  $('count').textContent = prompt.value.length >= 800 ? `${prompt.value.length} / ${prompt.maxLength}` : ''
}

// The page moves by itself once per build: to the steps, at the click. On a
// phone they then fill the screen, and nothing above them changes height
// while a build runs, so they stay where they are.
const showBoard = () => board.scrollIntoView({ behavior: 'smooth', block: narrow.matches ? 'start' : 'nearest' })

const showFormError = (message = '') => {
  formError.hidden = !message
  formError.textContent = message
  // A refusal that belongs to the form brings the form back.
  if (message) form.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

const stopWatching = () => {
  source?.close()
  source = undefined
}

const stopClock = () => {
  window.clearInterval(clock)
  clock = undefined
  startedAt = 0
}

// How long the app stays online from now, measured on the server's clock.
const lifetime = (job: JobState) => (job.expiresAt ? `It stays online for ${timeLeft(job.expiresAt, job.now ?? Date.now())}.` : '')

// What the server says a build did, in its own words, under the step it happened in.
const addNote = (step: number, text: string) => {
  const node = stages[step]
  if (!node) return
  const list = node.querySelector('.notes') ?? node.appendChild(el('ul', '', 'notes'))
  list.append(el('li', text))
}
const clearNotes = () => document.querySelectorAll('#stages .notes').forEach((list) => list.remove())

// Marks the steps: those before `at` are over. The one at `at` runs, is where
// things stopped, or is still ahead while the job waits for its turn.
const showSteps = (at: number, there: 'now' | 'stopped' | 'ahead' | 'over') => {
  stages.forEach((node, index) => {
    node.classList.toggle('past', index < at || there === 'over')
    node.classList.toggle('now', index === at && there === 'now')
    node.classList.toggle('stopped', index === at && there === 'stopped')
    // The line into a step that a job waits for keeps moving.
    node.classList.toggle('wait', index === at - 1 && there === 'ahead')
    if (index === at && there === 'now') node.setAttribute('aria-current', 'step')
    else node.removeAttribute('aria-current')
  })
}

// "failed" is not a step: the job stops wherever it was. A queued job has
// passed the screen and waits in front of the next step.
let lastStage: Status = 'queued'
const render = (job: JobState) => {
  if (job.now) clockAhead = Date.now() - job.now
  if (job.status !== 'failed') lastStage = job.status
  const waiting = lastStage === 'queued'
  showSteps(waiting ? 1 : ORDER.indexOf(lastStage), job.status === 'done' ? 'over' : job.status === 'failed' ? 'stopped' : waiting ? 'ahead' : 'now')

  if (job.status === 'queued') setStatus('waiting', job.position <= 1 ? 'You are next in line.' : `Place ${job.position} in line.`, 'Two apps are built at a time. Yours starts when one of them is finished.')
  else if (job.status === 'done') setStatus('done', 'Your app is live.', lifetime(job))
  else if (job.status === 'failed') setStatus('failed', 'The build failed.', job.error ?? 'This app could not be built.')
  else startClock()

  if (job.status === 'done' && job.url) {
    // A changed app keeps its address. Naming the build makes the browser fetch it instead of a copy it has kept.
    resultLink.href = `${job.url}?v=${job.id}`
    resultLink.dataset.address = job.url
    const wasHidden = result.hidden
    result.hidden = false
    // Only a visitor who scrolled away in the meantime is brought back to the link.
    if (wasHidden && narrow.matches) showBoard()
  }
  if (job.status === 'failed') result.hidden = true
  if (job.status === 'done' || job.status === 'failed') {
    stopWatching()
    stopClock()
    busy = false
    finished = job.status === 'done'
    refreshSubmit()
  }
}

// Runs independently of the event stream, so reconnecting never stops it.
const tick = () => {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  $('clock').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const startClock = () => {
  if (clock !== undefined) return
  startedAt ||= Date.now()
  setStatus('building', 'Building your app', 'Most apps take under two minutes. You can leave this page open.')
  tick()
  clock = window.setInterval(tick, 1000)
}

const watch = (id: string) => {
  stopWatching()
  busy = true
  refreshSubmit()
  let lastSeq = 0
  // The step the stream has reached, which after a reload runs behind the job's state.
  let step = 0
  source = new EventSource(`${API}/api/jobs/${id}/events`)
  source.addEventListener('state', (event) => render(JSON.parse((event as MessageEvent).data)))
  source.addEventListener('progress', (event) => {
    const progress: Progress = JSON.parse((event as MessageEvent).data)
    if (progress.seq <= lastSeq) return
    lastSeq = progress.seq
    if (progress.type === 'status') {
      step = Math.max(0, ORDER.indexOf(progress.data))
      // The server's start time keeps the clock right after a reload.
      if (progress.data === 'preparing') {
        startedAt = Math.min(Date.now(), progress.ts + clockAhead)
        if (clock !== undefined) tick()
      }
    } else if (progress.type === 'note') addNote(step, progress.data)
  })
  source.onerror = async () => {
    // The browser retries by itself; only give up if the job is gone.
    const res = await fetch(`${API}/api/jobs/${id}`).catch(() => null)
    if (res?.status === 404) reset()
  }
}

const reset = () => {
  stopWatching()
  stopClock()
  busy = false
  finished = false
  lastStage = 'queued'
  history.replaceState(null, '', location.pathname)
  clearNotes()
  result.hidden = true
  showSteps(-1, 'ahead')
  setStatus('idle', IDLE_TITLE)
  refreshSubmit()
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (finished) return location.assign(location.pathname)
  if (busy) return
  showFormError()
  if (prompt.value.trim().length < 5) {
    prompt.focus()
    return showFormError('Describe the app you want in a few words first.')
  }
  busy = true
  refreshSubmit()
  clearNotes()
  result.hidden = true
  // Screening is both gates, so the first step runs from the click: Cloudflare's
  // check in the browser, then the server, which screens before it answers.
  captcha.wake()
  const checked = captchaToken !== ''
  showSteps(0, 'now')
  setStatus('screening', checked ? 'Screening your request' : 'Checking that you are not a bot')
  // The field would keep a phone's keyboard open over the steps.
  if (narrow.matches) prompt.blur()
  showBoard()
  const backToForm = (message: string) => {
    busy = false
    refreshSubmit()
    showSteps(-1, 'ahead')
    setStatus('idle', IDLE_TITLE)
    showFormError(message)
  }
  // A login that has run out must not turn into an anonymous app without a word.
  const wasLoggedIn = hasLogin()
  const login = await authHeader().catch(() => ({}))
  if (wasLoggedIn && !('authorization' in login))
    return backToForm('Your login has run out. Log in again under "My apps", or send the request once more to build without an account.')
  if (!captchaToken) await new Promise<void>((resolve) => (tokenArrived = resolve))
  if (!checked) setStatus('screening', 'Screening your request')
  const res = await fetch(`${API}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...login },
    body: JSON.stringify({ prompt: prompt.value, captchaToken }),
  }).catch(() => null)
  // The token is spent. The next one is fetched at the next click, not now:
  // a check that wanted the visitor's click in the middle of a build would
  // look like a second screening.
  captcha.rest()

  const body = await res?.json().catch(() => null)
  if (res?.ok && body?.id) {
    history.replaceState(null, '', `#job=${body.id}`)
    render(body)
    return watch(body.id)
  }
  // 422 is the screen's own answer, so it is shown where the screen stands.
  if (res?.status === 422 && body?.error) {
    busy = false
    refreshSubmit()
    showSteps(0, 'stopped')
    return setStatus('failed', 'This request was turned away.', body.error)
  }
  backToForm(body?.error ?? 'The app generator could not be reached. Check your connection and try again.')
})

prompt.addEventListener('input', refreshSubmit)

document.querySelectorAll<HTMLButtonElement>('.examples button').forEach((button) =>
  button.addEventListener('click', () => {
    prompt.value = button.dataset.prompt ?? ''
    prompt.dispatchEvent(new Event('input'))
    prompt.focus()
  }),
)

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(resultLink.dataset.address ?? resultLink.href).catch(() => {})
  $('copy').textContent = 'Link copied'
  window.setTimeout(() => ($('copy').textContent = 'Copy link'), 2000)
})

const captcha = mountCaptcha('#bot-check', SITE_KEY, (token) => {
  captchaToken = token
  if (!token) return
  tokenArrived?.()
  tokenArrived = undefined
})

// Logged in, an app stays for ten days and can be changed, and the line under the form says so.
void account.then((address) => {
  $('stay-out').hidden = address !== null
  $('stay-in').hidden = address === null
})

const resumed = /^#job=([a-z2-7]{20})$/.exec(location.hash)?.[1]
if (resumed) {
  board.classList.remove('intro')
  // A build is running, so the check that every page load starts is called off.
  captcha.rest()
  watch(resumed)
}
