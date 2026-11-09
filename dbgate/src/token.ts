import { createHmac, timingSafeEqual } from 'node:crypto'

// The orchestrator's pass for the admin routes: aga1.<expiry>.<mac>. The
// prefix names what the pass is for and is covered by the MAC, and the secret
// is the gateway's own, so no other token of this project fits here.
const PREFIX = 'aga1'
// A pass is made for one call. One that claims to last longer was not made by the orchestrator's code.
const MAX_LIFETIME_S = 60

const mac = (secret: string, exp: number) => createHmac('sha256', secret).update(`${PREFIX}.${exp}`).digest('hex')

export const signAdminToken = (secret: string, expiresAtS: number) => `${PREFIX}.${expiresAtS}.${mac(secret, expiresAtS)}`

export const verifyAdminToken = (secret: string, token: string, nowS = Date.now() / 1000) => {
  const [prefix, expRaw, sig, ...rest] = token.split('.')
  if (prefix !== PREFIX || !expRaw || !sig || rest.length || !/^\d{1,12}$/.test(expRaw)) return false
  const exp = Number(expRaw)
  if (exp < nowS || exp > nowS + MAX_LIFETIME_S) return false
  const expected = Buffer.from(mac(secret, exp))
  const given = Buffer.from(sig)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
