import type { Config } from './config.js'
import { signAdminToken } from './token.js'

// The database gateway holds the only database credential on the server. The
// orchestrator reaches it over loopback, with a pass that is good for 30 seconds.

// Has the gateway drop the tables of every app that is not on the list.
// Returns the names of the tables that went.
export const sweepTables = async (cfg: Pick<Config, 'GATE_URL' | 'GATE_SIGNING_SECRET'>, keep: Iterable<string>): Promise<string[]> => {
  if (!cfg.GATE_SIGNING_SECRET) return []
  const res = await fetch(`${cfg.GATE_URL}/admin/sweep`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signAdminToken(cfg.GATE_SIGNING_SECRET, Math.floor(Date.now() / 1000) + 30)}` },
    body: JSON.stringify({ keep: [...keep] }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`the database gateway answered ${res.status}`)
  return ((await res.json()) as { dropped: string[] }).dropped
}
