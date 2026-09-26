import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION_URL = new URL('../../supabase/migrations/20260926000000_create_moka_graduation_letters.sql', import.meta.url);
const ADMIN_MIGRATION_URL = new URL('../../supabase/migrations/20260926000100_moka_graduation_letters_admin_policies.sql', import.meta.url);

// mokano.live(Pink-Queen-Reigns)의 001_initial_schema.sql profiles + rls.sql is_admin() 과 같은 형태
const MOKANO_LIVE_AUTH_SQL = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  create table if not exists public.profiles (
    id uuid primary key,
    email text not null,
    role text not null default 'viewer' check (role in ('admin', 'viewer'))
  );
  alter table public.profiles enable row level security;
  create or replace function is_admin()
  returns boolean language plpgsql security definer stable as $$
  begin
    return exists(select 1 from public.profiles where id = auth.uid() and role = 'admin');
  end;
  $$;
`;

// Supabase 의 기본 역할과 기본 권한(anon/authenticated 에 자동 부여)을 흉내 낸 뒤 마이그레이션을 적용
export async function createTestDb(options = {}) {
  const db = new PGlite(options.dataDir);
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  await db.exec(readFileSync(MIGRATION_URL, 'utf8'));
  if (options.withAdminPolicies) {
    await db.exec(MOKANO_LIVE_AUTH_SQL);
    await db.exec(readFileSync(ADMIN_MIGRATION_URL, 'utf8'));
  }
  return db;
}

// 로그인한 사용자(authenticated + JWT sub)로 실행
export async function asUser(db, userId, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await tx.exec('set local role authenticated');
    return tx.query(sql, params);
  });
}

export async function asRole(db, role, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    return tx.query(sql, params);
  });
}

const RPC_SQL = {
  submit_moka_graduation_letter:
    'select public.submit_moka_graduation_letter($1, $2::uuid, $3, $4) as result',
  get_moka_graduation_letter_status: 'select public.get_moka_graduation_letter_status($1) as result',
};

const RPC_ARGS = {
  submit_moka_graduation_letter: (a) => [a.p_browser_hash, a.p_idempotency_key, a.p_sender_name, a.p_content],
  get_moka_graduation_letter_status: (a) => [a.p_browser_hash],
};

// PostgREST 의 /rest/v1/rpc/<name> 호출을 service_role 로 흉내 냄
export function makeRpc(db) {
  return async function rpc(name, args) {
    if (!RPC_SQL[name]) throw new Error(`unknown rpc ${name}`);
    const res = await asRole(db, 'service_role', RPC_SQL[name], RPC_ARGS[name](args));
    return res.rows[0].result;
  };
}
