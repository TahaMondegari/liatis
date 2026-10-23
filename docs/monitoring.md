# Monitoring, incidents and patrol

## Patrol
- Schedule stored per project in `patrol_settings.next_run_at` (default every `MONITOR_INTERVAL_HOURS=3`, ±5 min jitter).
- Runs in-process (`PATROL_IN_PROCESS=true`) and/or as a separate worker: `npm run patrol`.
- Per-project DB lease (`lease_owner/lease_until`) → only one worker patrols a project at a time.
- Idempotency key per schedule slot; a missed window triggers one `catch_up` run (not one per missed slot).
- "Run now" button / `POST /api/projects/:name/patrol/run`.

## What is checked (only what Liara exposes or we measure)
| Check | Source |
|---|---|
| Release state | `GET /v1/projects/{name}/releases` |
| Containers, restarts, OOM | `applets`, `events`, log signatures |
| CPU / memory % | `metrics/cpu`, `metrics/memory` ÷ plan CPU/RAM from `/v1/me` |
| HTTP availability, p50/p95, error rate | synthetic GETs to `https://<app>.liara.run` + health paths |
| New error signatures | `getAppLogs` → redacted, grouped by signature |
| TLS days left, DNS | direct TLS handshake / DNS resolve of attached domains |
| Wallet runway | `GET /v1/billing` ÷ app `hourlyPrice` |

Not observable via API (not claimed): disk usage beyond `metrics/summary.disksUsage`, request logs/latency from Liara's edge.

## Detection → incident
Deterministic detectors (`monitor/detectors.ts`): OOM/memory pressure, CPU saturation, crash loop (port binding vs
generic), DB connectivity, HTTP 5xx, post-release regression, latency regression vs EMA baseline, failed release,
TLS expiry, DNS failure, new app errors. Thresholds are defaults in `verify/observe.ts → THRESHOLDS`.

- **Healthy patrol = zero model calls** (asserted in tests and recorded per run as `llm_calls`).
- Fingerprint = sha256(project | kind | signature); open incidents within 24 h are folded (`occurrences++`).
- Lifecycle: DETECTED → INVESTIGATING → DIAGNOSED → WAITING_FOR_APPROVAL → REPAIRING → VERIFYING → RESOLVED / ESCALATED / FAILED (illegal transitions throw).
- The LLM (`incident_diagnosis`) is called only when deterministic confidence < 0.6.
- Remediation (`monitor/remediation.ts`): plan upgrade (OOM/CPU, with API price delta), restart (crash loop), power-on
  DB (DB down), SSL re-provision (TLS), rollback suggestion (release regression), manual steps otherwise.
- After an approved action: wait, re-observe, **verify-delta** (p95, error rate, memory, CPU, error signatures) → RESOLVED only if measurable signals improved and detectors are clear.

## Notifications
In-app inbox (SSE), optional Telegram (`TELEGRAM_BOT_TOKEN/CHAT_ID`), optional email through **Liara Mail API**
(`NOTIFY_MAIL_*`, standing authorization for a single recipient, 24/day). External messages carry only a link; actions
always require login + approval.
