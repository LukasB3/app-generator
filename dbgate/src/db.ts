import type { Pool, PoolClient } from 'pg'
import { APP_ID, LIMITS, Refused, TYPES, ident, plan, prefixOf, type ColumnType, type Limits, type Table } from './schema.js'

// The gateway cannot do its work right now: the database is out of reach, the
// setup script has not run, or the role failed the self-test below.
export class NotReady extends Error {}

export interface Gate {
  ready(): Promise<void>
  tables(appId: string): Promise<Table[]>
  commit(appId: string, changes: unknown): Promise<Table[]>
  sweep(keep: unknown): Promise<string[]>
}

// The gateway's SQL is only as harmless as the role that runs it. The role is
// meant to have no special powers, to belong to no other role, and to get at
// nothing outside `apps` and its helper function. If it can do more, somebody
// granted it too much, and the gateway refuses to work until that is undone.
const SELF_TEST = `
  select
    r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or r.rolreplication as powerful,
    exists (select from pg_auth_members m where m.member = r.oid) as member,
    array(select n.nspname::text from pg_namespace n
      where n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'public', 'apps', 'gate')
        and has_schema_privilege(r.oid, n.oid, 'usage') order by 1) as usable,
    array(select n.nspname::text from pg_namespace n
      where n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'apps')
        and has_schema_privilege(r.oid, n.oid, 'create') order by 1) as creatable,
    has_schema_privilege(r.oid, 'apps', 'usage') and has_schema_privilege(r.oid, 'apps', 'create')
      and has_function_privilege(r.oid, 'gate.cap()', 'execute') as equipped
  from pg_roles r where r.rolname = current_user`

interface SelfTest {
  powerful: boolean
  member: boolean
  usable: string[]
  creatable: string[]
  equipped: boolean
}

const faultsIn = (role: SelfTest) =>
  [
    role.powerful && 'it is a superuser or may create roles or databases, bypass row security or replicate',
    role.member && 'it is a member of another role',
    role.usable.length && `it can use the schemas ${role.usable.join(', ')}`,
    role.creatable.length && `it can create objects in the schemas ${role.creatable.join(', ')}`,
    !role.equipped && 'it lacks its rights on the schema "apps" or on gate.cap()',
  ].filter((fault): fault is string => Boolean(fault))

// The tables the gateway made: in `apps`, owned by its role, named a<app id>_<name>.
// Anything else in that schema is not its business and is never touched.
const OWN = `c.relnamespace = 'apps'::regnamespace and c.relkind = 'r' and c.relowner = current_user::regrole and c.relname ~ '^a[a-z2-7]{20}_[a-z][a-z0-9_]{0,29}$'`

const TYPE_NAMES = new Map(Object.entries(TYPES).map(([name, sql]) => [sql, name as ColumnType]))

type Db = Pick<Pool | PoolClient, 'query'>

const tablesOf = async (db: Db, appId: string): Promise<Table[]> => {
  if (!APP_ID.test(appId)) throw new Refused('Unknown app.')
  const prefix = prefixOf(appId)
  const { rows } = await db.query(
    `select substr(c.relname, $2) as name, has_table_privilege('anon', c.oid, 'delete') as shared,
       array(select array[a.attname::text, format_type(a.atttypid, a.atttypmod)] from pg_attribute a
         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attname not in ('id', 'created_at') order by a.attnum) as columns
     from pg_class c where ${OWN} and left(c.relname, $2 - 1) = $1 order by c.oid`,
    [prefix, prefix.length + 1],
  )
  return rows.map(({ name, shared, columns }: { name: string; shared: boolean; columns: [string, string][] }) => ({
    name,
    mode: shared ? 'shared' : 'append',
    columns: columns.map(([column, sql]) => {
      const type = TYPE_NAMES.get(sql as (typeof TYPES)[ColumnType])
      if (!type) throw new Error(`table ${prefix}${name} has a column of a type the gateway never creates`)
      return { name: column, type }
    }),
  }))
}

export const createGate = (pool: Pool, { limits = LIMITS, log = console.log }: { limits?: Limits; log?: (line: string) => void } = {}): Gate => {
  // Not known until the database could be asked. Once the role has failed the test, it stays failed until a restart.
  let verdict: string | undefined

  const ready = async () => {
    if (verdict === undefined) {
      const { rows } = await pool.query<SelfTest>(SELF_TEST).catch((error: Error) => {
        throw new NotReady(`the database is out of reach or not set up: ${error.message}`)
      })
      verdict = faultsIn(rows[0]!).join('; ')
      log(verdict ? `self-test failed, refusing to work. The database role is not what it should be: ${verdict}` : 'self-test passed')
    }
    if (verdict) throw new NotReady(verdict)
  }

  const transaction = async <T>(work: (db: PoolClient) => Promise<T>) => {
    await ready()
    const db = await pool.connect()
    let broken = false
    try {
      await db.query('begin')
      // One change to the set of tables at a time, so the counts the limits rest on hold until the commit.
      await db.query('select pg_advisory_xact_lock(1634165604, 0)')
      const result = await work(db)
      // Tells the Data API to read the schema again. Supabase does so by itself; a plain PostgREST would not.
      await db.query(`notify pgrst, 'reload schema'`)
      await db.query('commit')
      return result
    } catch (error) {
      broken = true
      await db.query('rollback').catch(() => {})
      throw error
    } finally {
      db.release(broken)
    }
  }

  return {
    ready,

    tables: async (appId) => {
      await ready()
      return tablesOf(pool, appId)
    },

    // All of an app's changes take effect together or not at all.
    commit: (appId, changes) =>
      transaction(async (db) => {
        const existing = await tablesOf(db, appId)
        const overall = (await db.query<{ n: number }>(`select count(*)::int as n from pg_class c where ${OWN}`)).rows[0]!.n
        const { tables, statements } = plan(appId, existing, changes, overall, limits)
        for (const statement of statements) await db.query(statement)
        return tables
      }),

    // Drops the tables of every app that is not on the list.
    sweep: async (keep) => {
      if (!Array.isArray(keep) || keep.some((id) => typeof id !== 'string' || !APP_ID.test(id))) throw new Refused('"keep" is a list of app ids.')
      const live = new Set<string>(keep)
      return transaction(async (db) => {
        const { rows } = await db.query<{ name: string }>(`select c.relname::text as name from pg_class c where ${OWN} order by 1`)
        const gone = rows.map((row) => row.name).filter((name) => !live.has(name.slice(1, 21)))
        for (const name of gone) await db.query(`drop table apps.${ident(name)}`)
        return gone
      })
    },
  }
}
