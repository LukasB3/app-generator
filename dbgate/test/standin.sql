-- The parts of a Supabase database that the setup script and the gateway lean
-- on, for the plain Postgres the tests run against.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text not null, created_at timestamptz not null default now(), last_sign_in_at timestamptz);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users on delete cascade, created_at timestamptz, updated_at timestamptz, refreshed_at timestamp);
insert into auth.users (email) values ('someone@example.com');
grant usage on schema auth to service_role;
grant select on auth.users to service_role;
