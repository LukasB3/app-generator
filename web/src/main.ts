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
const fileList = $('files')
// The steps stand in the page, in the order every job takes them.
const stages = [...document.querySelectorAll<HTMLLIElement>('#stages > li')]
const ORDER = stages.map((stage) => stage.dataset.status as Status)
const IDLE_TITLE = $('status-title').textContent

let captchaToken = ''
let source: EventSource | undefined
let clock: number | undefined
let startedAt = 0
// How far this device's clock runs ahead of the server's.
let clockAhead = 0
let busy = false
let finished = false
// The visitor asked for a build before the captcha had answered. It is sent as soon as it has.
let sendWhenChecked = false

const el = (tag: string, text = '', className = '') => {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

// The line above the steps: what is happening to this visitor's job right now.
const setStatus = (state: 'idle' | 'waiting' | 'building' | 'done' | 'failed', title: string, note = '') => {
  board.dataset.state = state
  board.classList.remove('intro')
  $('status-title').textContent = title
  $('status-note').textContent = note
  $('status-note').hidden = !note
  $('clock').hidden = state !== 'building'
}

const refreshSubmit = () => {
  submit.disabled = !finished && (busy || sendWhenChecked)
  submit.textContent = finished ? 'Build another app' : busy ? 'Building…' : 'Build my app'
  // The captcha stays out of sight unless it needs the visitor, so say what the button waits for.
  $('hint').textContent = sendWhenChecked ? 'Checking that you are not a bot…' : ''
  $('count').textContent = prompt.value.length >= 800 ? `${prompt.value.length} / ${prompt.maxLength}` : ''
}

const showFormError = (message = '') => {
  formError.hidden = !message
  formError.textContent = message
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

// "failed" is not a step: the job stops wherever it was.
let lastStage: Status = 'queued'
const render = (job: JobState) => {
  if (job.now) clockAhead = Date.now() - job.now
  if (job.status !== 'failed') lastStage = job.status
  const reached = ORDER.indexOf(lastStage)
  stages.forEach((node, index) => {
    node.classList.toggle('past', index < reached || job.status === 'done')
    const now = index === reached && job.status !== 'done' && job.status !== 'failed'
    node.classList.toggle('now', now)
    if (now) node.setAttribute('aria-current', 'step')
    else node.removeAttribute('aria-current')
    node.classList.toggle('stopped', index === reached && job.status === 'failed')
  })

  if (job.status === 'queued') setStatus('waiting', job.position <= 1 ? 'You are next in line.' : `Place ${job.position} in line.`, 'One app is built at a time. Yours starts when the one ahead is finished.')
  else if (job.status === 'done') setStatus('done', 'Your app is live.', lifetime(job))
  else if (job.status === 'failed') setStatus('failed', 'The build failed.', job.error ?? 'This app could not be built.')
  else startClock()

  if (job.status === 'done' && job.url) {
    // A changed app keeps its address. Naming the build makes the browser fetch it instead of a copy it has kept.
    resultLink.href = `${job.url}?v=${job.id}`
    resultLink.dataset.address = job.url
    const wasHidden = result.hidden
    result.hidden = false
    if (wasHidden && narrow.matches) resultLink.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
  source = new EventSource(`${API}/api/jobs/${id}/events`)
  source.addEventListener('state', (event) => render(JSON.parse((event as MessageEvent).data)))
  source.addEventListener('progress', (event) => {
    const progress: Progress = JSON.parse((event as MessageEvent).data)
    if (progress.seq <= lastSeq) return
    lastSeq = progress.seq
    if (progress.type === 'status') {
      // The server's start time keeps the clock right after a reload.
      if (progress.data === 'preparing') {
        startedAt = Math.min(Date.now(), progress.ts + clockAhead)
        if (clock !== undefined) tick()
      }
      return
    }
    fileList.append(el('li', progress.data, progress.type))
    fileList.scrollTop = fileList.scrollHeight
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
  fileList.replaceChildren()
  result.hidden = true
  stages.forEach((node) => {
    node.classList.remove('past', 'now', 'stopped')
    node.removeAttribute('aria-current')
  })
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
  if (!captchaToken) {
    sendWhenChecked = true
    return refreshSubmit()
  }
  busy = true
  refreshSubmit()
  // A login that has run out must not turn into an anonymous app without a word.
  const wasLoggedIn = hasLogin()
  const login = await authHeader().catch(() => ({}))
  if (wasLoggedIn && !('authorization' in login)) {
    busy = false
    refreshSubmit()
    return showFormError('Your login has run out. Log in again under "My apps", or send the request once more to build without an account.')
  }
  const res = await fetch(`${API}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...login },
    body: JSON.stringify({ prompt: prompt.value, captchaToken }),
  }).catch(() => null)
  resetCaptcha()

  const body = await res?.json().catch(() => null)
  if (!res?.ok || !body?.id) {
    busy = false
    refreshSubmit()
    return showFormError(body?.error ?? 'The app generator could not be reached. Check your connection and try again.')
  }
  fileList.replaceChildren()
  result.hidden = true
  history.replaceState(null, '', `#job=${body.id}`)
  render(body)
  board.scrollIntoView({ behavior: 'smooth', block: narrow.matches ? 'start' : 'nearest' })
  watch(body.id)
})

prompt.addEventListener('input', refreshSubmit)

document.querySelectorAll<HTMLButtonElement>('.examples button').forEach((button) =>
  button.addEventListener('click', () => {
    prompt.value = button.textContent ?? ''
    prompt.dispatchEvent(new Event('input'))
    prompt.focus()
  }),
)

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(resultLink.dataset.address ?? resultLink.href).catch(() => {})
  $('copy').textContent = 'Link copied'
  window.setTimeout(() => ($('copy').textContent = 'Copy link'), 2000)
})

const resetCaptcha = mountCaptcha('#captcha', SITE_KEY, (token) => {
  captchaToken = token
  const send = sendWhenChecked && token !== ''
  if (send) sendWhenChecked = false
  refreshSubmit()
  if (send) form.requestSubmit()
})

// Logged in, an app stays for ten days, and the line under the form says so.
void account.then((address) => {
  if (address) $('lifetime').textContent = 'ten days'
})

const resumed = /^#job=([a-z2-7]{20})$/.exec(location.hash)?.[1]
if (resumed) {
  board.classList.remove('intro')
  watch(resumed)
}
