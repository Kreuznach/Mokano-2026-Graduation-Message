import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, asRole, makeRpc } from './helpers/db.mjs';

const hash = (c) => c.repeat(64);
const uuid = () => crypto.randomUUID();
const submit = (rpc, h, key, content, name = null) =>
  rpc('submit_moka_graduation_letter', { p_browser_hash: h, p_idempotency_key: key, p_sender_name: name, p_content: content });

async function count(db, table = 'moka_graduation_letters') {
  return Number((await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n);
}

async function rejects(promise, pattern) {
  await assert.rejects(promise, (err) => pattern.test(err.message));
}

test('DB 편지 저장과 48시간 제한', async (t) => {
  const db = await createTestDb();
  const rpc = makeRpc(db);

  await t.test('익명(null) 저장, 한글·일본어·이모지·개행 보존, 항상 pending', async () => {
    const content = '모카야 고마워\nありがとう、モカ\n🥹💜✨\n\n<script>alert(1)</script>';
    const r = await submit(rpc, hash('a'), uuid(), content);
    assert.equal(r.status, 'created');
    const row = (await db.query('select * from public.moka_graduation_letters')).rows[0];
    assert.equal(row.sender_name, null);
    assert.equal(row.content, content);
    assert.equal(row.moderation_status, 'pending');
    assert.equal(row.reviewed_at, null);
    assert.equal(row.read_at, null);
    // 다음 작성 가능 시각 = DB 저장 시각 + 정확히 48시간
    assert.equal(Number(r.next_allowed_at_ms) - new Date(row.created_at).getTime(), 48 * 3600 * 1000);
  });

  await t.test('같은 idempotency key 재시도는 저장 없이 replayed', async () => {
    const key = uuid();
    const first = await submit(rpc, hash('b'), key, '첫 편지');
    const again = await submit(rpc, hash('b'), key, '첫 편지');
    assert.equal(first.status, 'created');
    assert.equal(again.status, 'replayed');
    assert.equal(again.next_allowed_at_ms, first.next_allowed_at_ms);
    const n = (await db.query("select count(*)::int as n from public.moka_graduation_letters where content = '첫 편지'")).rows[0].n;
    assert.equal(n, 1);
  });

  await t.test('다른 key 로 48시간 안에 다시 보내면 limited, 제한은 늘어나지 않음', async () => {
    const before = await count(db);
    const first = (await db.query("select next_allowed_at from public.moka_graduation_letter_limits where browser_hash = $1", [hash('b')])).rows[0];
    const r = await submit(rpc, hash('b'), uuid(), '두 번째');
    assert.equal(r.status, 'limited');
    assert.equal(await count(db), before);
    const after = (await db.query("select next_allowed_at from public.moka_graduation_letter_limits where browser_hash = $1", [hash('b')])).rows[0];
    assert.equal(after.next_allowed_at.getTime(), first.next_allowed_at.getTime());
  });

  await t.test('48시간 경계: 1초 전은 limited, 도달하면 created', async () => {
    const h = hash('c');
    await submit(rpc, h, uuid(), '경계 테스트');
    // 실제로 기다리지 않고 DB 시각 기준으로 제한 시각을 옮김
    await db.query("update public.moka_graduation_letter_limits set next_allowed_at = now() + interval '1 second', last_success_at = now() + interval '1 second' - interval '48 hours' where browser_hash = $1", [h]);
    assert.equal((await submit(rpc, h, uuid(), '1초 전')).status, 'limited');
    await db.query("update public.moka_graduation_letter_limits set next_allowed_at = now(), last_success_at = now() - interval '48 hours' where browser_hash = $1", [h]);
    assert.equal((await submit(rpc, h, uuid(), '도달')).status, 'created');
  });

  await t.test('동시 요청(최초 제출, 서로 다른 key)에서도 한 건만 저장', async () => {
    const h = hash('d');
    const results = await Promise.all([1, 2, 3, 4].map((i) => submit(rpc, h, uuid(), `동시 ${i}`)));
    assert.deepEqual(results.map((r) => r.status).sort(), ['created', 'limited', 'limited', 'limited']);
    const n = (await db.query("select count(*)::int as n from public.moka_graduation_letters where content like '동시 %'")).rows[0].n;
    assert.equal(n, 1);
  });

  await t.test('저장 실패(제약 위반)는 롤백되어 제한이 시작되지 않음', async () => {
    const h = hash('e');
    await rejects(submit(rpc, h, uuid(), '   '), /check constraint/);
    await rejects(submit(rpc, h, uuid(), 'a\r\nb'), /check constraint/);
    await rejects(submit(rpc, h, uuid(), `${'x\n'.repeat(2000)}x`), /check constraint/);
    await rejects(submit(rpc, h, uuid(), 'a'.repeat(262145)), /check constraint/);
    await rejects(submit(rpc, h, uuid(), '내용', '가'.repeat(41)), /check constraint/);
    const limit = await db.query('select * from public.moka_graduation_letter_limits where browser_hash = $1', [h]);
    assert.equal(limit.rows.length, 0);
    assert.equal((await submit(rpc, h, uuid(), `${'x\n'.repeat(1999)}x`, '가'.repeat(40))).status, 'created');
  });

  await t.test('잘못된 식별자 해시·key 는 거절', async () => {
    await rejects(submit(rpc, 'not-a-hash', uuid(), '내용'), /invalid browser hash/);
    await rejects(submit(rpc, hash('f'), null, '내용'), /missing idempotency key/);
  });

  await t.test('검수 상태 변경·편지 삭제가 제출 제한을 초기화하지 않음', async () => {
    const h = hash('1');
    await submit(rpc, h, uuid(), '지워질 편지');
    await db.query("update public.moka_graduation_letters set moderation_status = 'hidden' where content = '지워질 편지'");
    await db.query("delete from public.moka_graduation_letters where content = '지워질 편지'");
    const limit = (await db.query('select * from public.moka_graduation_letter_limits where browser_hash = $1', [h])).rows[0];
    assert.equal(limit.last_letter_id, null);
    assert.ok(limit.next_allowed_at > new Date());
    assert.equal((await submit(rpc, h, uuid(), '또 보내기')).status, 'limited');
  });

  await t.test('service role 이 직접 넣어도 검수 상태·시각은 강제로 초기값', async () => {
    await asRole(db, 'service_role',
      "insert into public.moka_graduation_letters (content, moderation_status, created_at, read_at, reviewed_at) values ('직접', 'approved', '2000-01-01', now(), now())");
    const row = (await db.query("select * from public.moka_graduation_letters where content = '직접'")).rows[0];
    assert.equal(row.moderation_status, 'pending');
    assert.equal(row.read_at, null);
    assert.equal(row.reviewed_at, null);
    assert.ok(row.created_at.getFullYear() >= 2025);
  });

  await t.test('상태 조회 RPC: 제한 중이면 시각, 아니면 null', async () => {
    const limited = await rpc('get_moka_graduation_letter_status', { p_browser_hash: hash('b') });
    assert.ok(Number(limited.next_allowed_at_ms) > Number(limited.server_now_ms));
    const fresh = await rpc('get_moka_graduation_letter_status', { p_browser_hash: hash('9') });
    assert.equal(fresh.next_allowed_at_ms, null);
  });

  for (const role of ['anon', 'authenticated']) {
    await t.test(`${role}: 편지·제한 테이블 조회/삽입/수정/삭제와 RPC 실행 불가`, async () => {
      const denied = /permission denied/;
      await rejects(asRole(db, role, 'select * from public.moka_graduation_letters'), denied);
      await rejects(asRole(db, role, "insert into public.moka_graduation_letters (content) values ('x')"), denied);
      await rejects(asRole(db, role, "update public.moka_graduation_letters set moderation_status = 'approved'"), denied);
      await rejects(asRole(db, role, 'delete from public.moka_graduation_letters'), denied);
      await rejects(asRole(db, role, 'select * from public.moka_graduation_letter_limits'), denied);
      await rejects(asRole(db, role, 'delete from public.moka_graduation_letter_limits'), denied);
      await rejects(asRole(db, role, `select public.submit_moka_graduation_letter('${hash('7')}', gen_random_uuid(), null, 'x')`), denied);
      await rejects(asRole(db, role, `select public.get_moka_graduation_letter_status('${hash('7')}')`), denied);
    });
  }

  await t.test('마이그레이션을 다시 실행해도 안전', async () => {
    const before = await count(db);
    const { readFileSync } = await import('node:fs');
    await db.exec(readFileSync(new URL('../supabase/migrations/20260926000000_create_moka_graduation_letters.sql', import.meta.url), 'utf8'));
    assert.equal(await count(db), before);
  });

  await db.close();
});
