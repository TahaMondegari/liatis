import type { Hypothesis, IncidentState, IncidentView, Severity } from "@liara-agent/shared";
import type { Db } from "../db/db.js";
import { json } from "../db/db.js";
import type { EventBus } from "../events/bus.js";
import { type Clock, faNum, newId, sha256 } from "../util.js";
import type { Anomaly } from "./detectors.js";

const OPEN_STATES: IncidentState[] = ["DETECTED", "INVESTIGATING", "DIAGNOSED", "WAITING_FOR_APPROVAL", "REPAIRING", "VERIFYING", "ESCALATED"];
const DEDUPE_WINDOW_MS = 24 * 3600_000;

const ALLOWED: Record<IncidentState, IncidentState[]> = {
  DETECTED: ["INVESTIGATING", "DIAGNOSED", "RESOLVED", "ESCALATED", "FAILED"],
  INVESTIGATING: ["DIAGNOSED", "ESCALATED", "FAILED", "RESOLVED"],
  DIAGNOSED: ["WAITING_FOR_APPROVAL", "REPAIRING", "ESCALATED", "RESOLVED", "FAILED"],
  WAITING_FOR_APPROVAL: ["REPAIRING", "DIAGNOSED", "ESCALATED", "FAILED", "RESOLVED"],
  REPAIRING: ["VERIFYING", "FAILED", "ESCALATED"],
  VERIFYING: ["RESOLVED", "FAILED", "ESCALATED", "DIAGNOSED"],
  RESOLVED: ["DETECTED"],
  FAILED: ["INVESTIGATING", "ESCALATED", "RESOLVED"],
  ESCALATED: ["INVESTIGATING", "RESOLVED", "FAILED"],
};

export const STATE_FA: Record<IncidentState, string> = {
  DETECTED: "جدید",
  INVESTIGATING: "در حال بررسی",
  DIAGNOSED: "علت پیدا شد",
  WAITING_FOR_APPROVAL: "منتظر تأیید",
  REPAIRING: "در حال اصلاح",
  VERIFYING: "بررسی مجدد",
  RESOLVED: "حل‌شده",
  FAILED: "ناموفق",
  ESCALATED: "ارجاع‌شده",
};

/** Incident engine with fingerprint deduplication (BRIEF §18.4, §19). */
export class IncidentService {
  constructor(
    private db: Db,
    private bus: EventBus,
    private clock: Clock,
  ) {}

  fingerprint(project: string, a: Pick<Anomaly, "kind" | "signature">): string {
    return sha256(`${project}|${a.kind}|${a.signature}`).slice(0, 24);
  }

