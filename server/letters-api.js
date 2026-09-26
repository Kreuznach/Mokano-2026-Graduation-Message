import { validateLetter } from '../public/assets/letter-rules.js';

export const COOKIE_NAME = 'moka_letter_bid';
const COOKIE_PATH = '/api/letters';
// 48시간 제한보다 충분히 길게 (브라우저 상한 400일)
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
// 256KiB 본문의 JSON 이스케이프 여유분 포함
export const MAX_BODY_BYTES = 640 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COOKIE_VALUE_RE = /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const ALLOWED_FIELDS = new Set(['senderName', 'content', 'idempotencyKey']);
const encoder = new TextEncoder();

/* ---------- 응답 ---------- */
function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function fail(status, code, extra = {}, headers = {}) {
  return json(status, { ok: false, code, ...extra }, headers);
}

/* ---------- 설정 ---------- */
function readConfig(env) {
  // mokano.live(Vercel) 는 NEXT_PUBLIC_SUPABASE_URL 이름을 씀
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = env.LETTER_COOKIE_SECRET;
  if (!supabaseUrl || !serviceKey || !secret || secret.length < 32) return null;
  return { supabaseUrl: supabaseUrl.replace(/\/+$/, ''), serviceKey, secret };
}

// 서버에서 service role/secret 키로 PostgREST RPC 호출. 키는 응답·로그에 남기지 않음
export function createSupabaseRpc({ supabaseUrl, serviceKey }, fetchImpl = fetch) {
  return async function rpc(name, args) {
    const headers = { apikey: serviceKey, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (!serviceKey.startsWith('sb_')) headers.Authorization = `Bearer ${serviceKey}`;
    const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      let code = '';
      try { code = (await res.json()).code || ''; } catch { /* 본문 없음 */ }
      const err = new Error(`rpc ${name} failed`);
      err.status = res.status;
      err.code = code;
      throw err;
    }
    return res.json();
  };
}

/* ---------- 브라우저 식별 쿠키 (서버 서명) ---------- */
const keyCache = new Map();

function hmacKey(secret) {
  if (!keyCache.has(secret)) {
    keyCache.set(secret, crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    ));
  }
  return keyCache.get(secret);
}

function toBase64Url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function issueBrowserId(secret) {
  const id = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`bid:v1:${id}`));
  return { id, cookieValue: `v1.${id}.${toBase64Url(sig)}` };
}

async function verifyBrowserId(cookieValue, secret) {
  const m = cookieValue && COOKIE_VALUE_RE.exec(cookieValue);
  if (!m) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64Url(m[2]), encoder.encode(`bid:v1:${m[1]}`));
  return ok ? m[1] : null;
}

