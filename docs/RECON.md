# RECON — evidence log

Retrieved 2026-10-23. Everything below is either backed by a stored artifact in `specs/liara/` or explicitly marked unverified.

## 1. Liara developer API (source of truth)

- Index: `https://developers.liara.ir/llms.txt` → saved as `specs/liara/llms.txt`.
- **20 official OpenAPI specs** downloaded to `specs/liara/*.yaml` with `RETRIEVED_AT` and `SHA256SUMS`:
  `paas, dbaas, database-inspector, dns, object-storage, mail, file-browser, Iaas, billing, me,
  ai-chat-completions, ai-embeddings, ai-image-generation, ai-tts, ai-stt, ai-workspaces, ai-keys, ai-logs, ai-models, ai-playground`.
- Generator `scripts/generate-liara-operations.mjs` → **212 operations** in `apps/server/src/liara/operations.generated.ts`.
  Human-readable digests: `specs/liara/summary/*.txt`.
- Every operation has a reviewed risk level and Persian label (`liara/capabilities.ts`; test enforces full coverage).

### Servers and auth (from specs)
| Service | Base URL | Auth |
|---|---|---|
| PaaS, DBaaS, Billing, Account | `https://api.liara.ir` | `Authorization: Bearer <LIARA_API_TOKEN>` |
| DNS | `https://dns-service.liara.ir` | same |
| Object Storage | `https://storage-service.liara.ir` | same |
| Mail | `https://mail-service.liara.ir` | same |
| IaaS | `https://iaas-api.liara.ir` | same |
| File Browser / DB Inspector | templated `{filebrowser-url}` / `{database-inspector-url}` | same — host not published → **partial** until configured |
| AI inference | `https://ai.liara.ir/api/{workspaceID}/v1/...` | AI API key |
| AI workspaces/keys/logs | `https://ai.liara.ir/v1/...` | Liara token (JWT) |
| AI model catalog | `https://ai.liara.ir/v1/models` | none |

### Key findings
- Deploy = `POST /v2/projects/{name}/sources` (multipart `.gz`) → `sourceID`, then `POST /v2/projects/{name}/releases {sourceID, port, type}` → `releaseID`. Release status is read from `GET /v1/projects/{name}/releases` (no single-release endpoint in spec).
- **No rollback endpoint.** Rollback is implemented as re-releasing a source archive the agent itself uploaded earlier (digest-bound) → `partial`.
- **Plans/prices**: `GET /v1/me` returns `plans.projects|databases|projectBundlePlans|…` as untyped objects; parsed defensively. Official docs list hardware tiers (زمین…پلوتون) and bundles (برنزی/نقره‌ای/طلایی) without prices; docs saved in `specs/liara/docs/`.
- Billing: only `GET /v1/billing` (balance). Top-up/usage/invoices are **unsupported**.
- `createApp` accepts `network` (name) but there is no network API → creating private networks is **unsupported**.
- `getAppLogs.since` and `metrics/*.since` are required; metric value units are not documented.
- `releasesDeploy` has no image field → prebuilt Docker image deploy **unsupported** via API.
- `object-storage` spec has a path typo (`/download/${object}`) — normalized in the generator.

## 2. AI provider and allowed models

The brief refers to "BoxAPI". A web search found no public OpenAI-compatible service by that name; Liara's own AI
service (`ai.liara.ir`, OpenAI-compatible, documented in the same developer portal) lists **all 12 allowed IDs** in its
public catalog (`specs/liara/ai-models-catalog.json`) as `openai/<id>`:

| Allowed ID | Provider ID | Context | Catalog supported_parameters (excerpt) | Price in/out USD per token |
|---|---|---|---|---|
| gpt-6.1-sol | openai/gpt-6.1-sol | 1,050,000 | tools, structured_outputs, reasoning_effort | 2e-6 / 1e-5 |
| gpt-6-astra | openai/gpt-6-astra | 1,050,000 | same | 1e-5 / 5e-5 |
| gpt-6-luna | openai/gpt-6-luna | 1,050,000 | same | 1e-7 / 5e-7 |
| gpt-6-sol | openai/gpt-6-sol | 1,050,000 | same | 2e-6 / 1e-5 |
| gpt-5-mini | openai/gpt-5-mini | 400,000 | same | 2.5e-7 / 2e-6 |
| gpt-5.6-luna | openai/gpt-5.6-luna | 1,050,000 | same | 2e-7 / 1.2e-6 |
| gpt-5.6-terra | openai/gpt-5.6-terra | 1,050,000 | same | 2e-6 / 1.2e-5 |
| gpt-5.6-sol | openai/gpt-5.6-sol | 1,050,000 | same | 4e-6 / 2e-5 |
| gpt-5.4-mini | openai/gpt-5.4-mini | 400,000 | same | 7.5e-7 / 4.5e-6 |
| gpt-5.3-codex | openai/gpt-5.3-codex | 400,000 | same | 1.75e-6 / 1.4e-5 |
| text-embedding-3-small | openai/text-embedding-3-small | — | — | 2e-8 |
| text-embedding-3-large | openai/text-embedding-3-large | — | — | 1.3e-7 |

- The gateway is OpenAI-compatible with a configurable `AI_API_BASE_URL`, so a different compatible gateway (e.g. a
  "BoxAPI" endpoint) can be used without code changes, as long as it accepts the same model IDs (aliases in `config/models.yaml`).
- Responses include `usage.total_cost_toman` → real per-call cost accounting; no prices are invented.
- `temperature` is **not** in `supported_parameters` for the GPT-5/6 families → the gateway filters parameters per model.

## 3. Unverified (needs real credentials)

| Item | Status | How to verify |
|---|---|---|
| Real Liara account calls (all 212 ops) | **unverified** — no `LIARA_API_TOKEN` here | set `DEMO_MODE=false`, `LIARA_API_TOKEN`; use read-only pages first |
| Model availability / streaming / tools / structured output per model | **unverified** (catalog only) | `npm run probe:models` → writes `apps/server/llm_capabilities.json` |
| Liara platform ids for `createApp.platform` (next, node, laravel, …) | from Liara CLI conventions, not the spec | first real create; user can change in the platform card |
| Metric units (bytes / cores) | assumption | compare `/metrics/memory` with the console |
| Release state names | assumption (`READY/FAILED/…`) | observe a real deploy |
| Path param `{id}` for zero-downtime/default-subdomain/disks = app name? | ambiguous in spec | first real call |
| Docker sandbox | Docker not installed in this environment → real gate untested here | run with Docker installed |

## 4. Environment
Node 24.22 (built-in `node:sqlite`), npm 11, Windows 11, no Docker. TypeScript 5.9.3, Next.js 16.4.2, React 19.3, Fastify 5.12, Zod 4.6, Vitest 5.
