// 배포 전에 Supabase 설정이 맞는지 확인합니다. 비밀값은 출력하지 않습니다.
// 사용: npm run check:config            (.dev.vars 를 읽음)
//       npm run check:config -- 파일경로
import { readFileSync, existsSync } from 'node:fs';
import { findConfigProblem, describeRpcConfigError, createSupabaseRpc } from '../server/letters-api.js';

const file = process.argv[2] || '.dev.vars';
const env = { ...process.env };
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  console.log(`읽은 파일: ${file}`);
} else {
  console.log(`${file} 이 없어 환경변수만 사용합니다.`);
}

const problem = findConfigProblem(env);
if (problem) {
  console.error(`✗ 설정 오류: ${problem}`);
  process.exit(1);
}

const supabaseUrl = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL).replace(/\/+$/, '');
console.log(`✓ 형식 확인 통과 (프로젝트: ${new URL(supabaseUrl).hostname})`);

const rpc = createSupabaseRpc({ supabaseUrl, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY });
try {
  const r = await rpc('get_moka_graduation_letter_status', { p_browser_hash: '0'.repeat(64) });
  console.log(`✓ Supabase 연결 성공 (DB 시각 ${new Date(Number(r.server_now_ms)).toISOString()})`);
  console.log('이 값 그대로 Cloudflare Pages Secret 에 넣으면 됩니다.');
} catch (err) {
  const reason = describeRpcConfigError(err) || 'Supabase 가 일시적으로 응답하지 않음';
  console.error(`✗ Supabase 호출 실패 (HTTP ${err.status ?? '-'} ${err.code || ''}): ${reason}`);
  process.exit(1);
}
