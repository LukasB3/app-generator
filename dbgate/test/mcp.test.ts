import { beforeEach, describe, expect, it } from 'vitest'
import { NotReady, type Gate } from '../src/db.js'
import { createMcp } from '../src/mcp.js'
import { LIMITS, type Table } from '../src/schema.js'

const APP = 'a'.repeat(20)
const JOB = 'j'.repeat(20)
const NOW = 1_800_000_000

// A gateway without a database: it knows some tables and can be switched off.
let existing: Table[]
let overall: number
let down: Error | undefined
let asked: number
const gate: Gate = {
  limits: LIMITS,
  ready: async () => {
    if (down) throw down
  },
  state: async () => {
    asked++
    if (down) throw down
    return { tables: existing, overall }
  },
  tables: async () => existing,
  commit: async () => {
    throw new Error('the tools must never apply anything')
  },
  sweep: async () => {
    throw new Error('the tools must never drop anything')
  },
}

let time: number
let logged: string[]
let mcp: ReturnType<typeof createMcp>
const job = (jobId = JOB, appId = APP) => ({ appId, jobId, exp: NOW + 900 })
const ask = async (method: string, params?: object, pass = job()) => (await mcp.handle(pass, { jsonrpc: '2.0', id: 1, method, params })) as any
const tool = async (name: string, args: object = {}, pass = job()) => (await ask('tools/call', { name, arguments: args }, pass)).result
const entries = { table: 'entries', columns: [{ name: 'author', type: 'text' }] }

beforeEach(() => {
  existing = []
  overall = 0
  down = undefined
  asked = 0
  time = NOW
  logged = []
  mcp = createMcp(gate, { log: (line) => logged.push(line), now: () => time })
})

