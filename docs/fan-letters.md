# 모카에게 편지 쓰기 (팬 편지)

팬이 로그인 없이 모카에게 **마지막 라이브(LAST LIVE) 기념 편지**를 보내는 기능입니다.
편지는 먼저 Supabase에 `pending`(검수 대기) 상태로 저장되고, 관리자가 확인한 뒤 모카에게 전달됩니다.

- 주소: `/letters/write` (첫 화면 `/`에 들어오면 이 주소로 이동)
- 디자인: 카운트다운 페이지(`Mokano-2026-Graduation-Countdown`)와 같은 색, 카드, 이모지 움직임
- 구성: 정적 페이지 + Cloudflare Pages Functions(서버 API) + Supabase(DB)
- **mokano.live(Next.js, Vercel, `Pink-Queen-Reigns` 저장소)와 따로 배포**하고, mokano.live 의 Supabase DB 에 편지만 저장해요.
  mokano.live 쪽에는 메뉴 링크만 추가했어요 (환경변수가 있을 때만 표시).
- 배포 방법: **[DEPLOYMENT.md](DEPLOYMENT.md)**

---

## 1. 파일은 뭐가 있나요?

| 파일 | 하는 일 |
|---|---|
| `public/letters/write.html` | 편지 쓰기 화면 |
| `public/assets/letters.css` | 색·카드·편지지·이모지 움직임 (맨 위 `:root`에서 색 변경) |
| `public/assets/letters.js` | 입력 확인, 전송, 48시간 안내, 움직임 끄기/켜기, 언어 전환 |
| `public/assets/letters-i18n.js` | 화면 문구 **한국어(ko) / 일본어(ja)**. 글자를 바꿀 때는 이 파일만 고치면 돼요 |
| `public/assets/emoji-layer.js` | 떠다니는 이모지 (종류·개수는 맨 위 `EMOJI_CONFIG`) |
| `public/assets/letter-rules.js` | 이름 40자 / 2,000줄 / 256KB 규칙. **브라우저와 서버가 같이 씀** |
| `functions/api/letters/status.js` | `GET /api/letters/status` 지금 보낼 수 있는지 확인 |
| `functions/api/letters/index.js` | `POST /api/letters` 편지 저장 |
| `server/letters-api.js` | 두 API의 실제 처리 (쿠키, 검사, Supabase 호출) |
| `supabase/migrations/20260926000000_create_moka_graduation_letters.sql` | DB 테이블·권한·저장 함수 (필수) |
| `supabase/migrations/20260926000100_moka_graduation_letters_admin_policies.sql` | mokano.live 관리자(`is_admin()`)가 편지를 읽고 검수하는 정책 (선택) |
| `tests/*.test.mjs` | 자동 검사 |
| `scripts/mock-supabase.mjs` | 내 컴퓨터에서 쓰는 **가짜 Supabase** (진짜 DB 없이 확인용) |

---

## 2. 필요한 환경변수 (이름만)

| 이름 | 설명 |
|---|---|
| `SUPABASE_URL` | mokano.live 와 같은 Supabase 주소. 없으면 mokano.live 이름인 `NEXT_PUBLIC_SUPABASE_URL`(또는 `VITE_SUPABASE_URL`)을 대신 사용 |
| `SUPABASE_SERVICE_ROLE_KEY` | **서버 전용** 키 (mokano.live 와 같은 이름). `service_role` 또는 편지 전용 `sb_secret_...` 추천. 절대 `NEXT_PUBLIC_`/`VITE_` 공개 변수에 넣지 마세요 |
| `LETTER_COOKIE_SECRET` | 쿠키 서명용 무작위 문자열, 32자 이상 |
| `LETTER_ALLOWED_ORIGINS` | (선택) 다른 도메인에서 이 API를 프록시할 때만. 쉼표로 구분 |

`LETTER_COOKIE_SECRET` 만들기 (PowerShell):

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

> 이 값을 바꾸면 모든 브라우저가 "새 브라우저"로 보여서 48시간 제한이 초기화됩니다. 한 번 정하면 바꾸지 마세요.

mokano.live(Vercel) 쪽에 추가하는 변수:

