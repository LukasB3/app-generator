import '@fontsource-variable/hepta-slab/wght.css'
import '@fontsource-variable/instrument-sans/wght.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import './style.css'

const API = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'
// Cloudflare's always-pass test key, used when no real key is configured.
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITEKEY ?? '1x00000000000000000000AA'

type Status = 'queued' | 'preparing' | 'coding' | 'checking' | 'publishing' | 'done' | 'failed'
interface JobState {
  id: string
  status: Status
  position: number
  url: string | null
  error: string | null
}
interface Progress {
  seq: number
  ts: number
  type: 'status' | 'file' | 'note'
  data: string
}

const STATIONS: [Status, string, string][] = [
  ['queued', 'Queued', 'One app is built at a time. Yours waits here for its turn.'],
  ['preparing', 'Preparing', 'A fresh, locked-down container starts for this job only.'],
  ['coding', 'Coding', 'The agent writes the files.'],
  ['checking', 'Checking', 'Plain code inspects every file before anything is published.'],
  ['publishing', 'Publishing', 'The checked files go live on their own page.'],
  ['done', 'Done', 'Your link is ready.'],
]
const ORDER = STATIONS.map(([status]) => status)

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const form = $<HTMLFormElement>('order')
const prompt = $<HTMLTextAreaElement>('prompt')
const submit = $<HTMLButtonElement>('submit')
const narrow = matchMedia('(max-width: 52rem)')
const formError = $('form-error')
const ticket = document.querySelector<HTMLElement>('.ticket')!
const result = $('result')
const resultLink = $<HTMLAnchorElement>('result-link')

let captchaToken = ''
let captchaWidget: string | undefined
let source: EventSource | undefined
let clock: number | undefined
let startedAt = 0
let busy = false
let finished = false

const el = (tag: string, text = '', className = '') => {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

const stationNodes = new Map<Status, HTMLLIElement>()
const fileList = el('ul', '', 'files')
for (const [status, name, description] of STATIONS) {
  const item = el('li') as HTMLLIElement
  item.dataset.status = status
  item.append(el('i', '', 'mark'), el('strong', name), el('span', description))
  if (status === 'coding') item.append(fileList)
  if (status === 'done') item.classList.add('end')
  stationNodes.set(status, item)
  $('stations').append(item)
}

const setTicket = (state: string, label: string, figure: string, note: string) => {
  ticket.dataset.state = state
  $('ticket-label').textContent = label
  $('ticket-figure').textContent = figure
  $('ticket-note').textContent = note
}

const refreshSubmit = () => {
  submit.disabled = !finished && (busy || !captchaToken || prompt.value.trim().length < 5)
  submit.textContent = finished ? 'Build another app' : busy ? 'Building…' : 'Build my app'
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

// "failed" is not a station: the job stops wherever it was.
let lastStation: Status = 'queued'
const render = (job: JobState) => {
  if (job.status !== 'failed') lastStation = job.status
  const reached = ORDER.indexOf(lastStation)
  STATIONS.forEach(([status], index) => {
    const node = stationNodes.get(status)!
    node.classList.toggle('past', index < reached || job.status === 'done')
    const now = index === reached && job.status !== 'done' && job.status !== 'failed'
    node.classList.toggle('now', now)
    if (now) node.setAttribute('aria-current', 'step')
    else node.removeAttribute('aria-current')
    node.classList.toggle('stopped', index === reached && job.status === 'failed')
  })

  if (job.status === 'queued') setTicket('waiting', 'Your place in line', String(job.position), job.position <= 1 ? 'You are next.' : 'The line moves when the app ahead of you is finished.')
  else if (job.status === 'done') setTicket('done', 'Your app is', 'Live', 'Open it with the link below. It stays online for 30 days.')
  else if (job.status === 'failed') setTicket('failed', 'The build', 'Failed', job.error ?? 'This app could not be built.')
  else startClock()

  if (job.status === 'done' && job.url) {
    resultLink.href = job.url
    const wasHidden = result.hidden
    result.hidden = false
    $('copy').hidden = false
    resultLink.hidden = false
    if (wasHidden && narrow.matches) resultLink.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  if (job.status === 'failed') {
    result.hidden = false
    $('copy').hidden = true
    resultLink.hidden = true
  }
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
  setTicket('building', 'Now building', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, 'Most apps take two to four minutes. You can leave this page open.')
}

const startClock = () => {
  if (clock !== undefined) return
  startedAt ||= Date.now()
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
        startedAt = Math.min(Date.now(), progress.ts)
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
  lastStation = 'queued'
  history.replaceState(null, '', location.pathname)
  fileList.replaceChildren()
  result.hidden = true
  stationNodes.forEach((node) => {
    node.classList.remove('past', 'now', 'stopped')
    node.removeAttribute('aria-current')
  })
  setTicket('idle', 'Your ticket', 'No.', 'Send a request to take a place in line.')
  refreshSubmit()
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (finished) return location.assign(location.pathname)
  if (submit.disabled) return
  showFormError()
  busy = true
  refreshSubmit()
  const res = await fetch(`${API}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: prompt.value, captchaToken }),
  }).catch(() => null)
  captchaToken = ''
  window.turnstile?.reset(captchaWidget)

  const body = await res?.json().catch(() => null)
  if (!res?.ok || !body?.id) {
    busy = false
    refreshSubmit()
    return showFormError(body?.error ?? 'The app generator could not be reached. Check your connection and try again.')
  }
  fileList.replaceChildren()
  result.hidden = true
  history.replaceState(null, '', `#job=${body.id}`)
  ticket.classList.remove('printed')
  void ticket.offsetWidth
  ticket.classList.add('printed')
  ticket.scrollIntoView({ behavior: 'smooth', block: narrow.matches ? 'start' : 'nearest' })
  render(body)
  watch(body.id)
})

prompt.addEventListener('input', () => {
  $('count').textContent = `${prompt.value.length} / ${prompt.maxLength}`
  refreshSubmit()
})

document.querySelectorAll<HTMLButtonElement>('.examples button').forEach((button) =>
  button.addEventListener('click', () => {
    prompt.value = button.textContent ?? ''
    prompt.dispatchEvent(new Event('input'))
    prompt.focus()
  }),
)

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(resultLink.href).catch(() => {})
  $('copy').textContent = 'Link copied'
  window.setTimeout(() => ($('copy').textContent = 'Copy link'), 2000)
})

window.onTurnstileLoad = () => {
  captchaWidget = window.turnstile!.render('#captcha', {
    sitekey: SITE_KEY,
    callback: (token) => {
      captchaToken = token
      refreshSubmit()
    },
    'expired-callback': () => {
      captchaToken = ''
      refreshSubmit()
    },
  })
}
const script = document.createElement('script')
script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad'
script.async = true
document.head.append(script)

const resumed = /^#job=([a-z2-7]{20})$/.exec(location.hash)?.[1]
if (resumed) watch(resumed)
