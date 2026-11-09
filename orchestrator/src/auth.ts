import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

// Who is asking: the account id for a valid login, null for no login at all.
// A login that does not verify is an error, never a silent "nobody": the
// visitor would otherwise get an anonymous app while believing it is theirs.
export type Auth = (authorization: string | undefined) => Promise<string | null>
export class AuthError extends Error {}

const USER_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

// Logins are Supabase Auth access tokens. They are checked here against the
// project's public keys, so the orchestrator holds no Supabase secret. Only
// the account id is taken from a token: everything else in it could have been
// chosen by the user.
export const supabaseAuth = (supabaseUrl: string, keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))): Auth => {
  return async (authorization) => {
    if (authorization === undefined) return null
    try {
      const token = /^Bearer (\S+)$/.exec(authorization)?.[1] ?? ''
      const { payload } = await jwtVerify(token, keys, { issuer: `${supabaseUrl}/auth/v1`, audience: 'authenticated', algorithms: ['ES256'] })
      if (typeof payload.sub !== 'string' || !USER_ID.test(payload.sub) || payload.is_anonymous === true) throw new Error('not a signed-in account')
      return payload.sub
    } catch {
      throw new AuthError()
    }
  }
}

// Without a Supabase project there are no accounts, and a login cannot be valid.
export const noAuth: Auth = async (authorization) => {
  if (authorization !== undefined) throw new AuthError()
  return null
}
