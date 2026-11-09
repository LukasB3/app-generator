// What every page may ask about the login without loading the auth library.

export const API = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'

// Accounts need a Supabase project. Without one the site works as it did before them.
export const accountsEnabled = Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_KEY)
export const LOGIN_STORAGE_KEY = 'app-generator-login'

// Whether this browser holds a login. It may have run out: only asking for the header tells.
export const hasLogin = () => {
  try {
    return accountsEnabled && localStorage.getItem(LOGIN_STORAGE_KEY) !== null
  } catch {
    return false
  }
}

// The header that tells the API who is asking. Empty for a visitor who is not logged in.
export const authHeader = async (): Promise<Record<string, string>> => {
  if (!hasLogin()) return {}
  const token = await (await import('./session')).accessToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

// "10 days", "5 hours": the time from `now` until `until`, both on the server's clock.
export const timeLeft = (until: number, now: number) => {
  const hours = Math.max(1, Math.round((until - now) / 3_600_000))
  const [count, unit] = hours < 48 ? [hours, 'hour'] : [Math.round(hours / 24), 'day']
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}
