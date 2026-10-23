# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `DEMO_MODE=false requires LIARA_API_TOKEN` at startup | real mode without token | set the token from console.liara.ir → API, or keep demo mode |
| Every Liara call → «توکن دسترسی لیارا نامعتبره» | 401 from Liara | regenerate token; team accounts may need `LIARA_TEAM_ID` |
| QualityGate stages show «در دسترس نیست» | Docker not available | install Docker / start the daemon, or set `SANDBOX_DRIVER=disabled` explicitly |
| `command not allowed in sandbox` | manifest script outside the allow-list | use a standard `npm run <script>` form; the agent never runs arbitrary shell |
| Plan cards empty / «فهرست پلن‌ها دریافت نشد» | `/v1/me` returned no `plans.projects` | type the plan id in chat; check token scope |
| AI features say «پیکربندی نشده» | `AI_API_BASE_URL`/`AI_API_KEY` missing | set both (`https://ai.liara.ir/api/<workspace>/v1`), then `npm run probe:models` |
| A model shows «در دسترس نیست» | last probe failed | fix key/workspace plan, re-run probe; routing skips it meanwhile |
| «سقف هزینه‌ی هوش مصنوعی پر شده» | `AI_DAILY_BUDGET_TOMAN` reached | raise or wait for the next day |
| File Browser / DB inspector actions «ناقص» | host not configured | set `LIARA_FILEBROWSER_URL` / `LIARA_DB_INSPECTOR_URL` (https://*.liara.ir) |
| Approval «منقضی‌شده» | TTL passed (default 10 min) | the agent rebuilds the invoice / ask again |
| Approval «باطل‌شده» | arguments changed after approval | approve the new card |
| UI shows «در حال تلاش برای اتصال مجدد» | SSE disconnected | it reconnects and replays missed events automatically |
| Server restarted mid-deploy | run marked interrupted | resend the request; Liara-side resources created so far are listed in Activity |
| Web on a different port | CORS | add the origin to `WEB_ORIGIN` (comma-separated) |
