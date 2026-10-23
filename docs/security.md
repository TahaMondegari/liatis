# Security

| Threat | Control | Where |
|---|---|---|
| Model calls arbitrary endpoints | Only OpenAPI-generated operations; Mega Tools expose enum actions with zod-validated args; undeclared query params and path traversal rejected | `liara/transport.ts`, `tools/mega.ts` |
| SSRF | HTTPS + host allow-list for Liara; repo URLs: https only, no credentials, DNS-resolved private ranges refused; health probes refuse private IPs | `httpTransport.ts`, `workspace/source.ts`, `verify/prober.ts` |
| Unapproved mutation | PolicyEngine: L0/L1 allow (patrol L1 only within caps), L2/L3 approval, L4 approval + typed name; standing authorizations only for restart-on-crash-loop (1/24h) and alert email | `policy/policy.ts` |
| Forged / stale approval | Approvals created server-side; decided only via authenticated UI endpoint; TTL; scope hash of exact capability+resource+args (+file digest); transactional single-use consume; changed args → invalidated | `policy/approvals.ts` |
| Secret leakage | Env values entered in a secret form → AES-256-GCM `SecretStore`; approvals/state hold `{{secret:KEY}}`; DATABASE_URL composed server-side from raw DB record; recursive redaction on SSE, audit, prompts, logs, tool results; registered exact-value scrubbing for tokens | `security/*` |
| Prompt injection from repo/logs | Repo text, logs and tool output passed as data with explicit "untrusted" system instructions; model cannot approve; model output never executed as shell | `ai/*`, `agent/opsAgent.ts`, `rca/rca.ts` |
| Untrusted code execution | Docker only: non-root, `--cap-drop ALL`, `no-new-privileges`, CPU/RAM/PID caps, no network except install, timeouts, bounded output; allow-listed command shapes → argv (no shell); child env allow-list (no tokens) | `sandbox/sandbox.ts` |
| Zip slip / bombs | Path normalisation + root containment, size and file-count caps, expansion ratio cap | `workspace/source.ts` |
| Test weakening | CodingAgent refuses edits to tests, lockfiles, env, CI files; original tree hash checked before/after | `repair/coding.ts`, `agent/deployFlow.ts` |
| Demo hitting real infra | Demo mode refuses non-mock transports at construction and in the policy engine | `context.ts`, `policy/policy.ts` |
| Audit tampering | SQLite triggers reject UPDATE/DELETE on `audit` | `db/migrations.ts` |
| API abuse | Optional `APP_AUTH_TOKEN` (Bearer / `?token=` for SSE), 120 writes/min/IP rate limit, body size limits | `routes.ts`, `index.ts` |

Deployment notes: put the API behind TLS and set `APP_AUTH_TOKEN`; keep `data/secret.key` private (0600); never
commit `.env`. The web UI stores the app token in `localStorage` only if the server requires one.
