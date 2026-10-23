# HTTP API (server :8787)

Auth: if `APP_AUTH_TOKEN` is set, send `Authorization: Bearer <token>` (SSE: `?token=`).
Errors: `{ error: <CODE>, message: <Persian>, detail: <redacted developer detail> }`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/meta` | mode, transport, AI config, sandbox, counts |
| GET | `/api/account` | wallet balance (billing API), hourly spend of apps, runway |
| GET | `/api/events?chatId=&after=` | SSE stream; replay via `Last-Event-ID` / `after` |
| GET/POST/DELETE | `/api/chats`, `/api/chats/:id` | chats + messages |
| POST | `/api/chats/:id/messages` `{text}` | user message (async; results via SSE) |
| POST | `/api/chats/:id/answer` `{cardId, value}` | answer an Ask Card (`"__defer__"` to postpone) |
| POST | `/api/chats/:id/invoice` `{cardId}` | approve every approval listed on the invoice |
| POST | `/api/uploads` (multipart ZIP) | returns `uploadId` for the source card |
| GET | `/api/approvals?status=` · `/api/approvals/:id` | inbox |
| POST | `/api/approvals/:id/decide` `{decision, typedConfirmation?}` | approve / reject (L4 needs typed name) |
| GET | `/api/projects` · `/api/projects/:name` | apps (Liara) merged with agent records |
| GET | `/api/projects/:name/logs?minutes=&level=&search=` | condensed runtime logs |
| GET | `/api/projects/:name/metrics?hours=` | cpu/memory/network series |
| GET/PUT | `/api/projects/:name/patrol` | patrol settings + history |
| POST | `/api/projects/:name/patrol/run` | run now |
| GET | `/api/incidents` · `/api/incidents/:id` | incidents |
| POST | `/api/incidents/:id/ack` · `/notes` · `/recheck` | lifecycle helpers |
| GET | `/api/notifications` · POST `/api/notifications/read` | notification center |
| GET | `/api/audit?kind=&before=&limit=` | append-only activity log |
| GET | `/api/capabilities` | Capability Registry (status, risk, endpoint, evidence) |
| GET | `/api/patches/:id/download` | unified diff |
| GET | `/api/ai/models` · POST `/api/ai/catalog/refresh` · POST `/api/ai/probe` | allowed models, catalog, evaluation |
| GET | `/api/ai/usage?days=` | local ledger + Liara AI workspace activity |
| POST | `/api/demo/scenario` `{app, scenario}` | demo only: healthy, oom, http500, db_down, slow, crash_loop, build_fail_missing_env, bad_release_500, dns_error, timeout, auth_error |

SSE event types are defined once in `packages/shared/src/events.ts`.