| 이름 | 설명 |
|---|---|
| `NEXT_PUBLIC_FAN_LETTER_URL` | 예: `https://letters.mokano.live/letters/write`. 있을 때만 상단 메뉴와 프로필 → 비공식 링크에 "모카에게 편지 쓰기"가 보여요. 바꾼 뒤 Redeploy 필요 |

---

## 3. 내 컴퓨터에서 실행하기

처음 한 번:

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
```

### 방법 A: 가짜 DB로 확인 (Supabase 없이)

`.dev.vars`를 이렇게 채웁니다.

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=local-mock-key
LETTER_COOKIE_SECRET=(위에서 만든 무작위 문자열)
```

터미널 두 개에서:

```powershell
npm run mock:db   # 가짜 Supabase (진짜 마이그레이션 SQL을 메모리 DB에 적용)
npm run dev       # http://127.0.0.1:8788 → /letters/write
```

가짜 DB 전용 도우미 (확인용):

| 주소 | 하는 일 |
|---|---|
| `GET http://127.0.0.1:54321/__mock/letters` | 저장된 편지 보기 |
| `POST http://127.0.0.1:54321/__mock/shift?hours=48` | 시간을 48시간 앞으로 보낸 것처럼 만들기 |
| `POST http://127.0.0.1:54321/__mock/fail?count=2` | 다음 2번의 저장을 일부러 실패시키기 |

가짜 DB는 끄면 내용이 사라집니다.

### 방법 B: 진짜 Supabase로 확인