// DB 에는 원래 식별자 대신 서버 비밀값으로 만든 해시만 저장
async function browserHash(id, secret) {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`hash:v1:${id}`)));
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function cookieHeader(request, value) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=${value}; Path=${COOKIE_PATH}; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`;
}

async function resolveBrowser(request, secret) {
  const value = readCookie(request, COOKIE_NAME);
  const id = await verifyBrowserId(value, secret);
  if (id) return { id, cookieValue: value, issued: false };
  return { ...(await issueBrowserId(secret)), issued: true };
}

/* ---------- 요청 검사 ---------- */
function isAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const allowed = new Set([new URL(request.url).origin]);
  for (const o of (env.LETTER_ALLOWED_ORIGINS || '').split(',')) if (o.trim()) allowed.add(o.trim());
  if (!allowed.has(origin)) return false;
  return request.headers.get('Sec-Fetch-Site') !== 'cross-site';
}

async function readBodyLimited(request, max) {
  const len = request.headers.get('Content-Length');
  if (len !== null && (!/^\d+$/.test(len) || Number(len) > max)) return { tooLarge: true };
  if (!request.body) return { text: '' };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { invalid: true };
  }
}

function logError(where, err) {
  // 편지 원문·키·식별자는 기록하지 않고 상태 코드만 남김
  console.error(`[letters] ${where}`, err ? { status: err.status, code: err.code, name: err.name } : {});
}

/* ---------- GET /api/letters/status ---------- */
export async function handleStatus(request, env, deps = {}) {
  const config = readConfig(env);
  if (!config) {
    logError('status: missing server configuration');
    return fail(500, 'server_misconfigured');
  }
  const browser = await resolveBrowser(request, config.secret);
  const setCookie = { 'Set-Cookie': cookieHeader(request, browser.cookieValue) };

  if (browser.issued) {
    return json(200, { ok: true, canSubmit: true, nextAllowedAt: null, serverNow: new Date().toISOString() }, setCookie);
  }

  const rpc = deps.rpc || createSupabaseRpc(config);
  try {
    const r = await rpc('get_moka_graduation_letter_status', { p_browser_hash: await browserHash(browser.id, config.secret) });
    const next = r.next_allowed_at_ms == null ? null : Number(r.next_allowed_at_ms);
    return json(200, {
      ok: true,
      canSubmit: next === null,
      nextAllowedAt: next === null ? null : new Date(next).toISOString(),
      serverNow: new Date(Number(r.server_now_ms)).toISOString(),
    }, setCookie);
  } catch (err) {
    logError('status rpc failed', err);
    return fail(503, 'storage_unavailable', {}, setCookie);
  }
}

/* ---------- POST /api/letters ---------- */
export async function handleSubmit(request, env, deps = {}) {
  if (!isAllowedOrigin(request, env)) return fail(403, 'forbidden_origin');
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
    return fail(415, 'unsupported_media_type');
  }

  const config = readConfig(env);
  if (!config) {
    logError('submit: missing server configuration');
    return fail(500, 'server_misconfigured');
  }

  // 클라이언트가 보낸 식별자는 믿지 않음. 서버 서명이 맞는 쿠키가 없으면 새로 발급하고 저장은 거절
  const browser = await resolveBrowser(request, config.secret);
  if (browser.issued) {
    return fail(428, 'browser_cookie_required', {}, { 'Set-Cookie': cookieHeader(request, browser.cookieValue) });
  }

  const body = await readBodyLimited(request, MAX_BODY_BYTES);
  if (body.tooLarge) return fail(413, 'payload_too_large');
  if (body.invalid) return fail(400, 'invalid_request');

  let payload;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return fail(400, 'invalid_request');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some((k) => !ALLOWED_FIELDS.has(k))) {
    return fail(400, 'invalid_request');
  }

  const key = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey.toLowerCase() : '';
  if (!UUID_RE.test(key)) return fail(400, 'invalid_request');

  const checked = validateLetter(payload);
  if (!checked.ok) return fail(400, 'validation_failed', { fields: checked.errors });

  const rpc = deps.rpc || createSupabaseRpc(config);
  let r;
  try {
    r = await rpc('submit_moka_graduation_letter', {
      p_browser_hash: await browserHash(browser.id, config.secret),
      p_idempotency_key: key,
      p_sender_name: checked.value.senderName,
      p_content: checked.value.content,
    });
  } catch (err) {
    logError('submit rpc failed', err);
    return fail(503, 'storage_unavailable');
  }

  const nextMs = Number(r.next_allowed_at_ms);
  const nowMs = Number(r.server_now_ms);
  const times = { nextAllowedAt: new Date(nextMs).toISOString(), serverNow: new Date(nowMs).toISOString() };

  if (r.status === 'limited') {
    const retryAfter = Math.max(1, Math.ceil((nextMs - nowMs) / 1000));
    return fail(429, 'rate_limited', times, { 'Retry-After': String(retryAfter) });
  }
  if (r.status === 'created' || r.status === 'replayed') {
    return json(r.status === 'created' ? 201 : 200, { ok: true, status: r.status, ...times });
  }
  logError('submit rpc unexpected result', { name: 'UnexpectedStatus' });
  return fail(503, 'storage_unavailable');
}
