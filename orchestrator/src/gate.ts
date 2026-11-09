import type { Config } from './config.js'
import { signAdminToken, signGateToken } from './token.js'

// The database gateway holds the only database credential on the server. The
// orchestrator reaches it over loopback, with a pass that is good for 30
// seconds, and never sends it SQL: only table changes that the gateway itself
// wrote down while an agent asked for them, and the list of live apps.

// The gateway did not do what it was asked: it is down, the database is, or it refused.
export class DatabaseDown extends Error {}

// What a published page needs to reach its tables. All of it is public.
export interface Database {
  url: string
  key: string
  prefix: string
}

// What an agent asked for. The gateway checked it and checks it again when it applies it.
export type Change = { action: string } & Record<string, unknown>

export interface Gateway {
  // Whether apps can have tables at all on this server.
  enabled: boolean
  // What a job's sandbox gets for the gateway's tools. "-" opens nothing.
  token(appId: string, jobId: string, expiresAtS: number): string
  database(appId: string): Database
  tables(appId: string): Promise<{ name: string }[]>
  plan(jobId: string): Promise<Change[]>
  commit(appId: string, changes: Change[]): Promise<void>
  // Drops the tables of every app that is not on the list. Returns their names.
  sweep(keep: Iterable<string>): Promise<string[]>
}

type GateConfig = Pick<Config, 'GATE_URL' | 'GATE_SIGNING_SECRET' | 'SUPABASE_URL' | 'SUPABASE_KEY'>

export const gateway = (cfg: GateConfig): Gateway => {
  const { GATE_SIGNING_SECRET: secret, SUPABASE_URL: url, SUPABASE_KEY: key } = cfg
  // Tables are of no use to an app unless its pages can be told where to find them.
  const enabled = Boolean(secret && url && key)

  const ask = async <T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> => {
    if (!secret) throw new DatabaseDown('the database gateway is not set up')
    const res = await fetch(`${cfg.GATE_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signAdminToken(secret, Math.floor(Date.now() / 1000) + 30)}` },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((error: Error) => {
      throw new DatabaseDown(`the database gateway is out of reach: ${error.message}`)
    })
    if (!res.ok) throw new DatabaseDown(`the database gateway answered ${res.status} to ${path.split('/').slice(0, 3).join('/')}: ${(await res.text()).slice(0, 200)}`)
    return (await res.json()) as T
  }

  return {
    enabled,
    token: (appId, jobId, expiresAtS) => (enabled ? signGateToken(secret!, appId, jobId, expiresAtS) : '-'),
    database: (appId) => ({ url: url!, key: key!, prefix: `a${appId}_` }),
    tables: async (appId) => (await ask<{ tables: { name: string }[] }>('GET', `/admin/tables/${appId}`)).tables,
    plan: async (jobId) => (enabled ? (await ask<{ changes: Change[] }>('GET', `/admin/plan/${jobId}`)).changes : []),
    commit: async (appId, changes) => void (await ask('POST', '/admin/commit', { appId, changes })),
    sweep: async (keep) => (secret ? (await ask<{ dropped: string[] }>('POST', '/admin/sweep', { keep: [...keep] })).dropped : []),
  }
}