`.dev.vars`에 실제 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`를 넣고 `npm run dev`만 실행합니다.
(먼저 4번의 DB 적용을 해야 합니다.)

---

## 4. DB 적용 (Supabase) — 아직 원격에 적용하지 않았어요

자세한 화면 순서는 [DEPLOYMENT.md](DEPLOYMENT.md) 2단계에 있어요.
mokano.live 도 Supabase CLI 없이 SQL Editor 에 직접 붙여 넣는 방식이라 같은 방식을 써요.

1. Supabase 대시보드 → mokano.live 프로젝트 → **SQL Editor**
2. `supabase/migrations/20260926000000_create_moka_graduation_letters.sql` 내용을 전부 붙여 넣고 **Run**
3. (선택) `supabase/migrations/20260926000100_moka_graduation_letters_admin_policies.sql` — mokano.live 의 `rls.sql`(`is_admin()`)이 적용된 DB 에서만
4. **Table Editor**에 `moka_graduation_letters`, `moka_graduation_letter_limits`가 생겼는지 확인

- 새 테이블·함수·정책만 만들어요. 기존 `fan_messages`, `events`, `profiles`, `is_admin()` 등은 건드리지 않아요.
- 여러 번 실행해도 안전해요.

만들어지는 것:

| 이름 | 내용 |
|---|---|
| `moka_graduation_letters` | 편지 본문: `id`, `sender_name`(null=익명), `content`, `moderation_status`(pending/approved/hidden), `created_at`, `reviewed_at`, `read_at` |
| `moka_graduation_letter_limits` | 서버 전용 제한 기록: 브라우저 식별자 **해시**, 마지막 성공 시각, 다음 가능 시각, 마지막 idempotency key |
| `submit_moka_graduation_letter(...)` | 제한 확인 + 저장 + 제한 갱신을 **한 트랜잭션**에서 처리 |
| `get_moka_graduation_letter_status(...)` | 지금 보낼 수 있는지 확인 |

권한:
- 두 테이블 모두 RLS를 켰고, `anon`·`authenticated`의 조회·추가·수정·삭제 권한을 모두 뺐어요. 로그인했다고 관리자가 되지 않아요.
- 두 함수도 `anon`·`authenticated`는 실행할 수 없고 `service_role`만 실행할 수 있어요.
- 새 편지는 누가 넣어도 `pending` / DB 시각 / 미검수 / 미열람으로 시작해요 (트리거).
- 선택 정책을 적용하면: mokano.live 와 같은 기준(`profiles.role = 'admin'` → `is_admin()`)의 관리자만 편지를 읽고
  `moderation_status`·`reviewed_at`·`read_at` 만 바꿀 수 있어요. 본문 수정·추가·삭제와 제한 테이블 접근은 관리자도 못 해요.

---

## 5. 인터넷에 올리기

**[DEPLOYMENT.md](DEPLOYMENT.md)** 를 따라 하세요. 요약:

1. Supabase 에 SQL 실행, 편지 전용 secret key 발급
2. Cloudflare Pages 에 이 저장소 연결 (빌드 명령 없음, 출력 `public`), Secret 3개 추가 후 재배포
3. (선택) `letters.mokano.live` CNAME 연결
4. mokano.live(Vercel)에 `NEXT_PUBLIC_FAN_LETTER_URL` 추가 → Redeploy → 메뉴 링크 표시

---

## 6. 48시간 제한은 어떻게 동작하나요?

1. 페이지를 열면 서버가 **무작위 브라우저 식별자**를 만들어 `HttpOnly` 쿠키에 넣어요.
   쿠키에는 서버 서명이 붙어 있어서, 브라우저가 값을 마음대로 바꾸면 거절돼요.
   (`SameSite=Lax`, `Path=/api/letters`, HTTPS에서는 `Secure`, 수명 400일)
2. DB에는 식별자 원본이 아니라 서버 비밀값으로 만든 **해시**만 저장해요.
3. 편지를 보내면 DB 함수가 한 번에 처리해요: 제한 행을 잠그고 → 48시간 안이면 거절 → 아니면 편지 저장 + 제한 갱신.
   동시에 여러 번 눌러도 한 건만 저장돼요.
4. 다음 가능 시각 = **편지가 DB에 저장된 시각 + 정확히 48시간** (자정 초기화 아님).
5. 제한 중이면 `429`와 다음 가능 시각, `Retry-After`를 돌려줘요. 화면은 서버 시각 기준으로 남은 시간을 보여줘요.
6. 같은 내용을 다시 보낼 때는 같은 **idempotency key**를 써요. 응답이 중간에 끊겨 다시 눌러도 두 번 저장되지 않고 "이미 받았어요"로 처리돼요.
7. 저장 실패·입력 오류·DB 오류는 제한을 시작하지 않아요. 편지를 지우거나 검수 상태를 바꿔도 제한 기록은 그대로예요.
8. 브라우저의 `localStorage`(`mokano:letters:nextAllowedAt`)에는 화면 표시용 시각만 저장해요. 지워도 서버 제한은 그대로예요.
   다른 탭에서 보내면 이 값이 바뀌어 다른 탭도 서버에 다시 확인해요.

### 한계 (꼭 알아 두세요)

- 이 기능은 "**같은 브라우저**에서 48시간에 한 번"이에요. "같은 사람"을 완전히 막지는 못해요.
- 쿠키를 지우거나, 시크릿 창, 다른 브라우저, 다른 기기를 쓰면 새 브라우저로 보여요.
- 로그인이나 기기 지문 수집은 일부러 넣지 않았어요.
- 쿠키 저장을 막은 브라우저는 편지를 보낼 수 없고, 쿠키 허용 안내가 나와요 (제한 없이 보내지는 우회는 없음).

---

## 7. 언어 (한국어 / 日本語)

- 오른쪽 위 `한국어 / 日本語` 버튼으로 바꿔요. 쓰던 내용과 남은 시간은 그대로이고, 오류 문구도 바뀐 언어로 다시 보여요.
- 처음 언어는 이 순서로 정해요: 주소의 `?lang=ja` / `?lang=ko` → 전에 고른 언어(`localStorage` `mokano:letters:lang`) → 브라우저 언어가 일본어면 日本語 → 한국어
- 일본 팬에게는 `https://(주소)/letters/write?lang=ja` 를 공유하면 돼요.
- 시각은 두 언어 모두 `KST` 로 표시해요 (일본 시각과 같아요).
- 서버는 언어와 상관없이 같은 규칙으로 저장해요. 일본어 편지도 그대로 보존돼요.

---

## 8. 입력 규칙

