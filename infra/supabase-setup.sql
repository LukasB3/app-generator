-- What the Supabase project's database needs beyond what Supabase brings along.
-- Run it as `postgres`, for example in the SQL editor. Running it again is safe.
--
-- One thing is not in here: the password of the gateway's role. The server
-- makes it, and `infra/gate-role.mjs` there prints the statement that sets it.

-- `apps` is the only schema the Data API exposes (Settings, Data API). It holds
-- the tables of the generated apps, which the database gateway creates, and
-- one table of the app generator's own. Visitors of an app arrive as `anon`.
create schema if not exists apps;
grant usage on schema apps to anon;

-- Read once an hour by the orchestrator. A free project is paused after a
-- week without requests, and logging in would stop with it.
create table if not exists apps.heartbeat (
  id int primary key default 1 check (id = 1),
  note text not null default 'read hourly by the app generator'
);
insert into apps.heartbeat default values on conflict do nothing;
alter table apps.heartbeat enable row level security;
grant select on apps.heartbeat to anon;
drop policy if exists heartbeat_read on apps.heartbeat;
create policy heartbeat_read on apps.heartbeat for select to anon using (true);

-- Not needed, and one more way to query the database with the public key.
drop extension if exists pg_graphql;

-- Helpers the Data API must not offer.
create schema if not exists gate;

-- The role the database gateway logs in as. Its rights end at `apps`, where
-- it creates the tables: it belongs to no other role, so it has no way to the
-- accounts in `auth` or to anything `postgres` owns. The gateway checks this
-- about itself before it does any work (dbgate/src/db.ts).
do $$
begin
  if not exists (select from pg_roles where rolname = 'ag_gate') then
    create role ag_gate login noinherit nocreatedb nocreaterole nobypassrls noreplication connection limit 3;
  end if;
end $$;
alter role ag_gate set statement_timeout = '5s';
alter role ag_gate set idle_in_transaction_session_timeout = '15s';
grant usage, create on schema apps to ag_gate;
grant usage on schema gate to ag_gate;

-- On every table of a generated app, as a trigger: a row holds 2 kB at most
-- and a table 500 rows. Whoever writes to such a table has the public key and
-- nothing else, so these caps are what bounds the space an app can take.
-- The function runs with the rights of the writer; it does not need more.
-- It also stamps each row with the time of the write, which is how an open
-- page notices that something changed without reading the whole table.
create or replace function gate.cap() returns trigger language plpgsql set search_path = '' as $$
declare
  n bigint;
begin
  new.updated_at := clock_timestamp();
  if octet_length(new::text) > 2048 then
    raise exception 'row too large';
  end if;
  if tg_op = 'INSERT' then
    -- One insert at a time per table, or two at once could both see row 499.
    perform pg_advisory_xact_lock(tg_relid::bigint);
    execute format('select count(*) from %I.%I', tg_table_schema, tg_table_name) into n;
    if n >= 500 then
      raise exception 'table is full';
    end if;
  end if;
  return new;
end $$;
revoke all on function gate.cap() from public;
grant execute on function gate.cap() to ag_gate;
