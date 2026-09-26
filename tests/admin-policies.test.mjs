import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, asRole, asUser, makeRpc } from './helpers/db.mjs';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const VIEWER = '00000000-0000-4000-8000-000000000002';

test('mokano.live 관리자 정책 (선택 마이그레이션)', async (t) => {
  const db = await createTestDb({ withAdminPolicies: true });
  await db.query(
    "insert into public.profiles (id, email, role) values ($1, 'admin@example.com', 'admin'), ($2, 'fan@example.com', 'viewer')",
    [ADMIN, VIEWER],
  );
  const rpc = makeRpc(db);
  await rpc('submit_moka_graduation_letter', {
    p_browser_hash: 'a'.repeat(64), p_idempotency_key: crypto.randomUUID(), p_sender_name: '모카팬', p_content: '고마워 🥹',
  });
  const denied = /permission denied|violates row-level security/;

  await t.test('관리자(profiles.role=admin): 조회 가능, 검수 상태·열람 시각 변경 가능', async () => {
    const rows = (await asUser(db, ADMIN, 'select id, content, moderation_status from public.moka_graduation_letters')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, '고마워 🥹');
    const upd = await asUser(db, ADMIN,
      "update public.moka_graduation_letters set moderation_status = 'approved', reviewed_at = now(), read_at = now() returning moderation_status");
    assert.equal(upd.rows[0].moderation_status, 'approved');
  });

  await t.test('관리자도 본문·이름 수정, 추가, 삭제, 제한 테이블 접근은 불가', async () => {
    await assert.rejects(asUser(db, ADMIN, "update public.moka_graduation_letters set content = '변경'"), denied);
    await assert.rejects(asUser(db, ADMIN, "update public.moka_graduation_letters set sender_name = '변경'"), denied);
    await assert.rejects(asUser(db, ADMIN, "insert into public.moka_graduation_letters (content) values ('x')"), denied);
    await assert.rejects(asUser(db, ADMIN, 'delete from public.moka_graduation_letters'), denied);
    await assert.rejects(asUser(db, ADMIN, 'select * from public.moka_graduation_letter_limits'), denied);
  });

  await t.test('로그인한 일반 사용자(viewer): 아무 행도 보이지 않고 바꿀 수 없음', async () => {
    assert.equal((await asUser(db, VIEWER, 'select * from public.moka_graduation_letters')).rows.length, 0);
    const upd = await asUser(db, VIEWER, "update public.moka_graduation_letters set moderation_status = 'hidden' returning id");
    assert.equal(upd.rows.length, 0);
    const row = (await db.query('select moderation_status from public.moka_graduation_letters')).rows[0];
    assert.equal(row.moderation_status, 'approved');
  });

  await t.test('anon: 여전히 접근 불가', async () => {
    await assert.rejects(asRole(db, 'anon', 'select * from public.moka_graduation_letters'), denied);
  });

  await db.close();
});
