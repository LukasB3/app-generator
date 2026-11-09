import './page'
import { accountsEnabled, API, timeLeft } from './account'
import { mountCaptcha } from './captcha'

// Cloudflare's always-pass test key, used when no real key is configured.
const SITE_KEY = import.meta.env.VITE_TURNSTILE_LOGIN_SITEKEY ?? '1x00000000000000000000AA'

interface OwnedApp {
  id: string
  prompt: string
  status: 'queued' | 'preparing' | 'coding' | 'checking' | 'publishing' | 'done' | 'failed'
  url: string | null
  expiresAt: number
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

const notice = (message = '') => {
  $('notice').hidden = !message
  $('notice').textContent = message
}

const appRow = (app: OwnedApp, now: number) => {
  const row = el('li')
  const state = el('p', '', 'state')
  if (app.status === 'done' && app.url) {
    const open = el('a', 'Open')
    open.href = app.url
    open.target = '_blank'
    open.rel = 'noopener'
    state.append(open, el('span', `Online for another ${timeLeft(app.expiresAt, now)}`))
  } else {
    const watch = el('a', 'Watch the build')
    watch.href = `./#job=${app.id}`
    state.append(el('span', app.status === 'queued' ? 'Waiting in line' : 'Being built'), watch)
  }
  row.append(el('p', app.prompt, 'what'), state)
  return row
}

const start = async () => {
  if (!accountsEnabled) return notice('Accounts are not set up on this copy of the site.')
  const session = await import('./session')
  const ask = $<HTMLFormElement>('ask')
  const confirm = $<HTMLFormElement>('confirm')
  const email = $<HTMLInputElement>('email')
  const code = $<HTMLInputElement>('code')
  const send = $<HTMLButtonElement>('send')
  const enter = $<HTMLButtonElement>('enter')
  let captchaToken = ''
  let busy = false

  const refresh = () => {
    send.disabled = busy || !captchaToken || !email.value.trim() || !email.validity.valid
    enter.disabled = busy || !/^\d{6,10}$/.test(code.value.trim())
  }

  // Shows the login form or the list, whichever fits the state of the login.
  const show = async () => {
    const address = await session.loggedInAs()
    $('login').hidden = address !== null
    $('mine').hidden = address === null
    if (address === null) return
    $('who').textContent = address

    const token = await session.accessToken()
    const res = await fetch(`${API}/api/apps`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null)
    if (res?.status === 401) {
      notice('Your login has run out. Please log in again.')
      return void session.logout()
    }
    const body: { apps?: OwnedApp[]; now?: number } | null = await res?.json().catch(() => null)
    if (!res?.ok || !Array.isArray(body?.apps)) return notice('Your apps could not be loaded. Check your connection and reload the page.')
    const now = body.now ?? Date.now()
    notice()
    $('apps').replaceChildren(...body.apps.map((app) => appRow(app, now)))
    $('none').hidden = body.apps.length > 0
  }

  const resetCaptcha = mountCaptcha('#captcha', SITE_KEY, (token) => {
    captchaToken = token
    refresh()
  })
  email.addEventListener('input', refresh)
  code.addEventListener('input', refresh)

  ask.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (send.disabled) return
    notice()
    busy = true
    refresh()
    const address = email.value.trim()
    const error = await session.requestLogin(address, captchaToken)
    busy = false
    resetCaptcha()
    if (error) return notice(error.status === 429 ? 'Too many login mails were asked for. Please wait a minute and try again.' : 'The login mail could not be sent. Check the address and try again.')
    $('sent').textContent = `A mail is on its way to ${address}. Open the link in it, or type its code here. Both work once, for an hour.`
    ask.hidden = true
    confirm.hidden = false
    code.focus()
  })

  confirm.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (enter.disabled) return
    notice()
    busy = true
    refresh()
    const error = await session.loginWithCode(email.value.trim(), code.value.trim())
    busy = false
    refresh()
    if (error) return notice('That code is not right or has run out. Check the mail, or ask for a new one.')
    code.value = ''
  })

  $('again').addEventListener('click', () => {
    notice()
    code.value = ''
    confirm.hidden = true
    ask.hidden = false
    email.focus()
  })

  $('logout').addEventListener('click', () => {
    confirm.hidden = true
    ask.hidden = false
    void session.logout()
  })

  // The link in the login mail leads here with a token that works once.
  const tokenHash = new URLSearchParams(location.search).get('token_hash')
  if (tokenHash) {
    history.replaceState(null, '', location.pathname)
    if (await session.loginWithLink(tokenHash)) notice('This login link has run out or was used before. Ask for a new mail below.')
  }
  await show()
  // From here on the page follows the login: the code typed here, "Log out",
  // or the link from the mail opened in another tab while this one waited.
  session.onLoginChange(() => void show())
}

void start()