describe('protocol', () => {
  it('agrees on a version it knows and offers tools and nothing else', async () => {
    expect((await ask('initialize', { protocolVersion: '2025-11-25', capabilities: {} })).result).toEqual({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'app-generator-db', version: '1' } })
    expect((await ask('initialize', { protocolVersion: '2099-01-01' })).result.protocolVersion).toBe('2025-11-25')
    expect((await ask('initialize')).result.protocolVersion).toBe('2025-11-25')
    expect((await ask('ping')).result).toEqual({})
  })

  it('answers what it does not know with an error, as a newer client expects when it probes', async () => {
    expect(await mcp.handle(job(), { jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} })).toEqual({ jsonrpc: '2.0', id: 'server-discover-probe-1', error: { code: -32601, message: 'method not found' } })
    expect((await ask('resources/list')).error.code).toBe(-32601)
    for (const message of [null, 'text', [], [{ jsonrpc: '2.0', id: 1, method: 'ping' }], { id: 1 }, { id: {}, method: 'ping' }]) expect(((await mcp.handle(job(), message)) as any).error.code).toBe(-32600)
  })

  it('gives a notification no answer', async () => {
    expect(await mcp.handle(job(), { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined()
    expect(await mcp.handle(job(), { jsonrpc: '2.0', method: 'tools/call', params: { name: 'create_table', arguments: entries } })).toBeUndefined()
    expect(mcp.plan(JOB).changes).toEqual([])
  })

  it('lists its tools only while the database works', async () => {
    expect((await ask('tools/list')).result.tools.map((each: { name: string }) => each.name)).toEqual(['list_tables', 'create_table', 'add_column'])
    down = new NotReady('the database is out of reach')
    expect((await ask('tools/list')).result.tools).toEqual([])
  })
})

describe('tools', () => {
  it('write down a table and change nothing', async () => {
    const result = await tool('create_table', entries)
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe('Noted. The table "entries" is created when the app passes the checker. Visitors can read all rows and add rows. In the app: db.table("entries") from lib/db.js.')
    expect(mcp.plan(JOB)).toEqual({ appId: APP, changes: [{ action: 'create_table', table: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }] }] })
  })

  it('say what a shared table lets visitors do', async () => {
    expect((await tool('create_table', { ...entries, mode: 'shared' })).content[0].text).toContain('add rows, and change or delete any row')
    expect(mcp.plan(JOB).changes[0]).toMatchObject({ mode: 'shared' })
  })

  it('add a column to a table that exists or was just asked for', async () => {
    existing = [{ name: 'votes', mode: 'append', columns: [{ name: 'choice', type: 'text' }] }]
    overall = 1
    await tool('create_table', entries)
    expect((await tool('add_column', { table: 'entries', name: 'stars', type: 'integer' })).content[0].text).toBe('Noted. The column "stars" is added to "entries" when the app passes the checker.')
    expect((await tool('add_column', { table: 'votes', name: 'voter', type: 'text' })).isError).toBeUndefined()
    expect(mcp.plan(JOB).changes.map((change) => change.action)).toEqual(['create_table', 'add_column', 'add_column'])
  })

  it('list what exists together with what was asked for', async () => {
    existing = [{ name: 'votes', mode: 'shared', columns: [{ name: 'choice', type: 'text' }] }]
    overall = 1
    expect(JSON.parse((await tool('list_tables')).content[0].text)).toEqual({ tables: existing })
    await tool('create_table', entries)
    await tool('add_column', { table: 'votes', name: 'voter', type: 'text' })
    expect(JSON.parse((await tool('list_tables')).content[0].text)).toEqual({
      tables: [
        { name: 'votes', mode: 'shared', columns: [{ name: 'choice', type: 'text' }, { name: 'voter', type: 'text' }] },
        { name: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }] },
      ],
    })
  })

  it('refuse with a sentence and write nothing down', async () => {
    const refused = async (name: string, args: object) => {
      const result = await tool(name, args)
      expect(result.isError).toBe(true)
      return result.content[0].text as string
    }
    expect(await refused('create_table', { table: 'Entries; drop table x', columns: entries.columns })).toMatch(/^Table names start with/)
    expect(await refused('create_table', { table: 'entries', columns: [{ name: 'id', type: 'text' }] })).toMatch(/^A column cannot be called "id"/)
    expect(await refused('create_table', { table: 'entries', columns: [{ name: 'a', type: 'json' }] })).toMatch(/^A column's type is one of/)
    expect(await refused('create_table', { table: 'entries' })).toMatch(/between 1 and 12 columns/)
    expect(await refused('add_column', { table: 'missing', name: 'a', type: 'text' })).toBe('There is no table "missing".')
    expect(await refused('drop_table', { table: 'entries' })).toBe('There is no such tool.')
    expect(await refused('create_table', [])).toMatch(/^Table names start with/)
    expect(mcp.plan(JOB).changes).toEqual([])

    await tool('create_table', entries)
    expect(await refused('create_table', entries)).toBe('There is a table "entries" already.')
    expect(mcp.plan(JOB).changes).toHaveLength(1)
  })

  it('hold an app to its limits across calls, counting what exists', async () => {
    existing = [
      { name: 'one', mode: 'append', columns: [{ name: 'a', type: 'text' }] },
      { name: 'two', mode: 'append', columns: [{ name: 'a', type: 'text' }] },
    ]
    overall = 2
    expect((await tool('create_table', { ...entries, table: 'three' })).isError).toBeUndefined()
    expect((await tool('create_table', { ...entries, table: 'four' })).content[0].text).toBe('An app can have 3 tables at most.')
    overall = LIMITS.tablesOverall
    expect((await tool('create_table', { ...entries, table: 'five' }, job('k'.repeat(20), 'b'.repeat(20)))).content[0].text).toMatch(/database is full/)
  })

  it('keep the jobs apart', async () => {
    await tool('create_table', entries)
    await tool('create_table', { ...entries, table: 'other' }, job('k'.repeat(20), 'b'.repeat(20)))
    expect(mcp.plan(JOB).changes.map((change) => change.table)).toEqual(['entries'])
    expect(mcp.plan('k'.repeat(20))).toMatchObject({ appId: 'b'.repeat(20), changes: [{ table: 'other' }] })
    expect(mcp.plan('z'.repeat(20))).toEqual({ appId: null, changes: [] })
  })

  it('give a job a fixed number of calls and of changes', async () => {
    for (let n = 0; n < 60; n++) await tool('list_tables')
    expect((await tool('list_tables')).content[0].text).toBe('This build has used up its calls to the database tools.')
    expect((await tool('create_table', entries)).isError).toBe(true)
    expect(asked).toBe(60)
    // Another job is not affected.
    expect((await tool('list_tables', {}, job('k'.repeat(20)))).isError).toBeUndefined()
  })

  it('tell the agent to do without when the database fails, and log why', async () => {
    down = new NotReady('the database is out of reach')
    expect(await tool('create_table', entries)).toEqual({ isError: true, content: [{ type: 'text', text: 'The database is not available right now. Build the app without it: keep its data in the browser and do not load lib/db.js.' }] })
    expect(logged).toEqual([])
    down = new Error('connection terminated unexpectedly')
    expect((await tool('list_tables')).isError).toBe(true)
    expect(logged).toEqual([`job=${JOB} tool failed: connection terminated unexpectedly`])
    expect(mcp.plan(JOB).changes).toEqual([])
  })

  it('forget a job some time after its deadline', async () => {
    await tool('create_table', entries)
    time = NOW + 900 + 599
    await tool('list_tables', {}, { appId: APP, jobId: 'k'.repeat(20), exp: time + 900 })
    expect(mcp.plan(JOB).changes).toHaveLength(1)
    time += 2
    await tool('list_tables', {}, { appId: APP, jobId: 'k'.repeat(20), exp: time + 900 })
    expect(mcp.plan(JOB)).toEqual({ appId: null, changes: [] })
  })
})
