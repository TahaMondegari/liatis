import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProjectSummary, PatrolSettings } from "@liara-agent/shared";
import type { Agent } from "./agent/agent.js";
import { savePatrolSettings, uploads } from "./agent/deployFlow.js";
import { json } from "./db/db.js";
import { AgentError, ERROR_FA, isAgentError, toAgentError } from "./errors.js";
import type { Patrol } from "./monitor/patrol.js";
import type { Scenario } from "./demo/world.js";
import { probeModels } from "./ai/probe.js";
import { redact } from "./security/redact.js";
import { newId } from "./util.js";
import { condenseLogs } from "./rca/rca.js";

const parse = <T extends z.ZodTypeAny>(schema: T, v: unknown): z.infer<T> => {
  const r = schema.safeParse(v);
  if (!r.success) throw new AgentError("VALIDATION", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
};

export function registerRoutes(app: FastifyInstance, agent: Agent, patrol: Patrol): void {
  const ctx = agent.ctx;

  // ---- auth + rate limiting ----------------------------------------------
  const hits = new Map<string, { n: number; reset: number }>();
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/") || req.url === "/api/health") return;
    if (ctx.cfg.authToken) {
      const q = (req.query as Record<string, string> | undefined)?.token;
      const h = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (h !== ctx.cfg.authToken && q !== ctx.cfg.authToken) return reply.code(401).send({ error: "AUTHENTICATION", message: "unauthorized" });
    }
    if (req.method !== "GET") {
      const k = req.ip;
      const now = Date.now();
      const e = hits.get(k);
      if (!e || e.reset < now) hits.set(k, { n: 1, reset: now + 60_000 });
      else if (++e.n > 120) return reply.code(429).send({ error: "RATE_LIMIT", message: ERROR_FA.RATE_LIMIT });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const e = isAgentError(err) ? err : toAgentError(err);
    const status = e.code === "VALIDATION" ? 400 : e.code === "NOT_FOUND" ? 404 : e.code === "CONFLICT" ? 409 : e.code === "AUTHENTICATION" ? 401 : e.code === "APPROVAL_REQUIRED" ? 403 : e.code === "UNSAFE_OPERATION" ? 403 : e.code === "RATE_LIMIT" ? 429 : 500;
    reply.code(status).send({ error: e.code, message: ERROR_FA[e.code], detail: redact(e.message).slice(0, 500) });
  });

  // ---- meta -------------------------------------------------------------
  app.get("/api/health", async () => ({ ok: true, mode: ctx.cfg.mode }));
  app.get("/api/meta", async () => {
    const sb = await ctx.sandbox.available();
    return {
      mode: ctx.cfg.mode,
      liaraTransport: ctx.transport.kind,
      ai: { configured: ctx.llm.configured, workspaceId: ctx.cfg.ai.workspaceId, catalogFetchedAt: ctx.models.catalogFetchedAt, todayToman: ctx.llm.spentTodayToman(), dailyBudgetToman: ctx.cfg.ai.dailyBudgetToman },
      sandbox: { kind: ctx.sandbox.kind, label: ctx.sandbox.label, available: sb.ok, reason: sb.reason },
      pendingApprovals: ctx.approvals.pendingCount(),
      unreadNotifications: ctx.notifier.unread(),
      openIncidents: ctx.incidents.openCount(),
      maxRepairAttempts: ctx.cfg.maxRepairAttempts,
      monitorIntervalHours: ctx.cfg.monitorIntervalHours,
    };
  });

  app.get("/api/account", async () => {
    const [bal, me] = await Promise.all([ctx.liara.balance().catch(() => null), ctx.client.readSafe<{ user?: { fullname?: string; email?: string; isTeam?: boolean } }>("account.getMe").catch(() => null)]);
    const apps = await ctx.liara.listApps().catch(() => []);
    let hourly = 0;
    let unknown = 0;
    for (const a of apps) {
      if (a.scale === 0) continue;
      const d = await ctx.liara.getApp(a.name).catch(() => null);
      if (d?.hourlyPrice) hourly += d.hourlyPrice;
      else unknown++;
    }
    return { balance: bal?.balance ?? null, user: me?.user ? { name: me.user.fullname ?? null, team: Boolean(me.user.isTeam) } : null, hourlyToman: hourly || null, unknownPriced: unknown, activeServices: apps.filter((a) => a.scale !== 0).length, runwayDays: bal?.balance && hourly ? Math.floor(bal.balance / (hourly * 24)) : null, source: "GET /v1/billing + PaaS hourlyPrice" };
  });

  // ---- SSE ----------------------------------------------------------------
  app.get("/api/events", async (req, reply) => {
    const q = req.query as { chatId?: string; after?: string };
    const chatId = q.chatId ?? null;
    const lastId = Number(req.headers["last-event-id"] ?? q.after ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", "Access-Control-Allow-Origin": ctx.cfg.webOrigins.includes(String(req.headers.origin)) ? String(req.headers.origin) : ctx.cfg.webOrigin, Vary: "Origin" });
    res.flushHeaders();
    res.write(": connected\n\n");
    const send = (e: { seq: number; type: string; chatId: string | null }) => {
      if (chatId && e.chatId && e.chatId !== chatId) return;
      res.write(`${e.seq ? `id: ${e.seq}\n` : ""}event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    if (lastId) for (const e of ctx.bus.replay(lastId, chatId)) send(e);
    const unsub = ctx.bus.subscribe(send);
    const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      unsub();
    });
  });

  // ---- chats ------------------------------------------------------------
  app.get("/api/chats", async () => agent.chat.list());
  app.post("/api/chats", async (req) => {
    const b = parse(z.object({ title: z.string().max(80).optional(), projectName: z.string().max(64).nullable().optional() }), req.body ?? {});
    return agent.chat.create(b.title, b.projectName ?? null);
  });
  app.get("/api/chats/:id", async (req) => {
    const { id } = req.params as { id: string };
    const s = agent.chat.summary(id);
    if (!s) throw new AgentError("NOT_FOUND", "chat not found");
    const run = agent.runs.activeForChat(id);
    return { chat: s, messages: agent.chat.messages(id), activeRun: run ? { id: run.id, kind: run.kind, status: run.status, step: run.step } : null, lastSeq: Number(ctx.db.get<{ s: number }>("SELECT MAX(seq) s FROM events")?.s ?? 0) };
  });
  app.delete("/api/chats/:id", async (req) => {
    agent.chat.remove((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post("/api/chats/:id/messages", async (req) => {
    const b = parse(z.object({ text: z.string().min(1).max(4000) }), req.body);
    await agent.userMessage((req.params as { id: string }).id, b.text);
    return { ok: true };
  });
  app.post("/api/chats/:id/answer", async (req) => {
    const b = parse(z.object({ cardId: z.string(), value: z.unknown() }), req.body);
    await agent.answer((req.params as { id: string }).id, b.cardId, b.value);
    return { ok: true };
  });
  app.post("/api/chats/:id/invoice", async (req) => {
    const b = parse(z.object({ cardId: z.string() }), req.body);
    await agent.approveInvoice((req.params as { id: string }).id, b.cardId, "user");
    return { ok: true };
  });

  // ---- uploads (ZIP) ------------------------------------------------------
  app.post("/api/uploads", async (req) => {
    const file = await req.file({ limits: { fileSize: 200 * 1024 * 1024 } });
    if (!file) throw new AgentError("VALIDATION", "file is required");
    if (!/\.zip$/i.test(file.filename)) throw new AgentError("VALIDATION", "فقط فایل ZIP قبول می‌شه");
    const buf = await file.toBuffer();
    const id = newId("up");
    uploads.set(id, { name: file.filename, data: new Uint8Array(buf), at: Date.now() });
    for (const [k, v] of uploads) if (Date.now() - v.at > 3600_000) uploads.delete(k);
    return { uploadId: id, name: file.filename, bytes: buf.byteLength };
  });

  // ---- approvals --------------------------------------------------------
  app.get("/api/approvals", async (req) => {
    const q = req.query as { status?: string };
    return ctx.approvals.list({ status: (q.status as never) ?? "all", limit: 200 });
  });
  app.get("/api/approvals/:id", async (req) => {
    const a = ctx.approvals.get((req.params as { id: string }).id);
    if (!a) throw new AgentError("NOT_FOUND", "approval not found");
    return a;
  });
  app.post("/api/approvals/:id/decide", async (req) => {
    const b = parse(z.object({ decision: z.enum(["approve", "reject"]), typedConfirmation: z.string().max(200).nullable().optional() }), req.body);
    return agent.decide((req.params as { id: string }).id, b.decision, b.typedConfirmation ?? null, "user");
  });

  // ---- projects ---------------------------------------------------------
  app.get("/api/projects", async () => {
    const apps = await ctx.liara.listApps();
    const out: ProjectSummary[] = [];
    for (const a of apps) {
      const local = ctx.db.get<Record<string, unknown>>("SELECT * FROM projects WHERE name = ?", a.name);
      const lastDep = ctx.db.get<{ finished_at: string }>("SELECT finished_at FROM deployments WHERE project_name = ? ORDER BY started_at DESC LIMIT 1", a.name);
      const lastRun = ctx.db.get<{ status: string }>("SELECT status FROM patrol_runs WHERE project_name = ? ORDER BY started_at DESC LIMIT 1", a.name);
      const open = ctx.incidents.openCount(a.name);
      const health: ProjectSummary["health"] = a.scale === 0 ? "stopped" : open ? (ctx.incidents.list({ project: a.name, openOnly: true }).some((i) => i.severity === "HIGH" || i.severity === "CRITICAL") ? "failing" : "warning") : lastRun ? (lastRun.status === "healthy" ? "healthy" : lastRun.status === "unhealthy" ? "failing" : "warning") : ((local?.health as ProjectSummary["health"]) ?? "unknown");
      const dom = await ctx.liara.domains(a.name).catch(() => []);
      out.push({
        name: a.name,
        platform: a.platform,
        status: a.status,
        planId: a.planId,
        environment: (local?.environment as string) ?? null,
        health,
        lastDeployAt: lastDep?.finished_at ?? (local?.last_deploy_at as string) ?? null,
        primaryDomain: dom[0]?.name ?? null,
        openIncidents: open,
        hourlyPriceToman: null,
        patrolEnabled: Boolean(patrol.settings(a.name)?.enabled),
        source: ctx.transport.kind === "mock" ? "mock" : "liara",
      });
    }
    return out;
  });

  app.get("/api/projects/:name", async (req) => {
    const { name } = req.params as { name: string };
    const info = await ctx.liara.getApp(name);
    if (!info) throw new AgentError("NOT_FOUND", "app not found");
    const [releases, domains, applets, disks] = await Promise.all([ctx.liara.releases(name, 10).catch(() => null), ctx.liara.domains(name).catch(() => []), ctx.liara.applets(name).catch(() => []), ctx.client.readSafe("paas.getDisks", { pathParams: { id: name } }).catch(() => null)]);
    const plan = await agent.kit.plans.ramOf(info.planId);
    return {
      app: info,
      plan,
      releases,
      domains,
      applets,
      disks,
      deployments: ctx.db.all("SELECT id, release_id, status, started_at, finished_at, platform, port FROM deployments WHERE project_name = ? ORDER BY started_at DESC LIMIT 20", name),
      patrol: patrol.settings(name),
      incidents: ctx.incidents.list({ project: name, limit: 20 }),
      profile: json(ctx.db.get<{ profile_json: string }>("SELECT profile_json FROM projects WHERE name = ?", name)?.profile_json, null),
    };
  });

  app.get("/api/projects/:name/logs", async (req) => {
    const { name } = req.params as { name: string };
    const q = req.query as { minutes?: string; level?: string; search?: string };
    const minutes = Math.min(Math.max(Number(q.minutes ?? 30), 5), 7 * 24 * 60);
    const lines = await ctx.liara.logs(name, Math.floor(ctx.clock.now().getTime() / 1000) - minutes * 60);
    const levelOf = (m: string, t: string) => (/error|exception|fatal|killed|refused|exit code [1-9]/i.test(m) || t === "stderr" ? "ERROR" : /warn|slow/i.test(m) ? "WARN" : "INFO");
    let rows = lines.map((l) => ({ at: l.datetime, type: l.type, level: levelOf(l.message, l.type), message: redact(l.message) }));
    if (q.level) rows = rows.filter((r) => q.level!.split(",").includes(r.level));
    if (q.search) rows = rows.filter((r) => r.message.toLowerCase().includes(q.search!.toLowerCase().slice(0, 100)));
    return { lines: rows.slice(-1000), groups: condenseLogs(lines), source: "paas.getAppLogs", downloadSupported: false };
  });

  app.get("/api/projects/:name/metrics", async (req) => {
    const { name } = req.params as { name: string };
    const hours = Math.min(Math.max(Number((req.query as { hours?: string }).hours ?? 6), 1), 24 * 30);
    const since = Math.floor(ctx.clock.now().getTime() / 1000) - hours * 3600;
    const kinds = ["cpu", "memory", "network-receive", "network-transmit"] as const;
    const series = await Promise.all(kinds.map((k) => ctx.liara.metric(name, k, since).catch(() => null)));
    return { series: series.filter(Boolean), plan: await agent.kit.plans.ramOf((await ctx.liara.getApp(name))?.planId ?? null) };
  });

  // ---- patrol -----------------------------------------------------------
  app.get("/api/projects/:name/patrol", async (req) => {
    const { name } = req.params as { name: string };
    return { settings: patrol.settings(name), history: patrol.history(name, 24) };
  });
  app.put("/api/projects/:name/patrol", async (req) => {
    const { name } = req.params as { name: string };
    const b = parse(
      z.object({
        enabled: z.boolean().optional(),
        intervalHours: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12), z.literal(24)]).optional(),
        healthUrl: z.string().regex(/^\/[\w\-./]*$/).nullable().optional(),
        checks: z.record(z.string(), z.boolean()).optional(),
        channels: z.object({ inApp: z.boolean(), telegram: z.boolean(), email: z.boolean() }).optional(),
        autoRestartOnCrashLoop: z.boolean().optional(),
      }),
      req.body,
    );
    savePatrolSettings(agent.kit, name, b as Partial<PatrolSettings>);
    if (b.intervalHours) ctx.db.run("UPDATE patrol_settings SET next_run_at = ? WHERE project_name = ?", new Date(ctx.clock.now().getTime() + b.intervalHours * 3600_000).toISOString(), name);
    return patrol.settings(name);
  });
  app.post("/api/projects/:name/patrol/run", async (req) => {
    const { name } = req.params as { name: string };
    return patrol.runProject(name, "manual", new Date().toISOString());
  });

  // ---- incidents -------------------------------------------------------
  app.get("/api/incidents", async (req) => {
    const q = req.query as { project?: string; open?: string };
    return ctx.incidents.list({ project: q.project, openOnly: q.open === "1", limit: 200 });
  });
  app.get("/api/incidents/:id", async (req) => {
    const i = ctx.incidents.get((req.params as { id: string }).id);
    if (!i) throw new AgentError("NOT_FOUND", "incident not found");
    return { incident: i, evidence: redact(ctx.incidents.evidence(i.id)), approval: i.approvalId ? ctx.approvals.get(i.approvalId) : null };
  });
  app.post("/api/incidents/:id/ack", async (req) => ctx.incidents.acknowledge((req.params as { id: string }).id));
  app.post("/api/incidents/:id/notes", async (req) => ctx.incidents.addNote((req.params as { id: string }).id, parse(z.object({ text: z.string().min(1).max(2000) }), req.body).text));
  app.post("/api/incidents/:id/recheck", async (req) => {
    const i = ctx.incidents.get((req.params as { id: string }).id);
    if (!i) throw new AgentError("NOT_FOUND", "incident not found");
    return patrol.runProject(i.projectName, "manual", new Date().toISOString());
  });

  // ---- notifications / audit / capabilities -----------------------------
  app.get("/api/notifications", async () => ({ items: ctx.notifier.list(50), unread: ctx.notifier.unread() }));
  app.post("/api/notifications/read", async (req) => {
    ctx.notifier.markRead(parse(z.object({ id: z.string() }), req.body).id);
    return { ok: true };
  });
  app.get("/api/audit", async (req) => {
    const q = req.query as { before?: string; kind?: string; limit?: string };
    return ctx.audit.list({ before: q.before, kind: q.kind, limit: Number(q.limit ?? 100) });
  });
  app.get("/api/capabilities", async () => ctx.registry.views());

  // ---- patches ------------------------------------------------------------
  app.get("/api/patches/:id/download", async (req, reply) => {
    const r = ctx.db.get<{ files_json: string }>("SELECT files_json FROM patches WHERE id = ?", (req.params as { id: string }).id);
    if (!r) throw new AgentError("NOT_FOUND", "patch not found");
    const files = (JSON.parse(r.files_json) as { files: { diff: string }[] }).files;
    reply.header("Content-Type", "text/x-diff; charset=utf-8").header("Content-Disposition", `attachment; filename="${(req.params as { id: string }).id}.patch"`);
    return files.map((f) => f.diff).join("\n");
  });

  // ---- AI (Liara AI workspace + local gateway ledger) --------------------
  app.get("/api/ai/models", async () => ({ models: ctx.models.views(), catalogFetchedAt: ctx.models.catalogFetchedAt, catalogError: ctx.models.catalogError, roles: ctx.models.config.roles }));
  app.post("/api/ai/catalog/refresh", async () => {
    await ctx.models.refreshCatalog();
    return { ok: !ctx.models.catalogError, error: ctx.models.catalogError };
  });
  app.post("/api/ai/probe", async () => probeModels(ctx));
  app.get("/api/ai/usage", async (req) => {
    const days = Number((req.query as { days?: string }).days ?? 7);
    const local = ctx.llm.usageSummary(days);
    let workspace: unknown = null;
    let workspaceError: string | null = null;
    if (ctx.cfg.ai.workspaceId && (ctx.cfg.mode === "real" || ctx.transport.kind === "http")) {
      try {
        workspace = await ctx.client.readSafe("ai_workspaces.getWorkspaceActivity", { pathParams: { workspaceID: ctx.cfg.ai.workspaceId }, query: { filter: days <= 1 ? "day" : days <= 7 ? "week" : "month" } });
      } catch (e) {
        workspaceError = toAgentError(e).message.slice(0, 200);
      }
    } else workspaceError = ctx.cfg.mode === "demo" ? "در حالت دمو به API ورک‌اسپیس وصل نمی‌شه." : "AI_WORKSPACE_ID تنظیم نشده.";
    return { local, workspace, workspaceError };
  });

  // ---- demo controls (demo mode only) -----------------------------------
  app.post("/api/demo/scenario", async (req) => {
    if (ctx.cfg.mode !== "demo" || !ctx.world) throw new AgentError("UNSAFE_OPERATION", "demo controls are disabled in real mode");
    const b = parse(z.object({ app: z.string(), scenario: z.enum(["healthy", "oom", "http500", "db_down", "slow", "crash_loop", "build_fail_missing_env", "bad_release_500", "dns_error", "timeout", "auth_error"]) }), req.body);
    if (b.scenario === "auth_error" || b.scenario === "timeout") ctx.world.globalFault = b.scenario;
    else {
      ctx.world.globalFault = "none";
      ctx.world.setScenario(b.app, b.scenario as Scenario);
    }
    ctx.audit.record({ actor: "user", kind: "demo.scenario", resource: b.app, status: b.scenario });
    return { ok: true };
  });
}