  /** Create a new incident or fold into the open one with the same fingerprint. */
  upsertFromAnomaly(project: string, a: Anomaly, evidence: unknown): { incident: IncidentView; created: boolean } {
    const fp = this.fingerprint(project, a);
    const now = this.clock.now();
    const open = this.db.get<Record<string, unknown>>(
      `SELECT * FROM incidents WHERE project_name = ? AND fingerprint = ? AND state IN (${OPEN_STATES.map(() => "?").join(",")}) ORDER BY started_at DESC LIMIT 1`,
      project,
      fp,
      ...OPEN_STATES,
    );
    if (open && now.getTime() - Date.parse(String(open.updated_at)) < DEDUPE_WINDOW_MS) {
      const tl = json<IncidentView["timeline"]>(open.timeline_json, []);
      tl.push({ at: now.toISOString(), label: `دوباره دیده شد (×${faNum(Number(open.occurrences) + 1)})`, kind: "recurrence" });
      this.db.run("UPDATE incidents SET occurrences = occurrences + 1, updated_at = ?, timeline_json = ?, evidence_json = ? WHERE id = ?", now.toISOString(), JSON.stringify(tl.slice(-50)), JSON.stringify(evidence), String(open.id));
      const v = this.get(String(open.id))!;
      this.bus.emit("incident.updated", { incident: v });
      return { incident: v, created: false };
    }
    // A resolved incident that recurs gets a new incident linked in the title note.
    const recurred = this.db.get<{ code: string }>("SELECT 'INC-' || seq AS code FROM incidents WHERE project_name = ? AND fingerprint = ? ORDER BY started_at DESC LIMIT 1", project, fp);
    const seq = Number(this.db.get<{ n: number | null }>("SELECT MAX(seq) AS n FROM incidents")?.n ?? 0) + 1;
    const id = newId("inc");
    const top = [...a.hypotheses].sort((x, y) => y.confidence - x.confidence)[0];
    const timeline = [{ at: now.toISOString(), label: "شروع رخداد", kind: "detected" }];
    if (recurred) timeline.push({ at: now.toISOString(), label: `دوباره رخ داده (قبلاً ${recurred.code})`, kind: "recurrence" });
    this.db.run(
      `INSERT INTO incidents(id, seq, project_name, fingerprint, title, severity, state, service, environment, started_at, updated_at, probable_cause, confidence, hypotheses_json, timeline_json, impact, evidence_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      seq,
      project,
      fp,
      a.title,
      a.severity,
      "DETECTED",
      "web",
      null,
      now.toISOString(),
      now.toISOString(),
      top?.title ?? null,
      top?.confidence ?? null,
      JSON.stringify(a.hypotheses),
      JSON.stringify(timeline),
      a.metrics.find((m) => m.label === "نرخ خطا" && m.tone === "bad") ? `خطای ۵۰۰ برای حدود ${a.metrics.find((m) => m.label === "نرخ خطا")!.value} درخواست‌ها` : null,
      JSON.stringify(evidence),
    );
    const v = this.get(id)!;
    this.bus.emit("incident.updated", { incident: v });
    return { incident: v, created: true };
  }

  transition(id: string, to: IncidentState, label: string, patch: Partial<{ probableCause: string; confidence: number; hypotheses: Hypothesis[]; approvalId: string | null; severity: Severity }> = {}): IncidentView {
    const r = this.db.get<Record<string, unknown>>("SELECT * FROM incidents WHERE id = ?", id);
    if (!r) throw new Error("incident not found");
    const from = r.state as IncidentState;
    if (from !== to && !ALLOWED[from].includes(to)) throw new Error(`illegal incident transition ${from} → ${to}`);
    const now = this.clock.now().toISOString();
    const tl = json<IncidentView["timeline"]>(r.timeline_json, []);
    tl.push({ at: now, label, kind: to.toLowerCase() });
    this.db.run(
      `UPDATE incidents SET state = ?, updated_at = ?, timeline_json = ?, resolved_at = CASE WHEN ? = 'RESOLVED' THEN ? ELSE resolved_at END,
       probable_cause = COALESCE(?, probable_cause), confidence = COALESCE(?, confidence), hypotheses_json = COALESCE(?, hypotheses_json),
       approval_id = CASE WHEN ? THEN ? ELSE approval_id END, severity = COALESCE(?, severity) WHERE id = ?`,
      to,
      now,
      JSON.stringify(tl.slice(-50)),
      to,
      now,
      patch.probableCause ?? null,
      patch.confidence ?? null,
      patch.hypotheses ? JSON.stringify(patch.hypotheses) : null,
      patch.approvalId !== undefined ? 1 : 0,
      patch.approvalId ?? null,
      patch.severity ?? null,
      id,
    );
    const v = this.get(id)!;
    this.bus.emit("incident.updated", { incident: v });
    return v;
  }

  setBefore(id: string, before: unknown): void {
    this.db.run("UPDATE incidents SET before_json = ? WHERE id = ?", JSON.stringify(before), id);
  }

  before<T>(id: string): T | null {
    return json<T | null>(this.db.get<{ before_json: string }>("SELECT before_json FROM incidents WHERE id = ?", id)?.before_json, null);
  }

  evidence<T>(id: string): T | null {
    return json<T | null>(this.db.get<{ evidence_json: string }>("SELECT evidence_json FROM incidents WHERE id = ?", id)?.evidence_json, null);
  }

  acknowledge(id: string): IncidentView {
    this.db.run("UPDATE incidents SET acknowledged = 1, updated_at = ? WHERE id = ?", this.clock.now().toISOString(), id);
    return this.get(id)!;
  }

  addNote(id: string, text: string): IncidentView {
    const r = this.db.get<{ notes_json: string }>("SELECT notes_json FROM incidents WHERE id = ?", id);
    const notes = json<{ at: string; text: string }[]>(r?.notes_json, []);
    notes.push({ at: this.clock.now().toISOString(), text: text.slice(0, 2000) });
    this.db.run("UPDATE incidents SET notes_json = ? WHERE id = ?", JSON.stringify(notes), id);
    return this.get(id)!;
  }

  get(id: string): IncidentView | null {
    const r = this.db.get<Record<string, unknown>>("SELECT * FROM incidents WHERE id = ? OR ('INC-' || seq) = ?", id, id);
    return r ? this.toView(r) : null;
  }

  list(filter: { project?: string; openOnly?: boolean; limit?: number } = {}): IncidentView[] {
    return this.db
      .all<Record<string, unknown>>(
        `SELECT * FROM incidents WHERE (? IS NULL OR project_name = ?) AND (? = 0 OR state NOT IN ('RESOLVED','FAILED')) ORDER BY started_at DESC LIMIT ?`,
        filter.project ?? null,
        filter.project ?? null,
        filter.openOnly ? 1 : 0,
        filter.limit ?? 100,
      )
      .map((r) => this.toView(r));
  }

  openCount(project?: string): number {
    return Number(this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM incidents WHERE state NOT IN ('RESOLVED','FAILED') AND (? IS NULL OR project_name = ?)`, project ?? null, project ?? null)?.n ?? 0);
  }

  private toView(r: Record<string, unknown>): IncidentView {
    return {
      id: String(r.id),
      code: `INC-${faNum(Number(r.seq), { useGrouping: false })}`,
      projectName: String(r.project_name),
      title: String(r.title),
      severity: r.severity as Severity,
      state: r.state as IncidentState,
      service: (r.service as string) ?? null,
      environment: (r.environment as string) ?? null,
      startedAt: String(r.started_at),
      updatedAt: String(r.updated_at),
      resolvedAt: (r.resolved_at as string) ?? null,
      occurrences: Number(r.occurrences),
      probableCause: (r.probable_cause as string) ?? null,
      confidence: (r.confidence as number) ?? null,
      fingerprint: String(r.fingerprint),
      hypotheses: json<Hypothesis[]>(r.hypotheses_json, []),
      timeline: json<IncidentView["timeline"]>(r.timeline_json, []),
      impact: (r.impact as string) ?? null,
      approvalId: (r.approval_id as string) ?? null,
      notes: json<{ at: string; text: string }[]>(r.notes_json, []),
      acknowledged: Boolean(r.acknowledged),
    };
  }
}
