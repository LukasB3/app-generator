// What an app may ask of the database, and the SQL that grants it. Plain code
// over checked input: a name is matched against a strict pattern before it is
// quoted, types and modes come from fixed lists, and nothing else from a
// request ever becomes part of a statement.

export const TYPES = {
  text: 'text',
  integer: 'integer',
  number: 'double precision',
  boolean: 'boolean',
  timestamp: 'timestamp with time zone',
  date: 'date',
} as const
export type ColumnType = keyof typeof TYPES

// `append`: visitors read every row and add rows. `shared`: they also change
// and delete rows. Either way every row is public.
export const MODES = ['append', 'shared'] as const
export type Mode = (typeof MODES)[number]

export interface Column {
  name: string
  type: ColumnType
}
export interface Table {
  name: string
  mode: Mode
  columns: Column[]
}

// The caps on rows per table and bytes per row are in gate.cap(), in
// infra/supabase-setup.sql: the database enforces them on every write.
export interface Limits {
  tablesPerApp: number
  columnsPerTable: number
  tablesOverall: number
}
export const LIMITS: Limits = { tablesPerApp: 3, columnsPerTable: 12, tablesOverall: 150 }
const MAX_CHANGES = 40

// A request the gateway turns down. The message is a fixed sentence, fit to be
// shown to whoever asked; it never repeats input that failed a check.
export class Refused extends Error {}

export const APP_ID = /^[a-z2-7]{20}$/
const NAME = /^[a-z][a-z0-9_]{0,29}$/
const NAME_RULE = 'start with a lowercase letter and hold only lowercase letters, digits and underscores, 30 characters at most'
// The columns every table gets, and the words the Data API reads as query
// parameters, which a column of the same name could never be filtered by.
const RESERVED = new Set(['id', 'created_at', 'select', 'order', 'limit', 'offset', 'columns', 'on_conflict', 'and', 'or', 'not'])

// Every identifier in a statement passes through here, whatever checked it before.
export const ident = (name: string) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error('not an identifier')
  return `"${name}"`
}

// An app's tables share one schema with every other app's, told apart by the app id in the name.
export const prefixOf = (appId: string) => `a${appId}_`
const qualified = (appId: string, table: string) => `apps.${ident(prefixOf(appId) + table)}`

const createTable = (appId: string, { name, mode, columns }: Table) => {
  const table = qualified(appId, name)
  const names = columns.map((column) => ident(column.name)).join(', ')
  return [
    `create table ${table} (id bigint generated always as identity primary key, created_at timestamp with time zone not null default now(), ${columns.map((column) => `${ident(column.name)} ${TYPES[column.type]}`).join(', ')})`,
    // Without a policy nobody but the owner gets at a row, so each right below is given twice: as a grant and as a policy.
    `alter table ${table} enable row level security`,
    `create trigger cap before insert or update on ${table} for each row execute function gate.cap()`,
    `grant select on ${table} to anon`,
    `create policy anon_select on ${table} for select to anon using (true)`,
    // Visitors fill the app's own columns only: never the id, never the time a row was made.
    `grant insert (${names}) on ${table} to anon`,
    `create policy anon_insert on ${table} for insert to anon with check (true)`,
    ...(mode === 'shared'
      ? [
          `grant update (${names}), delete on ${table} to anon`,
          `create policy anon_update on ${table} for update to anon using (true) with check (true)`,
          `create policy anon_delete on ${table} for delete to anon using (true)`,
        ]
      : []),
  ]
}

const addColumn = (appId: string, { name, mode }: Table, column: Column) => {
  const added = ident(column.name)
  return [
    `alter table ${qualified(appId, name)} add column ${added} ${TYPES[column.type]}`,
    `grant insert (${added})${mode === 'shared' ? `, update (${added})` : ''} on ${qualified(appId, name)} to anon`,
  ]
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Refused('Each change is an object with an "action".')
  return value as Record<string, unknown>
}

const tableNameIn = (value: unknown) => {
  if (typeof value !== 'string' || !NAME.test(value)) throw new Refused(`Table names ${NAME_RULE}.`)
  return value
}

const columnIn = (value: unknown, taken: Column[]): Column => {
  const { name, type } = record(value)
  if (typeof name !== 'string' || !NAME.test(name)) throw new Refused(`Column names ${NAME_RULE}.`)
  if (RESERVED.has(name)) throw new Refused(`A column cannot be called "${name}". Every table has "id" and "created_at" already, and the other reserved names are ${[...RESERVED].slice(2).join(', ')}.`)
  if (taken.some((column) => column.name === name)) throw new Refused(`The table has a column "${name}" already.`)
  if (typeof type !== 'string' || !Object.hasOwn(TYPES, type)) throw new Refused(`A column's type is one of ${Object.keys(TYPES).join(', ')}.`)
  return { name, type: type as ColumnType }
}

// Checks the changes an app asks for against the tables it has, and turns them
// into statements. Nothing is run here. `tablesOverall` is how many tables all
// apps have together at this moment.
export const plan = (appId: string, existing: Table[], changes: unknown, tablesOverall: number, limits: Limits = LIMITS) => {
  if (!APP_ID.test(appId)) throw new Refused('Unknown app.')
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_CHANGES) throw new Refused(`Send between 1 and ${MAX_CHANGES} changes.`)

  const tables = existing.map((table) => ({ ...table, columns: [...table.columns] }))
  const statements: string[] = []
  for (const raw of changes) {
    const change = record(raw)
    const name = tableNameIn(change.table)
    const found = tables.find((table) => table.name === name)

    if (change.action === 'create_table') {
      if (found) throw new Refused(`There is a table "${name}" already.`)
      if (tables.length >= limits.tablesPerApp) throw new Refused(`An app can have ${limits.tablesPerApp} tables at most.`)
      if (tablesOverall + tables.length - existing.length >= limits.tablesOverall) throw new Refused('The database is full: no more tables can be created at the moment.')
      const mode = change.mode === undefined ? 'append' : change.mode
      if (!MODES.includes(mode as Mode)) throw new Refused(`A table's mode is one of ${MODES.join(', ')}.`)
      if (!Array.isArray(change.columns) || !change.columns.length || change.columns.length > limits.columnsPerTable) throw new Refused(`A table has between 1 and ${limits.columnsPerTable} columns of its own.`)
      const columns: Column[] = []
      for (const column of change.columns) columns.push(columnIn(column, columns))
      const table: Table = { name, mode: mode as Mode, columns }
      tables.push(table)
      statements.push(...createTable(appId, table))
    } else if (change.action === 'add_column') {
      if (!found) throw new Refused(`There is no table "${name}".`)
      if (found.columns.length >= limits.columnsPerTable) throw new Refused(`A table can have ${limits.columnsPerTable} columns of its own at most.`)
      const column = columnIn(change.column, found.columns)
      found.columns.push(column)
      statements.push(...addColumn(appId, found, column))
    } else {
      throw new Refused('A change\'s action is either "create_table" or "add_column".')
    }
  }
  return { tables, statements }
}
