import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotReady, createGate, type Gate } from '../src/db.js'
import { LIMITS, Refused } from '../src/schema.js'

// These tests need a real Postgres: TEST_DATABASE_URL names a superuser on a
// server where they may create a database and roles. CI provides one; without
// it they are skipped. The database is set up with the same script as Supabase.
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL is not set')

const DATABASE = 'gate_test'
const GATE_PASSWORD = 'not-a-secret-only-for-tests'
const APP = 'a'.repeat(20)
const OTHER = 'b'.repeat(20)
const entries = { action: 'create_table', table: 'entries', columns: [{ name: 'author', type: 'text' }, { name: 'stars', type: 'integer' }] }
const todos = { action: 'create_table', table: 'todos', mode: 'shared', columns: [{ name: 'title', type: 'text' }, { name: 'done', type: 'boolean' }] }

const urlFor = (user?: string, password?: string) => {
  const target = new URL(url!)
  target.pathname = `/${DATABASE}`
  if (user) target.username = user
  if (password) target.password = password
  return target.href
}

describe('readiness', () => {
  it('is not ready while the database is out of reach, and asks again later', async () => {
    const asItShouldBe = { powerful: false, member: false, usable: [], creatable: [], equipped: true }
    const query = vi.fn().mockRejectedValueOnce(new Error('connect ECONNREFUSED')).mockResolvedValue({ rows: [asItShouldBe] })
    const logged: string[] = []
    let time = 1_000_000
    const gate = createGate({ query } as unknown as pg.Pool, { log: (line) => logged.push(line), now: () => time })

    await expect(gate.ready()).rejects.toThrow('the database is out of reach or not set up: connect ECONNREFUSED')
    // For half a minute the answer comes without asking the database again.
    time += 29_000
    await expect(gate.ready()).rejects.toBeInstanceOf(NotReady)
    expect(query).toHaveBeenCalledTimes(1)
    time += 2_000
    await expect(gate.ready()).resolves.toBeUndefined()
    await gate.ready()
    expect(query).toHaveBeenCalledTimes(2)
    expect(logged).toEqual(['self-test passed'])
  })
})

