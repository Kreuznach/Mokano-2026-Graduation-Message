-- ─────────────────────────────────────────────────────────────────────────
-- 모카 마지막 라이브(LAST LIVE) 팬 편지 (mokano.live 와 같은 Supabase 프로젝트)
-- 새 객체만 만듭니다. 기존 테이블(fan_messages, events 등)은 건드리지 않습니다.
-- 적용: Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여 넣고 Run
--       (또는 supabase CLI: supabase db push)
-- 여러 번 실행해도 안전하도록 if not exists / or replace 를 사용합니다.
-- ─────────────────────────────────────────────────────────────────────────

-- 1) 편지 본문 테이블 ------------------------------------------------------
create table if not exists public.moka_graduation_letters (
  id uuid primary key default gen_random_uuid(),
  sender_name text,
  content text not null,
  moderation_status text not null default 'pending',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  read_at timestamptz,
  constraint moka_graduation_letters_sender_name_check check (
    sender_name is null
    or (char_length(sender_name) between 1 and 40 and sender_name = btrim(sender_name))
  ),
  -- 최대 2,000줄(개행 1,999개) + UTF-8 256KiB, CR 없음(LF 로 정규화), 공백뿐인 내용 금지
  constraint moka_graduation_letters_content_check check (
    btrim(content, E' \t\n') <> ''
    and position(E'\r' in content) = 0
    and octet_length(content) <= 262144
    and char_length(content) - char_length(replace(content, E'\n', '')) < 2000
  ),
  constraint moka_graduation_letters_moderation_status_check check (
    moderation_status in ('pending', 'approved', 'hidden')
  )
);

comment on table public.moka_graduation_letters is
  '팬이 모카에게 보낸 마지막 라이브 기념 편지. 저장은 서버 API(submit_moka_graduation_letter)로만 합니다.';
comment on column public.moka_graduation_letters.sender_name is 'null 이면 익명으로 표시';
comment on column public.moka_graduation_letters.content is 'plain text 원문 (HTML/Markdown 으로 렌더링하지 않음)';
comment on column public.moka_graduation_letters.reviewed_at is '향후 관리자 검수 시각';
comment on column public.moka_graduation_letters.read_at is '향후 모카의 최초 열람 시각';

create index if not exists moka_graduation_letters_status_created_idx
  on public.moka_graduation_letters (moderation_status, created_at desc);

-- 새 편지는 누가 넣더라도 항상 pending / DB 시각 / 미검수 / 미열람으로 시작
create or replace function public.moka_graduation_letters_enforce_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.moderation_status := 'pending';
  new.created_at := now();
  new.reviewed_at := null;
  new.read_at := null;
  return new;
end;
$$;

revoke all on function public.moka_graduation_letters_enforce_insert() from public, anon, authenticated;

drop trigger if exists moka_graduation_letters_enforce_insert on public.moka_graduation_letters;
create trigger moka_graduation_letters_enforce_insert
  before insert on public.moka_graduation_letters
  for each row execute function public.moka_graduation_letters_enforce_insert();

-- 2) 제출 제한 테이블 (서버 전용, 편지 테이블과 분리) ---------------------
create table if not exists public.moka_graduation_letter_limits (
  browser_hash text primary key,
  last_success_at timestamptz,
  next_allowed_at timestamptz,
  last_idempotency_key uuid,
  last_letter_id uuid references public.moka_graduation_letters (id) on delete set null,
  success_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint moka_graduation_letter_limits_hash_check check (browser_hash ~ '^[0-9a-f]{64}$'),
  constraint moka_graduation_letter_limits_times_check check ((last_success_at is null) = (next_allowed_at is null)),
  constraint moka_graduation_letter_limits_count_check check (success_count >= 0)
);

comment on table public.moka_graduation_letter_limits is
  '브라우저 식별자 해시별 48시간 제출 제한과 중복 요청 처리 정보. 편지 삭제·검수와 무관하게 유지됩니다.';

