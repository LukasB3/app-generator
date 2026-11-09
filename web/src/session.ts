import { AuthClient } from '@supabase/auth-js'
import { LOGIN_STORAGE_KEY } from './account'

// Logins are Supabase Auth sessions, kept in this browser's local storage.
// There are no passwords: a mail carries a link and a code, and either one
// logs in. The library refreshes the short-lived access token by itself.
const client = new AuthClient({
  url: `${import.meta.env.VITE_SUPABASE_URL}/auth/v1`,
  headers: { apikey: import.meta.env.VITE_SUPABASE_KEY ?? '' },
  storageKey: LOGIN_STORAGE_KEY,
  // The link in the mail leads to /apps, which hands its token over itself.
  detectSessionInUrl: false,
})

const session = async () => (await client.getSession()).data.session

export const accessToken = async () => (await session())?.access_token ?? null
export const loggedInAs = async () => (await session())?.user.email ?? null

export const requestLogin = async (email: string, captchaToken: string) => (await client.signInWithOtp({ email, options: { captchaToken } })).error
export const loginWithCode = async (email: string, code: string) => (await client.verifyOtp({ email, token: code, type: 'email' })).error
export const loginWithLink = async (tokenHash: string) => (await client.verifyOtp({ token_hash: tokenHash, type: 'email' })).error

// Ends the login in this browser only.
export const logout = () => client.signOut({ scope: 'local' })

// Calls back when a login starts or ends, in this tab or in another one.
export const onLoginChange = (changed: () => void) => {
  let known: string | undefined
  client.onAuthStateChange((_event, session) => {
    const now = session?.user.id ?? ''
    // The library forbids calling it from inside this callback, hence the timeout.
    if (known !== undefined && known !== now) setTimeout(changed)
    known = now
  })
}
