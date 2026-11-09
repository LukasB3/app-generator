import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { AuthError, noAuth, supabaseAuth, type Auth } from '../src/auth.js'

const PROJECT = 'https://project.supabase.co'
const USER = '0b5f0d6e-3c1a-4f7e-9b2a-6f1d2c3b4a59'

let auth: Auth
let projectKey: CryptoKey
let otherKey: CryptoKey

// A stand-in for the project's key set: one public key, as its JWKS endpoint would serve it.
beforeAll(async () => {
  const project = await generateKeyPair('ES256')
  projectKey = project.privateKey
  otherKey = (await generateKeyPair('ES256')).privateKey
  auth = supabaseAuth(PROJECT, createLocalJWKSet({ keys: [{ ...(await exportJWK(project.publicKey)), kid: 'key-1', alg: 'ES256', use: 'sig' }] }))
})

// An access token as Supabase Auth issues it, with whatever a test changes.
const token = ({ claims = {}, issuer = `${PROJECT}/auth/v1`, audience = 'authenticated', subject = USER, expires = '1h' as string | number, key = projectKey } = {}) =>
  new SignJWT({ role: 'authenticated', is_anonymous: false, email: 'someone@example.com', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'key-1', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(key)

const bearer = async (jwt: string | Promise<string>) => `Bearer ${await jwt}`
const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url')

describe('supabaseAuth', () => {
  it('returns the account id of a valid login and null without one', async () => {
    expect(await auth(await bearer(token()))).toBe(USER)
    expect(await auth(undefined)).toBeNull()
  })

  it('takes nothing but the account id from the token', async () => {
    const forgedClaims = { role: 'service_role', user_metadata: { admin: true }, app_metadata: { owner: 'someone-else' } }
    expect(await auth(await bearer(token({ claims: forgedClaims })))).toBe(USER)
  })

  it.each([
    ['from another project', () => token({ issuer: 'https://other.supabase.co/auth/v1' })],
    ['for another audience', () => token({ audience: 'anon' })],
    ['that has expired', () => token({ expires: Math.floor(Date.now() / 1000) - 60 })],
    ['signed with a different key', () => token({ key: otherKey })],
    ['of an anonymous sign-in', () => token({ claims: { is_anonymous: true } })],
    ['whose subject is not an account id', () => token({ subject: 'admin' })],
    ['signed with a shared secret instead', () => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer(`${PROJECT}/auth/v1`).setAudience('authenticated').setSubject(USER).setExpirationTime('1h').sign(new TextEncoder().encode('guessable'))],
    ['without a signature', async () => `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ iss: `${PROJECT}/auth/v1`, aud: 'authenticated', sub: USER, exp: Math.floor(Date.now() / 1000) + 600 })}.`],
  ])('refuses a token %s', async (_name, make) => {
    await expect(auth(await bearer(make()))).rejects.toThrow(AuthError)
  })

  it('refuses anything that is not a bearer token', async () => {
    for (const header of ['', 'Bearer ', 'Bearer not-a-token', 'Basic dXNlcjpwYXNz', await token()]) await expect(auth(header)).rejects.toThrow(AuthError)
  })
})

describe('noAuth', () => {
  it('knows no accounts', async () => {
    expect(await noAuth(undefined)).toBeNull()
    await expect(noAuth(await bearer(token()))).rejects.toThrow(AuthError)
  })
})