describe.skipIf(!url)('gateway against Postgres', () => {
  let admin: pg.Client
  let pool: pg.Pool
  let gate: Gate

  // What a visitor of an app can do: the Data API runs their requests as `anon`.
  const asAnon = async (sql: string, role = 'anon') => {
    await admin.query(`set role ${role}`)
    try {
      return await admin.query(sql)
    } finally {
      await admin.query('reset role')
    }
  }
  const denied = { code: '42501' }
  const table = (name: string, appId = APP) => `apps."a${appId}_${name}"`
  const newGate = (limits = LIMITS) => createGate(pool, { limits, log: () => {} })

  beforeAll(async () => {
    const server = new pg.Client(url)
    await server.connect()
    await server.query(`drop database if exists ${DATABASE} with (force)`)
    await server.query(`create database ${DATABASE}`)
    await server.end()

    admin = new pg.Client(urlFor())
    await admin.connect()
    await admin.query(readFileSync(new URL('./standin.sql', import.meta.url), 'utf8'))
    await admin.query(readFileSync(new URL('../../infra/supabase-setup.sql', import.meta.url), 'utf8'))
    await admin.query(`alter role ag_gate password '${GATE_PASSWORD}'`)
    pool = new pg.Pool({ connectionString: urlFor('ag_gate', GATE_PASSWORD), max: 2 })
    gate = newGate()
  })
  afterAll(async () => {
    await pool?.end()
    await admin?.end()
  })
  beforeEach(async () => {
    await gate.sweep([])
  })

  describe('self-test', () => {
    it('passes for the role as the setup script makes it', async () => {
      await expect(newGate().ready()).resolves.toBeUndefined()
    })

    it.each([
      ['a member of another role', 'grant service_role to ag_gate', 'revoke service_role from ag_gate', /member of another role/],
      ['able to use the accounts schema', 'grant usage on schema auth to ag_gate', 'revoke usage on schema auth from ag_gate', /can use the schemas auth/],
      ['able to create in another schema', 'grant create on schema public to ag_gate', 'revoke create on schema public from ag_gate', /can create objects in the schemas public/],
      ['allowed to create roles', 'alter role ag_gate createrole', 'alter role ag_gate nocreaterole', /superuser or may create roles/],
      ['allowed to bypass row security', 'alter role ag_gate bypassrls', 'alter role ag_gate nobypassrls', /bypass row security/],
      ['short of its own rights', 'revoke create on schema apps from ag_gate', 'grant create on schema apps to ag_gate', /lacks its rights/],
    ])('refuses to work when the role is %s', async (_, grant, undo, reason) => {
      await admin.query(grant)
      const tainted = newGate()
      try {
        await expect(tainted.ready()).rejects.toThrow(reason)
        await expect(tainted.ready()).rejects.toBeInstanceOf(NotReady)
        await expect(tainted.commit(APP, [entries])).rejects.toBeInstanceOf(NotReady)
        await expect(tainted.sweep([])).rejects.toBeInstanceOf(NotReady)
        await expect(tainted.tables(APP)).rejects.toBeInstanceOf(NotReady)
      } finally {
        await admin.query(undo)
      }
      // The verdict stands until the gateway is started again.
      await expect(tainted.ready()).rejects.toBeInstanceOf(NotReady)
      await expect(newGate().ready()).resolves.toBeUndefined()
    })

    it('cannot read the accounts, whatever the self-test says', async () => {
      await expect(pool.query('select * from auth.users')).rejects.toMatchObject(denied)
      await expect(pool.query('select * from apps.heartbeat')).rejects.toMatchObject(denied)
      await expect(pool.query('create table public.mine (id int)')).rejects.toMatchObject(denied)
      await expect(pool.query('create role helper')).rejects.toMatchObject(denied)
    })
  })

  describe('unused accounts', () => {
    it('are deleted 90 days after their last login, unless a session was renewed since', async () => {
      const account = async (email: string, createdDaysAgo: number, loginDaysAgo: number | null, sessionDaysAgo?: [created: number, updated: number | null, refreshed: number | null]) => {
        const ago = (days: number | null) => (days === null ? 'null' : `now() - interval '${days} days'`)
        const { rows } = await admin.query(`insert into auth.users (email, created_at, last_sign_in_at) values ('${email}', ${ago(createdDaysAgo)}, ${ago(loginDaysAgo)}) returning id`)
        if (sessionDaysAgo) {
          const [created, updated, refreshed] = sessionDaysAgo
          await admin.query(`insert into auth.sessions (user_id, created_at, updated_at, refreshed_at) values ('${rows[0].id}', ${ago(created)}, ${ago(updated)}, (${ago(refreshed)}) at time zone 'utc')`)
        }
      }
      await account('active@example.com', 200, 10, [10, 1, 1])
      await account('just-inside@example.com', 200, 89)
      await account('old-login-open-page@example.com', 200, 120, [120, 5, 5])
      await account('old-login-renewed-only@example.com', 200, 120, [120, null, 30])
      await account('asked-for-a-mail-yesterday@example.com', 1, null)
      await account('gone-no-session@example.com', 200, 91)
      await account('gone-old-session@example.com', 200, 120, [120, 95, 95])
      await account('gone-session-never-renewed@example.com', 200, 100, [100, null, null])
      await account('gone-never-logged-in@example.com', 100, null)

      expect((await admin.query('select gate.forget_unused_accounts() as n')).rows[0].n).toBe(4)
      const left = await admin.query('select email from auth.users order by 1')
      expect(left.rows.map((row) => row.email)).toEqual(['active@example.com', 'asked-for-a-mail-yesterday@example.com', 'just-inside@example.com', 'old-login-open-page@example.com', 'old-login-renewed-only@example.com', 'someone@example.com'])
      // Their sessions went with them, and nobody else's.
      expect((await admin.query('select count(*)::int as n from auth.sessions')).rows[0].n).toBe(3)
      expect((await admin.query('select gate.forget_unused_accounts() as n')).rows[0].n).toBe(0)
    })

    it('are nothing the gateway or a visitor could delete', async () => {
      await expect(pool.query('select gate.forget_unused_accounts()')).rejects.toMatchObject(denied)
      await expect(asAnon('select gate.forget_unused_accounts()')).rejects.toMatchObject(denied)
    })
  })

  describe('commit', () => {
    it('creates a table visitors can read and add to, and nothing else', async () => {
      expect(await gate.commit(APP, [entries])).toEqual([{ name: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }, { name: 'stars', type: 'integer' }] }])
      expect(await gate.tables(APP)).toEqual([{ name: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }, { name: 'stars', type: 'integer' }] }])

      await asAnon(`insert into ${table('entries')} (author, stars) values ('Ada', 5)`)
      const { rows } = await asAnon(`select * from ${table('entries')}`)
      expect(rows).toEqual([{ id: '1', created_at: expect.any(Date), updated_at: expect.any(Date), author: 'Ada', stars: 5 }])
      expect(await gate.state(APP)).toEqual({ tables: await gate.tables(APP), overall: 1 })

      await expect(asAnon(`update ${table('entries')} set stars = 1`)).rejects.toMatchObject(denied)
      await expect(asAnon(`delete from ${table('entries')}`)).rejects.toMatchObject(denied)
      await expect(asAnon(`truncate ${table('entries')}`)).rejects.toMatchObject(denied)
      await expect(asAnon(`insert into ${table('entries')} (author, created_at) values ('Ada', '2000-01-01')`)).rejects.toMatchObject(denied)
      await expect(asAnon(`insert into ${table('entries')} (author, updated_at) values ('Ada', '2000-01-01')`)).rejects.toMatchObject(denied)
      await expect(asAnon(`insert into ${table('entries')} (id, author) overriding system value values (99, 'Ada')`)).rejects.toMatchObject(denied)
      await expect(asAnon(`alter table ${table('entries')} add column extra text`)).rejects.toMatchObject(denied)
      await expect(asAnon(`drop table ${table('entries')}`)).rejects.toMatchObject(denied)
      await expect(asAnon(`create table apps.mine (id int)`)).rejects.toMatchObject(denied)
    })

    it('gives a logged-in account no more than a visitor: nothing', async () => {
      await gate.commit(APP, [entries])
      await expect(asAnon(`select * from ${table('entries')}`, 'authenticated')).rejects.toMatchObject(denied)
      await expect(asAnon(`insert into ${table('entries')} (author) values ('x')`, 'authenticated')).rejects.toMatchObject(denied)
    })

    it('lets visitors change and delete rows of a shared table', async () => {
      expect(await gate.commit(APP, [todos])).toEqual([{ name: 'todos', mode: 'shared', columns: [{ name: 'title', type: 'text' }, { name: 'done', type: 'boolean' }] }])
      await asAnon(`insert into ${table('todos')} (title, done) values ('write tests', false), ('ship', false)`)
      expect((await asAnon(`update ${table('todos')} set done = true where title = 'write tests'`)).rowCount).toBe(1)
      expect((await asAnon(`delete from ${table('todos')} where title = 'ship'`)).rowCount).toBe(1)
      expect((await asAnon(`select title, done from ${table('todos')}`)).rows).toEqual([{ title: 'write tests', done: true }])
      await expect(asAnon(`update ${table('todos')} set created_at = now()`)).rejects.toMatchObject(denied)
      await expect(asAnon(`update ${table('todos')} set updated_at = '2000-01-01'`)).rejects.toMatchObject(denied)
      await expect(asAnon(`update ${table('todos')} set id = 7`)).rejects.toThrow(/can only be updated to DEFAULT/)
    })

    it('stamps a row with the time of every write', async () => {
      await gate.commit(APP, [todos])
      await asAnon(`insert into ${table('todos')} (title) values ('one'), ('two')`)
      const stamp = async (title: string) => (await asAnon(`select updated_at from ${table('todos')} where title = '${title}'`)).rows[0].updated_at.getTime()
      const [one, two] = [await stamp('one'), await stamp('two')]
      await asAnon(`update ${table('todos')} set done = true where title = 'one'`)
      expect(await stamp('one')).toBeGreaterThan(one)
      expect(await stamp('one')).toBeGreaterThan(two)
      expect(await stamp('two')).toBe(two)
      // The newest stamp and the number of rows together tell a page whether anything changed.
      const latest = async () => (await asAnon(`select max(updated_at) as at, count(*)::int as n from ${table('todos')}`)).rows[0]
      const before = await latest()
      await asAnon(`delete from ${table('todos')} where title = 'two'`)
      expect((await latest()).n).toBe(before.n - 1)
    })

    it('adds a column with the rights of its table', async () => {
      await gate.commit(APP, [entries, todos])
      const tables = await gate.commit(APP, [
        { action: 'add_column', table: 'entries', column: { name: 'note', type: 'text' } },
        { action: 'add_column', table: 'todos', column: { name: 'due', type: 'date' } },
      ])
      expect(tables.map((each) => each.columns.map((column) => column.name))).toEqual([['author', 'stars', 'note'], ['title', 'done', 'due']])
      expect(await gate.tables(APP)).toEqual(tables)

      await asAnon(`insert into ${table('entries')} (author, note) values ('Ada', 'hello')`)
      await expect(asAnon(`update ${table('entries')} set note = 'x'`)).rejects.toMatchObject(denied)
      await asAnon(`insert into ${table('todos')} (title, due) values ('ship', '2026-12-01')`)
      expect((await asAnon(`update ${table('todos')} set due = '2026-12-24'`)).rowCount).toBe(1)
    })

    it('knows every type it offers', async () => {
      const columns = [
        { name: 'a', type: 'text' },
        { name: 'b', type: 'integer' },
        { name: 'c', type: 'number' },
        { name: 'd', type: 'boolean' },
        { name: 'e', type: 'timestamp' },
        { name: 'f', type: 'date' },
      ]
      await gate.commit(APP, [{ action: 'create_table', table: 'kinds', columns }])
      expect((await gate.tables(APP))[0]!.columns).toEqual(columns)
      await asAnon(`insert into ${table('kinds')} (a, b, c, d, e, f) values ('x', 1, 1.5, true, now(), '2026-11-09')`)
    })

    it('stops a table at 500 rows', async () => {
      await gate.commit(APP, [entries, todos])
      await asAnon(`insert into ${table('entries')} (stars) select n from generate_series(1, 499) n`)
      await asAnon(`insert into ${table('entries')} (stars) values (500)`)
      await expect(asAnon(`insert into ${table('entries')} (stars) values (501)`)).rejects.toThrow('table is full')
      expect((await asAnon(`select count(*)::int as n from ${table('entries')}`)).rows[0].n).toBe(500)

      // One statement with too many rows adds none of them.
      await expect(asAnon(`insert into ${table('todos')} (title) select 'x' from generate_series(1, 501)`)).rejects.toThrow('table is full')
      expect((await asAnon(`select count(*)::int as n from ${table('todos')}`)).rows[0].n).toBe(0)

      // Room that deleting makes can be used again.
      await asAnon(`insert into ${table('todos')} (title) select 'x' from generate_series(1, 500)`)
      await asAnon(`delete from ${table('todos')} where id in (select id from ${table('todos')} limit 10)`)
      await asAnon(`insert into ${table('todos')} (title) select 'y' from generate_series(1, 10)`)
      await expect(asAnon(`insert into ${table('todos')} (title) values ('z')`)).rejects.toThrow('table is full')
    })

    it('stops a row at 2 kB, when it is added and when it is changed', async () => {
      await gate.commit(APP, [todos])
      await asAnon(`insert into ${table('todos')} (title) values (repeat('x', 1900))`)
      await expect(asAnon(`insert into ${table('todos')} (title) values (repeat('x', 2100))`)).rejects.toThrow('row too large')
      await expect(asAnon(`update ${table('todos')} set title = repeat('y', 2100)`)).rejects.toThrow('row too large')
      // Text that compresses well is measured as it was sent.
      await expect(asAnon(`insert into ${table('todos')} (title) values (repeat('x', 1000000))`)).rejects.toThrow('row too large')
      await expect(asAnon(`insert into ${table('todos')} (title) values (repeat('é', 1100))`)).rejects.toThrow('row too large')
      expect((await asAnon(`select count(*)::int as n from ${table('todos')}`)).rows[0].n).toBe(1)
    })

    it('refuses what the limits rule out and leaves the database as it was', async () => {
      await gate.commit(APP, [entries])
      await expect(gate.commit(APP, [todos, { action: 'create_table', table: 'third', columns: entries.columns }, { action: 'create_table', table: 'fourth', columns: entries.columns }])).rejects.toThrow(Refused)
      await expect(gate.commit(APP, [entries])).rejects.toThrow('There is a table "entries" already.')
      await expect(gate.commit('not-an-app', [entries])).rejects.toThrow('Unknown app.')
      await expect(gate.tables('not-an-app')).rejects.toThrow('Unknown app.')
      expect((await gate.tables(APP)).map((each) => each.name)).toEqual(['entries'])
    })

    it('counts the tables of all apps against the overall limit', async () => {
      const small = newGate({ ...LIMITS, tablesOverall: 2 })
      await small.commit(APP, [entries])
      await small.commit(OTHER, [entries])
      await expect(small.commit('c'.repeat(20), [entries])).rejects.toThrow(/database is full/)
      await small.commit(OTHER, [{ action: 'add_column', table: 'entries', column: { name: 'note', type: 'text' } }])
    })

    it('keeps the tables of one app apart from those of another', async () => {
      await gate.commit(APP, [entries])
      expect(await gate.tables(OTHER)).toEqual([])
      await gate.commit(OTHER, [todos])
      expect((await gate.tables(APP)).map((each) => each.name)).toEqual(['entries'])
      expect((await gate.tables(OTHER)).map((each) => each.name)).toEqual(['todos'])
    })

    it('applies all of an app\'s changes or none', async () => {
      // A table in the gateway's way that it does not own, so the second statement fails in the database.
      await admin.query(`create table ${table('taken')} (id int)`)
      try {
        await expect(gate.commit(APP, [entries, { action: 'create_table', table: 'taken', columns: entries.columns }])).rejects.toMatchObject({ code: '42P07' })
        expect(await gate.tables(APP)).toEqual([])
        await expect(asAnon(`select * from ${table('entries')}`)).rejects.toMatchObject({ code: '42P01' })
      } finally {
        await admin.query(`drop table ${table('taken')}`)
      }
    })
  })

  describe('sweep', () => {
    it('drops the tables of apps that are not on the list, and only those', async () => {
      await gate.commit(APP, [entries, todos])
      await gate.commit(OTHER, [entries])
      // Not the gateway's: made by someone else, though the name would fit.
      await admin.query(`create table ${table('manual', 'c'.repeat(20))} (id int)`)
      try {
        expect(await gate.sweep([APP, 'd'.repeat(20)])).toEqual([`a${OTHER}_entries`])
        expect((await gate.tables(APP)).map((each) => each.name)).toEqual(['entries', 'todos'])
        expect(await gate.tables(OTHER)).toEqual([])
        expect(await gate.sweep([APP])).toEqual([])
        const left = await admin.query(`select tablename from pg_tables where schemaname = 'apps' order by 1`)
        expect(left.rows.map((row) => row.tablename)).toEqual([`a${APP}_entries`, `a${APP}_todos`, `a${'c'.repeat(20)}_manual`, 'heartbeat'])
        expect((await asAnon('select id from apps.heartbeat')).rows).toEqual([{ id: 1 }])
      } finally {
        await admin.query(`drop table ${table('manual', 'c'.repeat(20))}`)
      }
    })

    it('refuses a list that holds anything but app ids', async () => {
      await gate.commit(APP, [entries])
      for (const keep of [undefined, null, APP, {}, [APP, 'x'], [7], [`${APP}"`]]) await expect(gate.sweep(keep)).rejects.toThrow(Refused)
      expect((await gate.tables(APP)).length).toBe(1)
    })
  })
})