-- 3) 접근 권한: anon / authenticated 는 두 테이블에 직접 접근 불가 --------
alter table public.moka_graduation_letters enable row level security;
alter table public.moka_graduation_letter_limits enable row level security;

revoke all on table public.moka_graduation_letters from public, anon, authenticated;
revoke all on table public.moka_graduation_letter_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.moka_graduation_letters to service_role;
grant select, insert, update on table public.moka_graduation_letter_limits to service_role;

-- 4) 편지 저장 RPC: 제한 확인 + 저장 + 제한 갱신을 한 트랜잭션에서 처리 -------
create or replace function public.submit_moka_graduation_letter(
  p_browser_hash text,
  p_idempotency_key uuid,
  p_sender_name text,
  p_content text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_limit public.moka_graduation_letter_limits%rowtype;
  v_letter_id uuid;
  v_created_at timestamptz;
  v_next timestamptz;
begin
  if p_browser_hash is null or p_browser_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid browser hash' using errcode = '22023';
  end if;
  if p_idempotency_key is null then
    raise exception 'missing idempotency key' using errcode = '22023';
  end if;

  -- 최초 동시 요청: 고유 키 충돌로 한 행만 생기고, 아래 FOR UPDATE 에서 순서대로 처리됨
  insert into public.moka_graduation_letter_limits (browser_hash)
  values (p_browser_hash)
  on conflict (browser_hash) do nothing;

  select * into v_limit
  from public.moka_graduation_letter_limits
  where browser_hash = p_browser_hash
  for update;

  -- 같은 요청의 재시도(응답 유실 등): 새로 저장하지 않고 기존 성공을 돌려줌
  if v_limit.last_idempotency_key = p_idempotency_key then
    return jsonb_build_object(
      'status', 'replayed',
      'next_allowed_at_ms', ceil(extract(epoch from v_limit.next_allowed_at) * 1000)::bigint,
      'server_now_ms', floor(extract(epoch from v_now) * 1000)::bigint
    );
  end if;

  if v_limit.next_allowed_at is not null and v_limit.next_allowed_at > v_now then
    return jsonb_build_object(
      'status', 'limited',
      'next_allowed_at_ms', ceil(extract(epoch from v_limit.next_allowed_at) * 1000)::bigint,
      'server_now_ms', floor(extract(epoch from v_now) * 1000)::bigint
    );
  end if;

  insert into public.moka_graduation_letters (sender_name, content)
  values (nullif(p_sender_name, ''), p_content)
  returning id, created_at into v_letter_id, v_created_at;

  v_next := v_created_at + interval '48 hours';

  update public.moka_graduation_letter_limits
  set last_success_at = v_created_at,
      next_allowed_at = v_next,
      last_idempotency_key = p_idempotency_key,
      last_letter_id = v_letter_id,
      success_count = success_count + 1,
      updated_at = v_now
  where browser_hash = p_browser_hash;

  return jsonb_build_object(
    'status', 'created',
    'next_allowed_at_ms', ceil(extract(epoch from v_next) * 1000)::bigint,
    'server_now_ms', floor(extract(epoch from v_now) * 1000)::bigint
  );
end;
$$;

-- 5) 작성 가능 상태 조회 RPC -----------------------------------------------
create or replace function public.get_moka_graduation_letter_status(p_browser_hash text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'next_allowed_at_ms', (
      select ceil(extract(epoch from l.next_allowed_at) * 1000)::bigint
      from public.moka_graduation_letter_limits l
      where l.browser_hash = p_browser_hash
        and l.next_allowed_at > now()
    ),
    'server_now_ms', floor(extract(epoch from now()) * 1000)::bigint
  );
$$;

revoke all on function public.submit_moka_graduation_letter(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.get_moka_graduation_letter_status(text) from public, anon, authenticated;
grant execute on function public.submit_moka_graduation_letter(text, uuid, text, text) to service_role;
grant execute on function public.get_moka_graduation_letter_status(text) to service_role;
