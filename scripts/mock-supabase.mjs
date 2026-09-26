// 로컬 확인용 가짜 Supabase. 실제 마이그레이션 SQL을 PGlite(메모리 Postgres)에 적용하고
// /rest/v1/rpc/<함수> 를 service_role 권한으로 실행합니다. 127.0.0.1 에서만 열립니다.
import { createServer } from 'node:http';
import { createTestDb, makeRpc } from '../tests/helpers/db.mjs';

const PORT = Number(process.env.MOCK_SUPABASE_PORT || 54321);
const ALLOWED_RPC = new Set(['submit_moka_graduation_letter', 'get_moka_graduation_letter_status']);

const db = await createTestDb();
const rpc = makeRpc(db);
let failNext = 0;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      if (!req.headers.apikey) return send(res, 401, { code: 'no_api_key' });
      if (!ALLOWED_RPC.has(m[1])) return send(res, 404, { code: 'PGRST202' });
      if (failNext > 0) {
        failNext--;
        return send(res, 500, { code: 'mock_failure' });
      }
      return send(res, 200, await rpc(m[1], await readJson(req)));
    }
    // 시간 여행: 모든 제한 시각을 N시간 앞당김 (48시간 경계 확인용)
    if (req.method === 'POST' && url.pathname === '/__mock/shift') {
      const hours = Number(url.searchParams.get('hours') || 48);
      const ms = Number(url.searchParams.get('ms') || 0);
      await db.query(
        `update public.moka_graduation_letter_limits
         set last_success_at = last_success_at - make_interval(hours => $1::int) - make_interval(secs => $2::float8 / 1000),
             next_allowed_at = next_allowed_at - make_interval(hours => $1::int) - make_interval(secs => $2::float8 / 1000)
         where next_allowed_at is not null`,
        [hours, ms],
      );
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/__mock/letters') {
      const { rows } = await db.query('select id, sender_name, content, moderation_status, created_at from public.moka_graduation_letters order by created_at');
      return send(res, 200, rows);
    }
    // 다음 N번의 RPC 를 500 으로 실패시킴 (실패 시 내용 유지 확인용)
    if (req.method === 'POST' && url.pathname === '/__mock/fail') {
      failNext = Number(url.searchParams.get('count') || 1);
      return send(res, 200, { ok: true, failNext });
    }
    return send(res, 404, { code: 'not_found' });
  } catch (err) {
    return send(res, 400, { code: err.code || 'error', message: err.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock supabase: http://127.0.0.1:${PORT}`);
});
