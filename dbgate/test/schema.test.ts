import { describe, expect, it } from 'vitest'
import { LIMITS, Refused, plan, type Table } from '../src/schema.js'

const APP = 'abcdefghij234567abcd'
const guestbook = { action: 'create_table', table: 'entries', columns: [{ name: 'author', type: 'text' }, { name: 'stars', type: 'integer' }] }
const refusal = (changes: unknown, existing: Table[] = [], overall = 0) => {
  try {
    plan(APP, existing, changes, overall)
  } catch (error) {
    if (error instanceof Refused) return error.message
    throw error
  }
  return 'accepted'
}

describe('plan', () => {
  it('turns a new table into statements that give visitors reading and adding', () => {
    const { tables, statements } = plan(APP, [], [guestbook], 0)
    expect(tables).toEqual([{ name: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }, { name: 'stars', type: 'integer' }] }])
    expect(statements).toMatchInlineSnapshot(`
      [
        "create table apps."aabcdefghij234567abcd_entries" (id bigint generated always as identity primary key, created_at timestamp with time zone not null default now(), updated_at timestamp with time zone not null default now(), "author" text, "stars" integer)",
        "alter table apps."aabcdefghij234567abcd_entries" enable row level security",
        "create trigger cap before insert or update on apps."aabcdefghij234567abcd_entries" for each row execute function gate.cap()",
        "grant select on apps."aabcdefghij234567abcd_entries" to anon",
        "create policy anon_select on apps."aabcdefghij234567abcd_entries" for select to anon using (true)",
        "grant insert ("author", "stars") on apps."aabcdefghij234567abcd_entries" to anon",
        "create policy anon_insert on apps."aabcdefghij234567abcd_entries" for insert to anon with check (true)",
      ]
    `)
  })

  it('adds changing and deleting for a shared table', () => {
    const { statements } = plan(APP, [], [{ action: 'create_table', table: 'todos', mode: 'shared', columns: [{ name: 'done', type: 'boolean' }, { name: 'due', type: 'timestamp' }] }], 0)
    expect(statements.slice(7)).toMatchInlineSnapshot(`
      [
        "grant update ("done", "due"), delete on apps."aabcdefghij234567abcd_todos" to anon",
        "create policy anon_update on apps."aabcdefghij234567abcd_todos" for update to anon using (true) with check (true)",
        "create policy anon_delete on apps."aabcdefghij234567abcd_todos" for delete to anon using (true)",
      ]
    `)
    expect(statements[0]).toContain('"done" boolean, "due" timestamp with time zone')
  })

  it('adds a column with the rights that fit the table', () => {
    const existing: Table[] = [
      { name: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }] },
      { name: 'todos', mode: 'shared', columns: [{ name: 'done', type: 'boolean' }] },
    ]
    const { tables, statements } = plan(APP, existing, [{ action: 'add_column', table: 'entries', column: { name: 'score', type: 'number' } }, { action: 'add_column', table: 'todos', column: { name: 'day', type: 'date' } }], 2)
    expect(statements).toMatchInlineSnapshot(`
      [
        "alter table apps."aabcdefghij234567abcd_entries" add column "score" double precision",
        "grant insert ("score") on apps."aabcdefghij234567abcd_entries" to anon",
        "alter table apps."aabcdefghij234567abcd_todos" add column "day" date",
        "grant insert ("day"), update ("day") on apps."aabcdefghij234567abcd_todos" to anon",
      ]
    `)
    expect(tables.map((table) => table.columns.length)).toEqual([2, 2])
    expect(existing.map((table) => table.columns.length)).toEqual([1, 1])
  })

  it('hands the changes back with nothing in them but what was checked', () => {
    const { changes } = plan(APP, [], [{ ...guestbook, extra: 'x', columns: [{ name: 'author', type: 'text', comment: 'y' }] }, { action: 'add_column', table: 'entries', column: { name: 'note', type: 'text', z: 1 }, more: true }], 0)
    expect(changes).toEqual([
      { action: 'create_table', table: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }] },
      { action: 'add_column', table: 'entries', column: { name: 'note', type: 'text' } },
    ])
  })

  it('lets a later change build on an earlier one', () => {
    const { tables } = plan(APP, [], [guestbook, { action: 'add_column', table: 'entries', column: { name: 'note', type: 'text' } }], 0)
    expect(tables[0]!.columns.map((column) => column.name)).toEqual(['author', 'stars', 'note'])
  })

  it('refuses names that are not plain lowercase identifiers', () => {
    for (const table of ['Entries', '1st', 'a-b', 'a b', 'x"; drop table apps.heartbeat; --', 'a'.repeat(31), '', 7, null, undefined]) expect(refusal([{ ...guestbook, table }])).toMatch(/^Table names start with/)
    for (const name of ['Author', '_x', 'a.b', 'a"b', 'é', 'a'.repeat(31), '', 7, null]) expect(refusal([{ ...guestbook, columns: [{ name, type: 'text' }] }])).toMatch(/^Column names start with/)
  })

  it('refuses column names that are taken or that the Data API reads as parameters', () => {
    for (const name of ['id', 'created_at', 'updated_at', 'select', 'order', 'limit', 'offset', 'columns', 'on_conflict', 'and', 'or', 'not']) expect(refusal([{ ...guestbook, columns: [{ name, type: 'text' }] }])).toMatch(/^A column cannot be called/)
    expect(refusal([{ ...guestbook, columns: [{ name: 'a', type: 'text' }, { name: 'a', type: 'date' }] }])).toMatch(/has a column "a" already/)
    expect(refusal([guestbook, { action: 'add_column', table: 'entries', column: { name: 'author', type: 'text' } }])).toMatch(/has a column "author" already/)
  })

  it('refuses types and modes outside the fixed lists', () => {
    for (const type of ['varchar', 'text; drop table x', 'TEXT', 'toString', '__proto__', '', 1, null, undefined]) expect(refusal([{ ...guestbook, columns: [{ name: 'a', type }] }])).toMatch(/^A column's type is one of text, integer, number, boolean, timestamp, date/)
    for (const mode of ['private', 'read', '', 1, null]) expect(refusal([{ ...guestbook, mode }])).toMatch(/^A table's mode is one of append, shared/)
  })

  it('refuses more tables or columns than an app may have', () => {
    const three = ['one', 'two', 'three'].map((table) => ({ ...guestbook, table }))
    expect(refusal(three)).toBe('accepted')
    expect(refusal([...three, { ...guestbook, table: 'four' }])).toMatch(/3 tables at most/)
    const columns = Array.from({ length: LIMITS.columnsPerTable }, (_, index) => ({ name: `c${index}`, type: 'text' }))
    expect(refusal([{ ...guestbook, columns }])).toBe('accepted')
    expect(refusal([{ ...guestbook, columns: [...columns, { name: 'more', type: 'text' }] }])).toMatch(/between 1 and 12 columns/)
    expect(refusal([{ ...guestbook, columns }, { action: 'add_column', table: 'entries', column: { name: 'more', type: 'text' } }])).toMatch(/12 columns of its own at most/)
    expect(refusal([{ ...guestbook, columns: [] }])).toMatch(/between 1 and 12 columns/)
    expect(refusal([{ ...guestbook, columns: 'author' }])).toMatch(/between 1 and 12 columns/)
  })

  it('refuses a table once all apps together have as many as fit', () => {
    expect(refusal([guestbook], [], LIMITS.tablesOverall - 1)).toBe('accepted')
    expect(refusal([guestbook], [], LIMITS.tablesOverall)).toMatch(/database is full/)
    expect(refusal([guestbook, { ...guestbook, table: 'second' }], [], LIMITS.tablesOverall - 1)).toMatch(/database is full/)
    const existing: Table[] = [{ name: 'entries', mode: 'append', columns: [{ name: 'author', type: 'text' }] }]
    expect(refusal([{ action: 'add_column', table: 'entries', column: { name: 'note', type: 'text' } }], existing, LIMITS.tablesOverall)).toBe('accepted')
  })

  it('refuses a table that exists and a column for one that does not', () => {
    expect(refusal([guestbook, guestbook])).toMatch(/There is a table "entries" already/)
    expect(refusal([{ action: 'add_column', table: 'missing', column: { name: 'a', type: 'text' } }])).toMatch(/There is no table "missing"/)
  })

  it('refuses anything that is not a list of known changes', () => {
    for (const changes of [undefined, null, {}, 'create_table', [], Array.from({ length: 41 }, () => guestbook)]) expect(refusal(changes)).toMatch(/^Send between 1 and 40 changes/)
    for (const change of [null, 'x', 3, []]) expect(refusal([change])).toMatch(/^Each change is an object/)
    for (const action of ['drop_table', 'delete', '', undefined]) expect(refusal([{ ...guestbook, action }])).toMatch(/either "create_table" or "add_column"/)
    expect(() => plan('../etc', [], [guestbook], 0)).toThrow('Unknown app.')
  })

  it('never repeats input that failed a check', () => {
    const hostile = 'x"; drop table apps.heartbeat; --'
    for (const changes of [[{ ...guestbook, table: hostile }], [{ ...guestbook, columns: [{ name: hostile, type: 'text' }] }], [{ ...guestbook, columns: [{ name: 'a', type: hostile }] }], [{ ...guestbook, mode: hostile }], [{ ...guestbook, action: hostile }]]) expect(refusal(changes)).not.toContain('drop')
  })
})
