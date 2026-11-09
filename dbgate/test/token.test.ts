import { describe, expect, it } from 'vitest'
import { signAdminToken as orchestratorSigns, signJobToken } from '../../orchestrator/src/token.js'
import { signAdminToken, verifyAdminToken } from '../src/token.js'

const SECRET = 'g'.repeat(40)
const NOW = 1_800_000_000

describe('admin tokens', () => {
  it('accepts a pass until it runs out', () => {
    const token = signAdminToken(SECRET, NOW + 30)
    expect(verifyAdminToken(SECRET, token, NOW)).toBe(true)
    expect(verifyAdminToken(SECRET, token, NOW + 31)).toBe(false)
  })

  it('accepts what the orchestrator signs', () => {
    expect(verifyAdminToken(SECRET, orchestratorSigns(SECRET, NOW + 30), NOW)).toBe(true)
  })

  it('rejects another secret, a changed expiry and a pass that lasts too long', () => {
    expect(verifyAdminToken(SECRET, signAdminToken('h'.repeat(40), NOW + 30), NOW)).toBe(false)
    const [prefix, , mac] = signAdminToken(SECRET, NOW + 30).split('.')
    expect(verifyAdminToken(SECRET, `${prefix}.${NOW + 60}.${mac}`, NOW)).toBe(false)
    expect(verifyAdminToken(SECRET, signAdminToken(SECRET, NOW + 3600), NOW)).toBe(false)
  })

  it('rejects a job token, even one signed with the same secret', () => {
    expect(verifyAdminToken(SECRET, signJobToken(SECRET, 'a'.repeat(20), NOW + 30), NOW)).toBe(false)
  })

  it('rejects anything that is not exactly prefix, expiry and mac', () => {
    const token = signAdminToken(SECRET, NOW + 30)
    for (const bad of ['', 'aga1', `${token}.x`, token.replace('aga1', 'pgj1'), token.replace(String(NOW + 30), `${NOW + 30}e0`), token.slice(0, -1)]) expect(verifyAdminToken(SECRET, bad, NOW)).toBe(false)
  })
})
