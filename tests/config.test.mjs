import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStatus, handleSubmit, findConfigProblem, describeRpcConfigError, COOKIE_NAME } from '../server/letters-api.js';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeJwt = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig-never-leaks`;
const SECRET = 'test-cookie-secret-0123456789abcdef-0123456789';
const URL_MOKANO = 'https://jkgltyppzkpcssfnxypl.supabase.co';

function captureErrors(fn) {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  return Promise.resolve(fn()).then((r) => ({ r, logs }), (e) => { throw e; }).finally(() => { console.error = original; });
}

test('설정 검사: 다른 프로젝트의 service_role 키를 찾아냄', () => {
  const env = {
    SUPABASE_URL: URL_MOKANO,
    SUPABASE_SERVICE_ROLE_KEY: fakeJwt({ ref: 'asqspnhawbngzrlkqxum', role: 'service_role' }),
    LETTER_COOKIE_SECRET: SECRET,
  };
  assert.match(findConfigProblem(env), /belongs to project "asqspnhawbngzrlkqxum" but SUPABASE_URL is project "jkgltyppzkpcssfnxypl"/);
});

test('설정 검사: anon 키·publishable 키·빈 값·짧은 비밀값', () => {
  const base = { SUPABASE_URL: URL_MOKANO, LETTER_COOKIE_SECRET: SECRET };
  assert.match(findConfigProblem({ ...base, SUPABASE_SERVICE_ROLE_KEY: fakeJwt({ ref: 'jkgltyppzkpcssfnxypl', role: 'anon' }) }), /role "anon"/);
  assert.match(findConfigProblem({ ...base, SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_abc' }), /publishable/);
  assert.match(findConfigProblem({ ...base, SUPABASE_SERVICE_ROLE_KEY: 'not-a-key' }), /not a valid key/);
  assert.match(findConfigProblem({ SUPABASE_URL: URL_MOKANO, LETTER_COOKIE_SECRET: SECRET }), /missing SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(findConfigProblem({ ...base, LETTER_COOKIE_SECRET: 'short', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x' }), /shorter than 32/);
  assert.equal(findConfigProblem({ ...base, SUPABASE_SERVICE_ROLE_KEY: fakeJwt({ ref: 'jkgltyppzkpcssfnxypl', role: 'service_role' }) }), null);
  assert.equal(findConfigProblem({ ...base, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc' }), null);
  // mokano.live 이름으로 넣어도 인식
  assert.equal(findConfigProblem({ NEXT_PUBLIC_SUPABASE_URL: URL_MOKANO, LETTER_COOKIE_SECRET: SECRET, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc' }), null);
});

test('키 불일치면 DB 를 부르지 않고 500 server_misconfigured, 로그에 원인(키 값은 없음)', async () => {
  const key = fakeJwt({ ref: 'asqspnhawbngzrlkqxum', role: 'service_role' });
  const env = { SUPABASE_URL: URL_MOKANO, SUPABASE_SERVICE_ROLE_KEY: key, LETTER_COOKIE_SECRET: SECRET };
  let called = false;
  const deps = { rpc: async () => { called = true; return {}; } };
  const { r, logs } = await captureErrors(() => handleStatus(new Request('https://x.example/api/letters/status'), env, deps));
  assert.equal(r.status, 500);
  assert.equal((await r.json()).code, 'server_misconfigured');
  assert.equal(called, false);
  assert.ok(logs.some((l) => l.includes('asqspnhawbngzrlkqxum')));
  assert.ok(!logs.join('\n').includes(key));
});

test('Supabase 가 키를 거절(401)하거나 함수가 없으면(PGRST202) 500, 일시 장애는 503', async () => {
  assert.match(describeRpcConfigError({ status: 401, code: '' }), /rejected/);
  assert.match(describeRpcConfigError({ status: 404, code: 'PGRST202' }), /apply supabase\/migrations/);
  assert.match(describeRpcConfigError({ status: 401, code: '42501' }), /rejected/);
  assert.equal(describeRpcConfigError({ status: 500, code: '' }), null);
  assert.equal(describeRpcConfigError({ status: 503, code: '' }), null);

  const env = { SUPABASE_URL: URL_MOKANO, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc', LETTER_COOKIE_SECRET: SECRET };
  const first = await handleStatus(new Request('https://x.example/api/letters/status'), env, { rpc: async () => ({}) });
  const cookie = /(moka_letter_bid=[^;]+)/.exec(first.headers.get('Set-Cookie'))[1];
  assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));
  const failWith = (status, code) => ({ rpc: async () => { const e = new Error('x'); e.status = status; e.code = code; throw e; } });
  const statusReq = () => new Request('https://x.example/api/letters/status', { headers: { Cookie: cookie } });

  const { r: rejected, logs } = await captureErrors(() => handleStatus(statusReq(), env, failWith(401, '')));
  assert.equal(rejected.status, 500);
  assert.ok(logs.some((l) => l.includes('rejected SUPABASE_SERVICE_ROLE_KEY')));
  const { r: missing } = await captureErrors(() => handleStatus(statusReq(), env, failWith(404, 'PGRST202')));
  assert.equal(missing.status, 500);
  const { r: outage } = await captureErrors(() => handleStatus(statusReq(), env, failWith(500, '')));
  assert.equal(outage.status, 503);

  const post = new Request('https://x.example/api/letters', {
    method: 'POST',
    headers: { Origin: 'https://x.example', 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ content: '안녕', idempotencyKey: crypto.randomUUID() }),
  });
  const { r: submit } = await captureErrors(() => handleSubmit(post, env, failWith(401, '')));
  assert.equal(submit.status, 500);
  assert.equal((await submit.json()).code, 'server_misconfigured');
});
