# Five-minute demo script (Demo Mode)

Setup: `npm install` → `npm run dev` (API :8787, web :3000; `DEMO_MODE=true` by default). Header shows **DEMO · داده نمونه**.
Non-interactive version: `make demo-replay` (prints the same three scenarios as a Persian transcript).

1. **Deploy (2 min)** — Chat → click «پروژه فروشگاهی منو روی لیارا دیپلوی کن.»
   - Source card → «پروژه‌ی نمونه». Analysis table shows Next.js, `npm ci/build/test/start`, `DATABASE_URL`, Postgres — each with evidence.
   - Platform (with «چرا Next.js؟»), stage, concurrency slider, app id, DB «ساخت دیتابیس جدید», network «نه».
   - Plan cards: prices come from `GET /v1/me` (demo catalogue), recommendation explained as an estimate.
   - QualityGate fails on «نمایش جمع سبد خرید» → RCA points to `src/cart.ts:26` → patch `Number(i.price)` shown as a diff, verified on a scratch copy.
   - «اعمال فقط روی نسخه‌ی دیپلوی‌شده» → gate re-runs; «اعتبار کد تخفیف» is detected as pre-existing → explicit, audited risk acceptance.
   - Invoice → «تأیید و پرداخت» (4 server-side approvals) → timeline: createApp → DB → env (secret placeholders) → upload → build → health.
   - Verification table → success card with URL → enable patrol.
2. **Incident (2 min)** — `curl -XPOST localhost:8787/api/demo/scenario -H 'content-type: application/json' -d '{"app":"shop-front-prod","scenario":"oom"}'`
   - Ask «چرا shop-front-prod کند شده؟» → evidence bento (CPU/RAM/p95/error rate) + ranked hypotheses + L3 approval «افزایش حافظه از ۴ به ۸ گیگ» with price delta.
   - Approve → «قبل و بعد از تغییر»: p95 2400→340ms, errors →0%, memory 94→53% → INC resolved. Incidents page shows the timeline.
3. **Guards (1 min)**
   - Ask «دیتابیس shop-db رو حذف کن» (with AI configured) or open Approvals → L4 requires typing `shop-db`.
   - Choose «Docker Image» as source → limitation card, no mutation (Activity shows nothing executed).
   - Projects → shop-front-prod → پایش → «همین الان چک کن»: healthy run reports `فراخوانی مدل: ۰`.
   - Capabilities page: 192 supported / 22 partial / 8 unsupported with evidence links.
