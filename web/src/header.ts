import { accountsEnabled, hasLogin } from './account'

// The address this browser is logged in with when the page loads, or null. A login that has run out counts as none.
export const account: Promise<string | null> = hasLogin() ? import('./session').then((session) => session.loggedInAs()).catch(() => null) : Promise.resolve(null)

// The header says on every page whether the visitor is logged in.
export const showAccount = (address: string | null) => {
  const who = document.getElementById('who')
  if (!who || !accountsEnabled) return
  who.querySelector('span')!.textContent = address ?? 'Not logged in'
  who.querySelector('a')!.textContent = address ? 'My apps' : 'Log in'
  who.classList.toggle('in', address !== null)
  who.hidden = false
}

void account.then(showAccount)
