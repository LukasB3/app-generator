import { createHmac, timingSafeEqual } from 'node:crypto'

// Two kinds of token open the gateway, both signed with a secret that is the
// gateway's own. Each has a prefix that names what it is for and is covered by
// the MAC, so neither fits the other's door, and no other token of this
// project fits either.
//
//   aga1.<expiry>.<mac>                  the orchestrator's pass for the admin routes
//   agd1.<app>.<job>.<expiry>.<mac>      a job's pass for the agent's tools

const sign = (secret: string, text: string) => `${text}.${createHmac('sha256', secret).update(text).digest('hex')}`

// Splits off the MAC and checks it. Returns the signed fields, or null.
const verified = (secret: string, token: string, prefix: string, fields: number, maxLifetimeS: number, nowS: number) => {
  const parts = token.split('.')
  const sig = parts.pop()
  if (parts.length !== fields + 2 || parts[0] !== prefix || !sig || !/^\d{1,12}$/.test(parts.at(-1)!)) return null
  const exp = Number(parts.at(-1))
  if (exp < nowS || exp > nowS + maxLifetimeS) return null
  const expected = Buffer.from(sign(secret, parts.join('.')).split('.').pop()!)
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  return { fields: parts.slice(1, -1), exp }
}

// An admin pass is made for one call. One that claims to last longer was not made by the orchestrator's code.
export const signAdminToken = (secret: string, expiresAtS: number) => sign(secret, `aga1.${expiresAtS}`)
export const verifyAdminToken = (secret: string, token: string, nowS = Date.now() / 1000) => verified(secret, token, 'aga1', 0, 60, nowS) !== null

// A job's pass lasts as long as the job may run, and names the one app the job may ask tables for.
export interface JobPass {
  appId: string
  jobId: string
  exp: number
}
const ID = /^[a-z2-7]{20}$/
export const signGateToken = (secret: string, appId: string, jobId: string, expiresAtS: number) => sign(secret, `agd1.${appId}.${jobId}.${expiresAtS}`)
export const verifyGateToken = (secret: string, token: string, nowS = Date.now() / 1000): JobPass | null => {
  const pass = verified(secret, token, 'agd1', 2, 3600, nowS)
  const [appId, jobId] = pass?.fields ?? []
  return pass && appId && jobId && ID.test(appId) && ID.test(jobId) ? { appId, jobId, exp: pass.exp } : null
}
