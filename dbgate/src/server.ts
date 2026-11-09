import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { NotReady, type Gate } from './db.js'
import { Refused } from './schema.js'
import { verifyAdminToken } from './token.js'

// The admin routes, for the orchestrator alone:
//
//   GET  /admin/tables/<app id>               the app's tables
//   POST /admin/commit  { appId, changes }    apply an app's changes, all or none
//   POST /admin/sweep   { keep: [app id] }    drop the tables of all other apps

const MAX_BODY_BYTES = 64_000

const send = (res: ServerResponse, status: number, body: object) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readJson = async (req: IncomingMessage) => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Refused('The request is too large.')
    chunks.push(chunk as Buffer)
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // Reported below.
  }
  throw new Refused('The request body is not a JSON object.')
}

export const createServer = ({ gate, signingSecret, log = console.log }: { gate: Gate; signingSecret: string; log?: (line: string) => void }) => {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? '/', 'http://gate')
    if (req.method === 'GET' && pathname === '/healthz') {
      const ready = await gate.ready().then(
        () => true,
        () => false,
      )
      return send(res, ready ? 200 : 503, { ready })
    }
    if (!pathname.startsWith('/admin/')) return send(res, 404, { error: 'not found' })

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!bearer || !verifyAdminToken(signingSecret, bearer)) return send(res, 401, { error: 'invalid or expired token' })

    const appId = /^\/admin\/tables\/([^/]+)$/.exec(pathname)?.[1]
    if (req.method === 'GET' && appId) return send(res, 200, { tables: await gate.tables(appId) })
    if (req.method === 'POST' && pathname === '/admin/commit') {
      const body = await readJson(req)
      const tables = await gate.commit(String(body.appId), body.changes)
      log(`app=${String(body.appId)} changed, ${tables.length} tables now`)
      return send(res, 200, { tables })
    }
    if (req.method === 'POST' && pathname === '/admin/sweep') {
      const dropped = await gate.sweep((await readJson(req)).keep)
      if (dropped.length) log(`swept ${dropped.join(', ')}`)
      return send(res, 200, { dropped })
    }
    send(res, 404, { error: 'not found' })
  }

  return createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof Refused) return send(res, 400, { error: error.message })
      if (error instanceof NotReady) return send(res, 503, { error: 'database not ready' })
      // Database errors name tables and columns. They go to the log, not to the caller.
      log(`gateway error: ${error instanceof Error ? error.message : 'unknown'}`)
      if (!res.headersSent) send(res, 500, { error: 'database error' })
      else res.destroy()
    })
  })
}
