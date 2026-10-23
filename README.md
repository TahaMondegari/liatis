# ایجنت دپلوی لیارا · Liara Deploy & SRE Agent

یک ایجنت فارسی‌محور که پروژه رو از مخزن تا دپلوی تأییدشده روی لیارا می‌بره، بعد سلامتش رو پایش می‌کنه، علت خطاها رو با شواهد پیدا می‌کنه و فقط با تأیید تو تغییر می‌ده. هر کاری که API رسمی لیارا پشتیبانی نکنه، صادقانه به‌عنوان محدودیت نمایش داده می‌شه.

A Persian-first, chat-driven DevOps/SRE agent for [Liara](https://liara.ir): analyze → test → plan → **ask** → execute → verify → monitor → diagnose → fix → verify again.

## Highlights
- **Only real Liara capabilities**: 212 operations generated from the 20 official OpenAPI specs (`specs/liara/`), each with a reviewed risk level (L0–L4) and Persian label. Missing capabilities (rollback, top-up, network creation, image deploy…) are shown as limitation cards — see [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).
- **Safety core**: Tool Gateway → Policy Engine → server-side approvals (scope-hash, TTL, single-use, L4 typed confirmation) → append-only audit. Secrets never reach the model, SSE, audit or approvals.
- **Complete AI layer** on Liara AI (OpenAI-compatible) with exactly the 12 allowed models: role routing + fallback, escalation, per-model parameter filtering from the live catalog, streaming, tool calling, structured output, embeddings, Toman cost ledger (`total_cost_toman`), budgets, probe/evaluation, workspace usage/logs/keys/limits.
- **Workflows**: deterministic, persisted state machines — DeployFlow (Ask Cards, QualityGate in a Docker sandbox, RCA, minimal patches on a deploy copy, invoice, deploy, verification), IncidentFlow (detectors, hypotheses, remediation, verify-delta), Patrol (every 3 h, leases, zero LLM calls when healthy), OpsAgent (LLM tool loop over Mega Tools).
- **UI**: Next.js 16, RTL, Vazirmatn, design tokens and boards from the provided design (chat Ask Cards, plan/invoice, deploy timeline, gate report, root cause, patch diff, incident panel, patrol settings/history, approvals inbox, logs, activity, capabilities, AI models/usage).
- **Demo Mode** backed by a deterministic mock Liara world with switchable faults; it cannot reach real infrastructure.

## Quick start
```bash
npm install          # also builds packages/shared
cp .env.example .env # optional; DEMO_MODE=true by default
npm run dev          # API http://localhost:8787 · Web http://localhost:3000
```
Tests and replay:
```bash
make test            # 29 tests: safety, policy/approvals, gateway, patrol, end-to-end deploy
make demo-replay     # Persian transcript of 3 deterministic scenarios, 0 real requests
```

## Real Mode
| Variable | Purpose |
|---|---|
| `DEMO_MODE=false`, `LIARA_API_TOKEN` | Liara API (Bearer) |
| `AI_API_BASE_URL=https://ai.liara.ir/api/<workspaceID>/v1`, `AI_API_KEY` | Liara AI (any OpenAI-compatible gateway with the same model IDs works) |
| `AI_WORKSPACE_ID` | AI usage/log pages (uses the Liara token) |
| `AI_DAILY_BUDGET_TOMAN`, `AI_RUN_BUDGET_TOMAN` | spend caps |
| `SANDBOX_DRIVER=docker` | real QualityGate execution (needs Docker) |
| `APP_AUTH_TOKEN` | protect the API |
| `LIARA_FILEBROWSER_URL`, `LIARA_DB_INSPECTOR_URL` | per-resource hosts (not published in specs) |
| `TELEGRAM_*`, `NOTIFY_MAIL_*` | optional alerts (email via Liara Mail API) |

Then run `npm run probe:models` to verify each allowed model (writes `apps/server/llm_capabilities.json`).

## Layout
```
packages/shared   zod schemas shared by server and web (events, blocks, approvals)
apps/server       Fastify API, agent, workflows, Liara client, AI gateway, policy, patrol
apps/web          Next.js UI (RTL)
specs/liara       official OpenAPI specs + docs snapshots (source of truth)
samples/shop-next sample repository with switchable faults
docs/             BRIEF, RECON, architecture, api, security, monitoring, troubleshooting, LIMITATIONS, demo
```

## Docs
[Architecture](docs/architecture.md) · [API](docs/api.md) · [Security](docs/security.md) · [Monitoring](docs/monitoring.md) · [Troubleshooting](docs/troubleshooting.md) · [Limitations](docs/LIMITATIONS.md) · [Recon/evidence](docs/RECON.md) · [Demo script](docs/demo.md)

## Status
Implemented and tested in Demo Mode (unit + end-to-end). Not yet exercised against a real Liara account or a real Liara AI key in this environment — see «Unverified» in [`docs/RECON.md`](docs/RECON.md).
# liatis
