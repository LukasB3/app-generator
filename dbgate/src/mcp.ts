import { NotReady, type Gate } from './db.js'
import { MAX_CHANGES, MODES, Refused, TYPES, plan, type Change } from './schema.js'
import type { JobPass } from './token.js'

// The agent's side of the gateway: a Model Context Protocol server with three
// tools, spoken as plain JSON over HTTP POST. The tools change nothing in the
// database. They check what the agent asks for and write it down. When the
// agent is done, the orchestrator fetches the list, and has it applied only
// after the app has passed the checker.

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
// Each call reads from the database, so a job gets a fixed number of them.
const MAX_CALLS = 60
// What a job asked for is kept this long past its deadline, for the orchestrator to fetch.
const KEEP_S = 600
const DOWN = 'The database is not available right now. Build the app without it: keep its data in the browser and do not load lib/db.js.'

const NAMES = 'Lowercase letters, digits and underscores, starting with a letter, 30 characters at most.'
const column = {
  name: { type: 'string', description: `Name of the column. ${NAMES}` },
  type: { type: 'string', enum: Object.keys(TYPES), description: '"number" is a floating point number, "timestamp" a date with time, "date" a calendar day.' },
}
export const TOOLS = [
  {
    name: 'list_tables',
    description: "Lists this app's tables in the shared database with their columns, including the ones asked for in this session.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_table',
    description:
      'Asks for a table in the shared database for this app. It is created when the app passes the checker, not before. Every table gets the columns id, created_at and updated_at by itself. Everything in a table is public: every visitor can read all rows and add rows. Limits: 3 tables per app, 12 columns per table, 500 rows per table, 2 kB per row.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: `Name of the table. ${NAMES}` },
        mode: { type: 'string', enum: MODES, description: '"append" (the default): visitors read and add rows. "shared": every visitor can also change and delete any row.' },
        columns: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: column, required: ['name', 'type'], additionalProperties: false } },
      },
      required: ['table', 'columns'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_column',
    description: "Asks for one more column on one of this app's tables, whether the table exists already or was asked for in this session.",
    inputSchema: { type: 'object', properties: { table: { type: 'string', description: 'Name of the table.' }, ...column }, required: ['table', 'name', 'type'], additionalProperties: false },
  },
]

const record = (value: unknown) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

export const createMcp = (gate: Gate, { log = console.log, now = () => Date.now() / 1000 }: { log?: (line: string) => void; now?: () => number } = {}) => {
  const jobs = new Map<string, { appId: string; changes: Change[]; calls: number; exp: number }>()

  const entryOf = (job: JobPass) => {
    for (const [id, entry] of jobs) if (entry.exp + KEEP_S < now()) jobs.delete(id)
    const entry = jobs.get(job.jobId) ?? { appId: job.appId, changes: [], calls: 0, exp: job.exp }
    jobs.set(job.jobId, entry)
    entry.exp = Math.max(entry.exp, job.exp)
    return entry
  }

  const call = async (job: JobPass, name: unknown, args: Record<string, unknown>) => {
    const entry = entryOf(job)
    if (++entry.calls > MAX_CALLS) throw new Refused('This build has used up its calls to the database tools.')
    const { tables, overall } = await gate.state(job.appId)

    if (name === 'list_tables') {
      const current = entry.changes.length ? plan(job.appId, tables, entry.changes, overall, gate.limits).tables : tables
      return JSON.stringify({ tables: current })
    }
    const change =
      name === 'create_table'
        ? { action: 'create_table', table: args.table, mode: args.mode, columns: args.columns }
        : name === 'add_column'
          ? { action: 'add_column', table: args.table, column: { name: args.name, type: args.type } }
          : undefined
    if (!change) throw new Refused('There is no such tool.')
    if (entry.changes.length >= MAX_CHANGES) throw new Refused('This build has asked for as many changes as one build may make.')
    // Checked against what exists and what was asked for before. Only what passes is written down.
    entry.changes = plan(job.appId, tables, [...entry.changes, change], overall, gate.limits).changes
    const noted = entry.changes.at(-1)!
    return noted.action === 'create_table'
      ? `Noted. The table "${noted.table}" is created when the app passes the checker. Visitors can read ${noted.mode === 'shared' ? 'all rows, add rows, and change or delete any row' : 'all rows and add rows'}. In the app: db.table("${noted.table}") from lib/db.js.`
      : `Noted. The column "${noted.column.name}" is added to "${noted.table}" when the app passes the checker.`
  }

  return {
    // What a job has asked for so far, for the orchestrator.
    plan: (jobId: string) => {
      const entry = jobs.get(jobId)
      return { appId: entry?.appId ?? null, changes: entry?.changes ?? [] }
    },

    // Answers one JSON-RPC message from a job's agent. A notification gets no answer.
    handle: async (job: JobPass, message: unknown): Promise<object | undefined> => {
      const { id, method, params } = record(message)
      const failure = (code: number, text: string) => ({ jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code, message: text } })
      if (typeof method !== 'string') return failure(-32600, 'invalid request')
      if (id === undefined) return undefined
      if (typeof id !== 'string' && typeof id !== 'number') return failure(-32600, 'invalid request')
      const result = (value: object) => ({ jsonrpc: '2.0', id, result: value })

      if (method === 'initialize') {
        const wanted = record(params).protocolVersion
        return result({ protocolVersion: VERSIONS.find((version) => version === wanted) ?? VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'app-generator-db', version: '1' } })
      }
      if (method === 'ping') return result({})
      // Without a working database there are no tools, and the agent builds an app that does not need one.
      if (method === 'tools/list') return result({ tools: (await gate.ready().then(() => true, () => false)) ? TOOLS : [] })
      if (method === 'tools/call') {
        const { name, arguments: args } = record(params)
        const text = await call(job, name, record(args)).catch((error: unknown) => {
          if (error instanceof Refused) return error
          if (!(error instanceof NotReady)) log(`job=${job.jobId} tool failed: ${error instanceof Error ? error.message : 'unknown'}`)
          return new Refused(DOWN)
        })
        return result(text instanceof Refused ? { content: [{ type: 'text', text: text.message }], isError: true } : { content: [{ type: 'text', text }] })
      }
      return failure(-32601, 'method not found')
    },
  }
}

export type Mcp = ReturnType<typeof createMcp>