| 항목 | 규칙 |
|---|---|
| 이름 | 선택. 앞뒤 공백 제거 후 비면 `null`(익명). 최대 40자(이모지 1개 = 1자). 줄바꿈 등 제어 문자 불가 |
| 편지 | 필수. 공백·줄바꿈뿐이면 불가. CRLF/CR → LF |
| 줄 수 | **최대 2,000줄** (실제 줄바꿈 기준. 화면에서 자동으로 넘어가는 줄은 세지 않음) |
| 용량 | UTF-8 **256KiB**(262,144바이트) 이하 |
| 형식 | plain text. HTML/Markdown은 실행·렌더링하지 않고 글자 그대로 저장 |

같은 규칙을 브라우저(`letter-rules.js`)와 서버가 함께 쓰고, DB에도 같은 제약(CHECK)이 있어요.

---

## 9. 검사하기

```powershell
npm test                 # 입력 규칙 · DB(권한/제한/동시성) · mokano.live 관리자 정책 · API 자동 검사
npm run build:functions  # 서버 API가 Cloudflare 형식으로 빌드되는지 확인
npm run check:config     # .dev.vars 의 Supabase URL·키가 같은 프로젝트인지, 실제로 연결되는지 확인 (비밀값 출력 없음)
```

`npm test`는 실제 마이그레이션 SQL을 메모리 Postgres(PGlite)에 적용해서 확인해요.
관리자 정책은 mokano.live 의 `profiles` 테이블과 `is_admin()` 을 같은 모양으로 만들어 둔 뒤 확인해요.
48시간은 기다리지 않고 DB 시각을 옮겨서 확인해요.

진짜 Supabase에 적용한 뒤 권한 확인 (anon 키로는 모두 실패해야 정상):

```powershell
$h = @{ apikey = '<anon key>'; Authorization = 'Bearer <anon key>'; 'Content-Type' = 'application/json' }
Invoke-WebRequest "$env:SUPABASE_URL/rest/v1/moka_graduation_letters?select=*" -Headers $h            # 401/403 또는 오류
Invoke-WebRequest "$env:SUPABASE_URL/rest/v1/rpc/get_moka_graduation_letter_status" -Method Post -Headers $h -Body '{"p_browser_hash":"x"}'  # 오류
```

---

## 10. 나중에 관리자·모카 화면을 붙일 때 (mokano.live)

mokano.live 는 이미 `/admin` (미들웨어 + `profiles.role` 확인)과 `/moka` (모카 계정 로그인)을 갖고 있어요.
선택 정책(4번의 3)을 적용했다면 **기존 `fan_messages` 관리 화면과 같은 방식**으로 만들 수 있어요.

- 참고할 코드: `src/app/admin/fan-messages/page.tsx`, `src/actions/fan-messages.ts` (`requireAdmin()` + 로그인 세션 클라이언트)
- 목록: `moka_graduation_letters`에서 `moderation_status`, `created_at desc` 순서로 조회 (인덱스 있음)
- 검수: `moderation_status`를 `approved`/`hidden`으로 바꾸고 `reviewed_at = now()`
- 모카 열람: `approved`만 보여 주고, 처음 열 때 `read_at is null`인 경우에만 `read_at = now()`
  (`.update({ read_at: new Date().toISOString() }).eq('id', id).is('read_at', null)`)
- 타입: mokano.live `src/types/database.types.ts` 에 새 테이블 타입을 추가하거나 `supabase gen types` 로 다시 만드세요.
- **시각 주의:** 편지 테이블은 진짜 UTC 로 저장해요. mokano.live 의 `events` 처럼 KST 벽시계를 `+00` 으로 넣는 방식이 아니라서
  `dayjs.utc(...)` 그대로 보여 주면 9시간 어긋나요. `dayjs.utc(created_at).add(9, 'hour').format(...)` 처럼 KST 로 바꿔 보여 주세요.
- 편지 내용은 반드시 **텍스트로** 보여 주세요 (React의 `{content}`). `dangerouslySetInnerHTML`·Markdown 렌더링 금지.
  줄바꿈은 `whitespace-pre-wrap` 으로 보여 주면 돼요. 2,000줄짜리 편지도 있을 수 있어서 목록에서는 앞부분만 보여 주세요.
- "로그인한 사람 = 관리자" 정책은 만들지 마세요. 반드시 `is_admin()` 을 쓰세요.
- `moka_graduation_letter_limits`는 운영용이에요. 관리자·모카 화면 응답에 넣지 마세요.
