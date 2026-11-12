import './page'
import { accountsEnabled, API, timeLeft } from './account'
import { mountCaptcha } from './captcha'
import { showAccount } from './header'

// Two widgets: logging in is checked by the login provider, building by the
// orchestrator. Cloudflare's always-pass test key stands in for a missing one.
const TEST_KEY = '1x00000000000000000000AA'
const LOGIN_SITE_KEY = import.meta.env.VITE_TURNSTILE_LOGIN_SITEKEY ?? TEST_KEY
const BUILD_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITEKEY ?? TEST_KEY
const HOUR = 3_600_000

interface OwnedApp {
  id: string
  prompt: string
  url: string | null
  // The build that is published. Without one the app cannot be changed.
  currentJobId: string | null
  latestJobId: string
  status: 'queued' | 'preparing' | 'coding' | 'checking' | 'publishing' | 'done' | 'failed'
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

const appRow = (app: OwnedApp, now: number, change: (app: OwnedApp, row: HTMLLIElement) => void) => {
  const row = el('li')
  const state = el('p', '', 'state')
  if (app.status !== 'done' && app.status !== 'failed') {
    const watch = el('a', 'Watch')
    watch.href = `./#job=${app.latestJobId}`
    state.append(el('span', app.status === 'queued' ? 'Waiting in line' : app.latestJobId === app.id ? 'Being built' : 'Being changed'), watch)
  } else if (app.url) {
    const open = el('a', 'Open')
    // Naming the build makes the browser fetch it instead of a copy it has kept.
    open.href = app.currentJobId ? `${app.url}?v=${app.currentJobId}` : app.url
    open.target = '_blank'
    open.rel = 'noopener'
    state.append(open, el('span', `Online for another ${timeLeft(app.expiresAt, now)}`))
    // A change needs an hour of the app's time to be built in.
    if (app.currentJobId && app.expiresAt - now > HOUR) {
      const button = el('button', 'Change it', 'quiet')
      button.type = 'button'
      button.addEventListener('click', () => change(app, row))
      state.append(button)
    }
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
  const changeForm = $<HTMLFormElement>('change')
  const wish = $<HTMLTextAreaElement>('wish')
  const apply = $<HTMLButtonElement>('apply')
  let captchaToken = ''
  let changeToken = ''
  let changing: OwnedApp | undefined
  // Each widget is put on the page when its form is first shown.
  let resetCaptcha: (() => void) | undefined
  let resetChangeCaptcha: (() => void) | undefined
  let busy = false

  const refresh = () => {
    send.disabled = busy || !captchaToken || !email.value.trim() || !email.validity.valid
    enter.disabled = busy || !/^\d{6,10}$/.test(code.value.trim())
    apply.disabled = busy || !changeToken || wish.value.trim().length < 5
  }

  const changeError = (message = '') => {
    $('change-error').hidden = !message
    $('change-error').textContent = message
  }

  // One form serves every app: it sits under the app that is being changed.
  const openChange = (app: OwnedApp, row: HTMLLIElement) => {
    changing = app
    changeError()
    row.append(changeForm)
    changeForm.hidden = false
    resetChangeCaptcha ??= mountCaptcha('#change-captcha', BUILD_SITE_KEY, (token) => {
      changeToken = token
      refresh()
    })
    wish.focus()
  }
  const closeChange = () => {
    changing = undefined
    changeForm.hidden = true
    $('mine').append(changeForm)
  }

  // Shows the login form or the list, whichever fits the state of the login.
  const show = async () => {
    const address = await session.loggedInAs()
    showAccount(address)
    $('login').hidden = address !== null
    $('mine').hidden = address === null
    if (address === null) {
      resetCaptcha ??= mountCaptcha('#captcha', LOGIN_SITE_KEY, (token) => {
        captchaToken = token
        refresh()
      })
      return
    }
    $('address').textContent = address

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
    closeChange()
    $('apps').replaceChildren(...body.apps.map((app) => appRow(app, now, openChange)))
    $('none').hidden = body.apps.length > 0
  }

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
    resetCaptcha?.()
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

  wish.addEventListener('input', refresh)
  $('keep').addEventListener('click', closeChange)
  changeForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (apply.disabled || !changing) return
    changeError()
    busy = true
    refresh()
    const token = await session.accessToken()
    const res = await fetch(`${API}/api/apps/${changing.id}/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: wish.value, captchaToken: changeToken }),
    }).catch(() => null)
    busy = false
    resetChangeCaptcha?.()
    const body = await res?.json().catch(() => null)
    if (!res?.ok || !body?.id) return changeError(body?.error ?? 'The app generator could not be reached. Check your connection and try again.')
    // The start page shows a change being built the way it shows a new app.
    location.assign(`./#job=${body.id}`)
  })

  $('logout').addEventListener('click', async () => {
    await session.logout().catch(() => null)
    location.assign('./')
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
