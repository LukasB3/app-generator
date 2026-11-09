import { createHmac, timingSafeEqual } from 'node:crypto'

// Per-job credential handed to the sandbox instead of the real Anthropic key.
// Only the key proxy accepts it, and only until the job's deadline.
export const TOKEN_PREFIX = 'pgj1'
export const TOKEN_PATTERN = /pgj1\.[a-z0-9]+\.\d+\.[a-f0-9]{64}/

const mac = (secret: string, jobId: string, exp: number) =>
  createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${jobId}.${exp}`).digest('hex')

export const signJobToken = (secret: string, jobId: string, expiresAtS: number) =>
  `${TOKEN_PREFIX}.${jobId}.${expiresAtS}.${mac(secret, jobId, expiresAtS)}`

// The orchestrator's pass for the database gateway's admin routes. It has a
// prefix and a secret of its own, so a job token can never stand in for it.
export const signAdminToken = (secret: string, expiresAtS: number) => `aga1.${expiresAtS}.${createHmac('sha256', secret).update(`aga1.${expiresAtS}`).digest('hex')}`

export const verifyJobToken = (secret: string, token: string, nowS = Date.now() / 1000) => {
  const [prefix, jobId, expRaw, sig, ...rest] = token.split('.')
  if (prefix !== TOKEN_PREFIX || !jobId || !expRaw || !sig || rest.length) return null
  const exp = Number(expRaw)
  if (!Number.isInteger(exp) || exp < nowS) return null
  const expected = Buffer.from(mac(secret, jobId, exp))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  return { jobId, exp }
}
