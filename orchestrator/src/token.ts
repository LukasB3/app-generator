import { createHmac, timingSafeEqual } from 'node:crypto'

// Per-job credential handed to the sandbox instead of the real Anthropic key.
// Only the key proxy accepts it, and only until the job's deadline.
export const TOKEN_PREFIX = 'pgj1'
export const TOKEN_PATTERN = /pgj1\.[a-z0-9]+\.\d+\.[a-f0-9]{64}/

const mac = (secret: string, jobId: string, exp: number) =>
  createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${jobId}.${exp}`).digest('hex')

export const signJobToken = (secret: string, jobId: string, expiresAtS: number) =>
  `${TOKEN_PREFIX}.${jobId}.${expiresAtS}.${mac(secret, jobId, expiresAtS)}`

// Tokens for the database gateway. They have prefixes and a secret of their
// own, so a job token for the key proxy can never stand in for one of them.
const gateSigned = (secret: string, text: string) => `${text}.${createHmac('sha256', secret).update(text).digest('hex')}`

// The orchestrator's pass for the gateway's admin routes.
export const signAdminToken = (secret: string, expiresAtS: number) => gateSigned(secret, `aga1.${expiresAtS}`)

// What a sandbox gets for the gateway's tools: good for one job and for the one app that job builds.
export const GATE_TOKEN_PATTERN = /agd1\.[a-z2-7]{20}\.[a-z2-7]{20}\.\d+\.[a-f0-9]{64}/
export const signGateToken = (secret: string, appId: string, jobId: string, expiresAtS: number) => gateSigned(secret, `agd1.${appId}.${jobId}.${expiresAtS}`)

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
