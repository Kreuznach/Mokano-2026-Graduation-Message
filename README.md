# Mokano-2026-Graduation-Message

모카의 마지막 무대를 기념해 팬이 모카에게 편지를 보내는 페이지 (`/letters/write`).

- 정적 페이지 + Cloudflare Pages Functions + Supabase
- mokano.live(`Pink-Queen-Reigns`, Vercel)와 **따로 배포**하고, mokano.live 의 Supabase DB 에 편지만 저장
- 기능·DB·48시간 제한 설명: [docs/fan-letters.md](docs/fan-letters.md)
- 배포 방법 (Supabase → Cloudflare Pages → 도메인 → mokano.live 링크): [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

```powershell
npm install
npm test
npm run mock:db   # 터미널 1: 가짜 Supabase
npm run dev       # 터미널 2: http://127.0.0.1:8788/letters/write
```