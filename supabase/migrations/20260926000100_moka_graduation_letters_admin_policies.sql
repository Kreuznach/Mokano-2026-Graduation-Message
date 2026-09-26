-- ─────────────────────────────────────────────────────────────────────────
-- (선택) mokano.live 관리자 화면에서 편지를 검수·열람할 수 있게 하는 정책
-- mokano.live 의 실제 관리자 판단 방식(public.profiles.role = 'admin' → public.is_admin())을 그대로 씁니다.
-- 먼저 20260926000000_create_moka_graduation_letters.sql 을 실행하고,
-- mokano.live 의 supabase/rls.sql(= is_admin() 생성)이 적용된 DB 에서만 실행하세요.
-- 로그인만 한 일반 사용자(viewer)는 여전히 아무것도 볼 수 없습니다.
-- ─────────────────────────────────────────────────────────────────────────

-- 관리자는 편지를 읽고, 검수 상태·검수 시각·열람 시각만 바꿀 수 있음 (본문·이름·작성 시각 수정, 추가, 삭제는 불가)
grant select on table public.moka_graduation_letters to authenticated;
grant update (moderation_status, reviewed_at, read_at) on table public.moka_graduation_letters to authenticated;

drop policy if exists "moka_graduation_letters_select_admin" on public.moka_graduation_letters;
drop policy if exists "moka_graduation_letters_update_admin" on public.moka_graduation_letters;

create policy "moka_graduation_letters_select_admin"
  on public.moka_graduation_letters for select
  to authenticated
  using (public.is_admin());

create policy "moka_graduation_letters_update_admin"
  on public.moka_graduation_letters for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 제출 제한 테이블(moka_graduation_letter_limits)은 계속 서버(service_role) 전용입니다.
