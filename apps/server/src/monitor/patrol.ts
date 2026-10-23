import type { PatrolRunView, PatrolSettings } from "@liara-agent/shared";
import type { Agent } from "../agent/agent.js";
import { json } from "../db/db.js";
import { checksFrom, overall } from "../verify/observe.js";
import { faNum, newId } from "../util.js";
import { detect } from "./detectors.js";

const LEASE_MS = 10 * 60_000;
const JITTER_MS = 5 * 60_000;

/**
 * Patrol (BRIEF §18): durable schedule in `patrol_settings.next_run_at`,
 * per-project DB lease (safe with multiple workers), ±5 min jitter,
 * single catch-up run after downtime, idempotency key per slot.
 * Healthy runs are fully deterministic → zero LLM calls.
 */
export class Patrol {
  private timer: NodeJS.Timeout | null = null;
  readonly owner = newId("worker");
  constructor(private agent: Agent) {}

  private get ctx() {
    return this.agent.ctx;
  }

  start(tickMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), tickMs);
    void this.tick().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  settings(project: string): PatrolSettings | null {
    const r = this.ctx.db.get<{ settings_json: string; next_run_at: string | null; last_run_at: string | null }>("SELECT * FROM patrol_settings WHERE project_name = ?", project);
    if (!r) return null;
    const s = json<PatrolSettings>(r.settings_json, {} as PatrolSettings);
    return { ...s, projectName: project, lastRunAt: r.last_run_at, nextRunAt: r.next_run_at };
  }

  async tick(): Promise<number> {
    const now = this.ctx.clock.now();
    const due = this.ctx.db.all<{ project_name: string; settings_json: string; next_run_at: string | null }>("SELECT * FROM patrol_settings WHERE next_run_at IS NOT NULL AND next_run_at <= ?", now.toISOString());
    let ran = 0;
    for (const d of due) {
      const s = json<PatrolSettings>(d.settings_json, {} as PatrolSettings);
      if (!s.enabled) continue;
      const intervalMs = (s.intervalHours || this.ctx.cfg.monitorIntervalHours) * 3600_000;
      const missed = d.next_run_at ? now.getTime() - Date.parse(d.next_run_at) > intervalMs : false;
      if (!this.acquire(d.project_name, now)) continue;
      try {
        await this.runProject(d.project_name, missed ? "catch_up" : "schedule", d.next_run_at ?? now.toISOString());
        ran++;
      } finally {
        const jitter = Math.round((Math.random() * 2 - 1) * JITTER_MS);
        this.ctx.db.run("UPDATE patrol_settings SET next_run_at = ?, last_run_at = ?, lease_owner = NULL, lease_until = NULL WHERE project_name = ?", new Date(now.getTime() + intervalMs + jitter).toISOString(), now.toISOString(), d.project_name);
      }
    }
    return ran;
  }

  /** Atomic lease: only one worker may patrol a project at a time. */
  private acquire(project: string, now: Date): boolean {
    const r = this.ctx.db.run("UPDATE patrol_settings SET lease_owner = ?, lease_until = ? WHERE project_name = ? AND (lease_until IS NULL OR lease_until < ?)", this.owner, new Date(now.getTime() + LEASE_MS).toISOString(), project, now.toISOString());
    return r.changes === 1;
  }

  async runProject(project: string, trigger: PatrolRunView["trigger"], slot: string): Promise<PatrolRunView | null> {
    const id = newId("pr");
    const startedAt = this.ctx.clock.now().toISOString();
    const key = `${project}|${trigger === "manual" ? startedAt : slot}`;
    try {
      this.ctx.db.run("INSERT INTO patrol_runs(id, project_name, started_at, status, trigger, idempotency_key) VALUES(?,?,?,?,?,?)", id, project, startedAt, "running", trigger, key);
    } catch {
      return null; // this slot already ran
    }
    const callsBefore = Number(this.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM model_calls")?.n ?? 0);
    let status: PatrolRunView["status"] = "healthy";
    let incidentId: string | null = null;
    let checks: PatrolRunView["checks"] = [];
    try {
      const snap = await this.agent.incidents.observe(project);
      const base = this.agent.incidents.baseline(project);
      checks = checksFrom(snap, base);
      const settings = this.settings(project);
      // Wallet runway (official billing endpoint) when enabled.
      if (settings?.checks?.wallet !== false) {
        const bal = await this.ctx.liara.balance().catch(() => null);
        const hourly = (await this.ctx.liara.getApp(project).catch(() => null))?.hourlyPrice ?? null;
        if (bal?.balance !== null && bal?.balance !== undefined && hourly) {
          const days = Math.floor(bal.balance / (hourly * 24));
          checks.push({ key: "wallet", label: "موجودی کیف پول", status: days < 3 ? "FAIL" : days < 7 ? "WARN" : "PASS", value: `${faNum(days)} روز`, baseline: null, threshold: "۷ روز", evidence: "GET /v1/billing ÷ hourlyPrice این برنامه", at: new Date().toISOString() });
        }
      }
      const anomalies = detect(snap, base, { nowMs: this.ctx.clock.now().getTime() });
      status = anomalies.length ? (anomalies.some((a) => a.severity === "HIGH" || a.severity === "CRITICAL") ? "unhealthy" : "warning") : overall(checks) === "healthy" ? "healthy" : "warning";
      if (!anomalies.length) {
        this.agent.incidents.updateBaseline(project, snap);
      } else {
        const a = anomalies[0]!;
        const { incident, created } = this.ctx.incidents.upsertFromAnomaly(project, a, { snapshot: snap });
        incidentId = incident.id;
        if (created) {
          this.ctx.incidents.setBefore(incident.id, snap);
          // Standing authorization: auto-restart on crash loop (policy-capped, audited).
          if (a.kind === "crash_loop" && settings?.autoRestartOnCrashLoop) {
            const out = await this.ctx.gateway.run({ capabilityId: "paas.restartApp", req: { pathParams: { name: project } }, resource: project, title: `ری‌استارت خودکار ${project}`, reason: "crash loop (اجازه‌ی خودکار)", effect: "ری‌استارت" }, { actor: "patrol", chatId: null, runId: null, incidentId: incident.id, projectName: project });
            if (out.status === "executed") await this.agent.incidents.verifyAfter(incident.id, null);
            else await this.agent.incidents.investigate(incident, a, snap, null);
          } else {
            await this.agent.incidents.investigate(incident, a, snap, null);
          }
          this.ctx.notifier.push({ kind: "incident", title: `${project}: ${a.title}`, body: a.evidence.slice(0, 2).join(" · "), severity: a.severity === "LOW" ? "info" : a.severity === "MEDIUM" ? "warning" : "critical", href: `/incidents?id=${incident.id}` }, { dedupeKey: `inc:${incident.id}`, external: settings?.channels?.telegram || settings?.channels?.email });
        }
      }
    } catch (e) {
      status = "error";
      checks.push({ key: "patrol", label: "اجرای پایش", status: "FAIL", value: null, baseline: null, threshold: null, evidence: (e as Error).message.slice(0, 200), at: new Date().toISOString() });
    }
    const llmCalls = Number(this.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM model_calls")?.n ?? 0) - callsBefore;
    this.ctx.db.run("UPDATE patrol_runs SET finished_at = ?, status = ?, checks_json = ?, llm_calls = ?, incident_id = ? WHERE id = ?", this.ctx.clock.now().toISOString(), status, JSON.stringify(checks), llmCalls, incidentId, id);
    const run = this.get(id)!;
    this.ctx.bus.emit("patrol.run", { run });
    return run;
  }

  get(id: string): PatrolRunView | null {
    const r = this.ctx.db.get<Record<string, unknown>>("SELECT * FROM patrol_runs WHERE id = ?", id);
    return r ? toView(r) : null;
  }

  history(project: string, limit = 24): PatrolRunView[] {
    return this.ctx.db.all<Record<string, unknown>>("SELECT * FROM patrol_runs WHERE project_name = ? ORDER BY started_at DESC LIMIT ?", project, limit).map(toView);
  }
}

function toView(r: Record<string, unknown>): PatrolRunView {
  return {
    id: String(r.id),
    projectName: String(r.project_name),
    startedAt: String(r.started_at),
    finishedAt: (r.finished_at as string) ?? null,
    status: r.status as PatrolRunView["status"],
    checks: json(r.checks_json, []),
    llmCalls: Number(r.llm_calls),
    incidentId: (r.incident_id as string) ?? null,
    trigger: r.trigger as PatrolRunView["trigger"],
  };
}
