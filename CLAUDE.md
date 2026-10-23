# CLAUDE.md — Liara Deploy & SRE Agent

Full brief: `docs/BRIEF.md` (verbatim). Owner instruction (2026-10-23): architecture is free, TypeScript preferred;
implement every feature the official Liara API supports; the AI layer must be complete for the allowed models.

## Never violate
- Every Liara call goes through `ToolGateway` (policy → approval → typed client → audit). No raw URLs/paths from the model.
- Executable operations come only from `specs/liara/*.yaml` → `apps/server/src/liara/operations.generated.ts`.
- L2+ needs a server-side approval bound to a scope hash; L4 needs the typed resource name; TTL 10 min.
- Secrets never reach prompts, SSE, audit, approvals, run state. Env values use `{{secret:KEY}}` + `SecretStore`.
- Demo mode can only construct `MockTransport`/`MockProber`/`SimulatedSandbox`. Real repo commands run only in Docker.
- Original repo copy is never modified; tests are never edited (CodingAgent refuses test/lock/env/CI paths).
- Healthy patrol = zero LLM calls. Only the 12 allowed model IDs (`config/models.yaml`).
- Never invent prices/capabilities: unknown → «نامشخص» / limitation card.

## Repo map
- `packages/shared` — zod schemas: SSE events, chat blocks, Ask Cards, approvals (shared by server+web).
- `apps/server/src`
  - `liara/` generated ops, capability registry (risk+label per op), HTTP/Mock transports, typed readers
  - `policy/` PolicyEngine, ApprovalService · `tools/` ToolGateway, Mega Tools · `audit/`
  - `ai/` ModelRegistry (catalog), LlmGateway (routing/fallback/stream/tools/structured/cost), probe
  - `agent/` Agent (router), DeployFlow (state machine), IncidentFlow, OpsAgent (LLM tool loop), ChatService, RunStore
  - `analyzer/`, `workspace/` (git/zip intake, packaging), `sandbox/`, `gate/`, `rca/`, `repair/`, `verify/`
  - `monitor/` detectors, incidents, remediation, patrol (+worker) · `notify/` · `demo/` world, replay, limitations
- `apps/web` — Next.js 16 App Router, RTL, Tailwind v4; `components/blocks/*` render chat blocks.
- `samples/shop-next` — sample repo with switchable faults (`FAULTS.md`).

## Current phase
P0–P6 implemented and tested in Demo Mode; P7 docs done. Not yet verified against a real Liara account or real
Liara AI key (no credentials in this environment) — see `docs/RECON.md` → "Unverified".

## Decisions
- TypeScript monorepo (npm workspaces) instead of Python/LangGraph: explicit persisted state machines (`runs` table)
  replace LangGraph graphs; same checkpoint/resume semantics, fewer moving parts.
- Persistence: built-in `node:sqlite` (WAL) with ordered migrations. Postgres not implemented (documented).
- AI provider: Liara AI (`ai.liara.ir`, OpenAI-compatible); all allowed models exist there as `openai/<id>`.

## Commands
`make test` · `make demo-replay` · `npm run dev` (api :8787, web :3000) · `npm run generate:liara` ·
`npm run probe:models` · `npm run docs:limitations` · `npm run patrol` (separate worker)

## Known limitations
See `docs/LIMITATIONS.md` (generated). Highlights: no rollback/top-up/network-create/image-deploy endpoints;
per-resource hosts for File Browser/DB Inspector must be configured; metric units/release states not in spec.
