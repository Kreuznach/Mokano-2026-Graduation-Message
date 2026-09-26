import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, makeRpc } from './helpers/db.mjs';
import { handleStatus, handleSubmit, createSupabaseRpc, COOKIE_NAME, MAX_BODY_BYTES } from '../server/letters-api.js';

const ORIGIN = 'https://letters.example';
const ENV = {
  SUPABASE_URL: 'https://project.supabase.example',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-never-leaks',
  LETTER_COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef-0123456789',
};

function cookieFrom(res) {
  const set = res.headers.get('Set-Cookie') || '';
  const m = new RegExp(`${COOKIE_NAME}=([^;]+)`).exec(set);
  return m ? `${COOKIE_NAME}=${m[1]}` : null;
}

function post(body, { cookie, origin = ORIGIN, contentType = 'application/json', headers = {} } = {}) {
  const h = { 'Content-Type': contentType, ...headers };
  if (origin) h.Origin = origin;
  if (cookie) h.Cookie = cookie;
  return new Request(`${ORIGIN}/api/letters`, {
    method: 'POST',
    headers: h,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const getStatus = (cookie) =>
  new Request(`${ORIGIN}/api/letters/status`, { headers: cookie ? { Cookie: cookie } : {} });

test('API: 제출·제한·재시도·보안', async (t) => {
  const db = await createTestDb();
  const deps = { rpc: makeRpc(db) };
  const letters = async () => (await db.query('select * from public.moka_graduation_letters order by created_at')).rows;

  let cookie;

  await t.test('처음 상태 조회: HttpOnly·SameSite=Lax·Secure 쿠키 발급, 작성 가능', async () => {
    const res = await handleStatus(getStatus(), ENV, deps);
    assert.equal(res.status, 200);
    const set = res.headers.get('Set-Cookie');
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Lax/);
    assert.match(set, /Secure/);
    assert.match(set, /Path=\/api\/letters/);
    assert.match(set, /Max-Age=34560000/);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.equal(body.canSubmit, true);
    assert.equal(body.nextAllowedAt, null);
    cookie = cookieFrom(res);
    assert.ok(cookie);
  });

  await t.test('다른 Origin / Origin 없음 / cross-site / JSON 아님은 거절', async () => {
    const body = { content: '안녕', idempotencyKey: crypto.randomUUID() };
    assert.equal((await handleSubmit(post(body, { cookie, origin: 'https://evil.example' }), ENV, deps)).status, 403);
    assert.equal((await handleSubmit(post(body, { cookie, origin: null }), ENV, deps)).status, 403);
    assert.equal((await handleSubmit(post(body, { cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } }), ENV, deps)).status, 403);
    assert.equal((await handleSubmit(post(body, { cookie, contentType: 'text/plain' }), ENV, deps)).status, 415);
    assert.equal((await letters()).length, 0);
  });

  await t.test('서버 서명이 없거나 위조된 쿠키는 저장하지 않고 428', async () => {
    const body = { content: '안녕', idempotencyKey: crypto.randomUUID() };
    const noCookie = await handleSubmit(post(body), ENV, deps);
    assert.equal(noCookie.status, 428);
    assert.ok(cookieFrom(noCookie));
    const forged = `${COOKIE_NAME}=v1.${'A'.repeat(43)}.${'B'.repeat(43)}`;
    assert.equal((await handleSubmit(post(body, { cookie: forged }), ENV, deps)).status, 428);
    const [, id] = cookie.split('=')[1].split('.');
    const tampered = `${COOKIE_NAME}=v1.${id.slice(0, -1)}${id.endsWith('A') ? 'B' : 'A'}.${cookie.split('.')[2]}`;
    assert.equal((await handleSubmit(post(body, { cookie: tampered }), ENV, deps)).status, 428);
    assert.equal((await letters()).length, 0);
  });

  await t.test('허용하지 않은 필드(검수 상태 등)·잘못된 key·깨진 JSON 은 400', async () => {
    const key = crypto.randomUUID();
    for (const body of [
      { content: '안녕', idempotencyKey: key, moderation_status: 'approved' },
      { content: '안녕', idempotencyKey: key, created_at: '2000-01-01' },
      { content: '안녕', idempotencyKey: 'not-a-uuid' },
      { content: '안녕' },
      '{"content":',
      '[]',
    ]) {
      const res = await handleSubmit(post(body, { cookie }), ENV, deps);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await letters()).length, 0);
  });

  await t.test('유효성: 클라이언트와 같은 코드로 거절 (2,001줄, 256KiB 초과, 공백뿐, 41자 이름)', async () => {
    const cases = [
      [{ content: Array(2001).fill('줄').join('\n') }, { content: 'content_too_many_lines' }],
      [{ content: 'a'.repeat(262145) }, { content: 'content_too_large' }],
      [{ content: ' \n\t\u3000' }, { content: 'content_required' }],
      [{ content: '안녕', senderName: '가'.repeat(41) }, { senderName: 'name_too_long' }],
    ];
    for (const [fields, expected] of cases) {
      const res = await handleSubmit(post({ ...fields, idempotencyKey: crypto.randomUUID() }, { cookie }), ENV, deps);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, 'validation_failed');
      assert.deepEqual(body.fields, expected);
    }
    // 실패는 48시간 제한을 시작하지 않음
    const status = await (await handleStatus(getStatus(cookie), ENV, deps)).json();
    assert.equal(status.canSubmit, true);
  });

  await t.test('본문 크기 상한은 파싱 전에 413', async () => {
    const big = JSON.stringify({ content: 'a'.repeat(MAX_BODY_BYTES), idempotencyKey: crypto.randomUUID() });
    assert.equal((await handleSubmit(post(big, { cookie }), ENV, deps)).status, 413);
    const lying = post(big, { cookie, headers: { 'Content-Length': '10' } });
    assert.equal((await handleSubmit(lying, ENV, deps)).status, 413);
  });

  const key = crypto.randomUUID();
  let firstNext;
  const content = '모카에게\r\n\r\nありがとう 🥹💜\n<img src=x onerror=alert(1)>';

  await t.test('정상 저장: 201, 응답에는 최소 정보만 (원문·키 없음)', async () => {
    const res = await handleSubmit(post({ senderName: '   ', content, idempotencyKey: key }, { cookie }), ENV, deps);
    assert.equal(res.status, 201);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), ['nextAllowedAt', 'ok', 'serverNow', 'status']);
    assert.equal(body.status, 'created');
    assert.ok(!text.includes('ありがとう') && !text.includes(ENV.SUPABASE_SERVICE_ROLE_KEY));
    firstNext = body.nextAllowedAt;
    const rows = await letters();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sender_name, null);
    assert.equal(rows[0].content, '모카에게\n\nありがとう 🥹💜\n<img src=x onerror=alert(1)>');
    assert.equal(Date.parse(firstNext) - rows[0].created_at.getTime(), 48 * 3600 * 1000);
  });

  await t.test('응답 유실 후 같은 key 재시도 → 200 replayed, 한 건만 저장', async () => {
    const res = await handleSubmit(post({ senderName: '', content, idempotencyKey: key }, { cookie }), ENV, deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'replayed');
    assert.equal(body.nextAllowedAt, firstNext);
    assert.equal((await letters()).length, 1);
  });

  await t.test('새로고침/다른 탭(같은 쿠키): 상태 조회도 제한 중', async () => {
    const body = await (await handleStatus(getStatus(cookie), ENV, deps)).json();
    assert.equal(body.canSubmit, false);
    assert.equal(body.nextAllowedAt, firstNext);
  });

  await t.test('다른 key 로 다시 보내면 429 + Retry-After (남은 시간 이하)', async () => {
    const res = await handleSubmit(post({ content: '또 편지', idempotencyKey: crypto.randomUUID() }, { cookie }), ENV, deps);
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.code, 'rate_limited');
    assert.equal(body.nextAllowedAt, firstNext);
    const retryAfter = Number(res.headers.get('Retry-After'));
    const left = (Date.parse(firstNext) - Date.parse(body.serverNow)) / 1000;
    assert.ok(retryAfter >= 1 && retryAfter <= Math.ceil(left) && retryAfter > 48 * 3600 - 60);
    assert.equal((await letters()).length, 1);
  });

  await t.test('같은 쿠키로 동시에 여러 번 보내도 한 건만 저장', async () => {
    const res = await handleStatus(getStatus(), ENV, deps);
    const other = cookieFrom(res);
    const results = await Promise.all([1, 2, 3].map((i) =>
      handleSubmit(post({ content: `동시 ${i}`, idempotencyKey: crypto.randomUUID() }, { cookie: other }), ENV, deps)));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 429, 429]);
    assert.equal((await letters()).length, 2);
  });

  await t.test('DB 오류는 503, 로그에 원문·키가 남지 않음', async () => {
    const logs = [];
    const original = console.error;
    console.error = (...args) => logs.push(JSON.stringify(args));
    try {
      const failing = { rpc: async () => { const e = new Error('boom'); e.status = 500; throw e; } };
      const res = await handleSubmit(post({ content: '비밀 원문', idempotencyKey: crypto.randomUUID() }, { cookie }), ENV, failing);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'storage_unavailable');
    } finally {
      console.error = original;
    }
    const joined = logs.join('\n');
    assert.ok(logs.length > 0);
    assert.ok(!joined.includes('비밀 원문') && !joined.includes(ENV.SUPABASE_SERVICE_ROLE_KEY) && !joined.includes(ENV.LETTER_COOKIE_SECRET));
  });

  await t.test('서버 설정이 없으면 500 (저장 시도 안 함)', async () => {
    const res = await handleSubmit(post({ content: 'x', idempotencyKey: crypto.randomUUID() }, { cookie }), {}, deps);
    assert.equal(res.status, 500);
  });

  await t.test('http(로컬)에서는 Secure 없이 발급', async () => {
    const res = await handleStatus(new Request('http://localhost:8788/api/letters/status'), ENV, deps);
    assert.doesNotMatch(res.headers.get('Set-Cookie'), /Secure/);
  });

  await db.close();
});

test('Supabase RPC 호출: 서버 키는 헤더로만 보내고 URL·본문에 넣지 않음', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ status: 'created', next_allowed_at_ms: 1, server_now_ms: 0 }), { status: 200 });
  };
  const legacy = createSupabaseRpc({ supabaseUrl: 'https://p.supabase.co', serviceKey: 'eyJlegacy' }, fakeFetch);
  await legacy('submit_moka_graduation_letter', { p_content: 'x' });
  const secret = createSupabaseRpc({ supabaseUrl: 'https://p.supabase.co', serviceKey: 'sb_secret_abc' }, fakeFetch);
  await secret('get_moka_graduation_letter_status', { p_browser_hash: 'h' });

  assert.equal(calls[0].url, 'https://p.supabase.co/rest/v1/rpc/submit_moka_graduation_letter');
  assert.equal(calls[0].init.headers.apikey, 'eyJlegacy');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer eyJlegacy');
  assert.equal(calls[1].init.headers.apikey, 'sb_secret_abc');
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.ok(!calls[0].init.body.includes('eyJlegacy'));
});
