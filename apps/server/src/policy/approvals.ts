import type { ApprovalStatus, ApprovalView, Money, RiskLevel } from "@liara-agent/shared";
import type { Db } from "../db/db.js";
import { json } from "../db/db.js";
import { AgentError } from "../errors.js";
import type { LiaraRequest } from "../liara/transport.js";
import { redact } from "../security/redact.js";
import { type Clock, newId, sha256, stableStringify } from "../util.js";

export interface ApprovalDraft {
  chatId: string | null;
  runId: string | null;
  incidentId?: string | null;
  projectName: string | null;
  capabilityId: string;
  tool: string;
  action: string;
  req: LiaraRequest;
  resource: string;
  risk: RiskLevel;
  typedConfirmation: boolean;
  title: string;
  toolLabel: string;
  reason: string;
  evidence: string[];
  currentValue?: string | null;
  proposedValue?: string | null;
  diff?: string | null;
  effect: string;
  downtime?: string | null;
  reversible?: string | null;
  cost?: Money | null;
  scope: string;
}

/** Hash of exactly what will execute. Any change → approval no longer matches. */
export function scopeHash(capabilityId: string, resource: string, req: LiaraRequest): string {
  const fileDigest = req.file ? sha256(Buffer.from(req.file.data).toString("base64")) : null;
  return sha256(stableStringify({ capabilityId, resource, pathParams: req.pathParams ?? {}, query: req.query ?? {}, body: req.body ?? null, file: fileDigest }));
}

/**
 * Server-side approvals (BRIEF §14.2):
 * - approval covers ONE exact action (capability + resource + arguments hash)
 * - TTL (default 10 min); expired approvals cannot be consumed
 * - L4 needs the typed resource name
 * - consumption is transactional and single-use
 * - approvals only come from the authenticated UI endpoint, never from model output
 */
export class ApprovalService {
  constructor(
    private db: Db,
    private clock: Clock,
    private ttlMinutes: number,
  ) {}

  create(d: ApprovalDraft): ApprovalView {
    const id = newId("apr");
    const now = this.clock.now();
    const expires = new Date(now.getTime() + this.ttlMinutes * 60_000);
    const view: ApprovalView = {
      id,
      chatId: d.chatId,
      runId: d.runId,
      incidentId: d.incidentId ?? null,
      projectName: d.projectName,
      title: d.title,
      toolLabel: d.toolLabel,
      capabilityId: d.capabilityId,
      resource: d.resource,
      risk: d.risk,
      reason: d.reason,
      evidence: d.evidence,
      currentValue: d.currentValue ?? null,
      proposedValue: d.proposedValue ?? null,
      diff: d.diff ?? null,
      effect: d.effect,
      downtime: d.downtime ?? null,
      reversible: d.reversible ?? null,
      cost: d.cost ?? null,
      scope: d.scope,
      status: "pending",
      requiresTypedConfirmation: d.typedConfirmation ? d.resource : null,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      decidedAt: null,
      resultSummary: null,
    };
    // Persist the exact request so execution uses what was approved, not what a caller re-sends.
    const storedReq = { ...d.req, file: d.req.file ? { ...d.req.file, data: Buffer.from(d.req.file.data).toString("base64") } : undefined };
    this.db.run(
      `INSERT INTO approvals(id, chat_id, run_id, incident_id, project_name, capability_id, tool, action, args_json, scope_hash, risk, view_json, status, typed_confirmation, created_at, expires_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      d.chatId,
      d.runId,
      d.incidentId ?? null,
      d.projectName,
      d.capabilityId,
      d.tool,
      d.action,
      JSON.stringify(storedReq),
      scopeHash(d.capabilityId, d.resource, d.req),
      d.risk,
      JSON.stringify(redact(view)),
      "pending",
      d.typedConfirmation ? d.resource : null,
      view.createdAt,
      view.expiresAt,
    );
    return view;
  }

  get(id: string): ApprovalView | null {
    const r = this.db.get<Record<string, unknown>>("SELECT * FROM approvals WHERE id = ?", id);
    return r ? this.toView(r) : null;
  }

  storedRequest(id: string): { capabilityId: string; resource: string; req: LiaraRequest; risk: RiskLevel } {
    const r = this.db.get<Record<string, unknown>>("SELECT * FROM approvals WHERE id = ?", id);
    if (!r) throw new AgentError("NOT_FOUND", "approval not found");
    const raw = json<LiaraRequest & { file?: { field: string; name: string; data: string; contentType: string } }>(r.args_json, {});
    const req: LiaraRequest = { ...raw, file: raw.file ? { ...raw.file, data: new Uint8Array(Buffer.from(raw.file.data, "base64")) } : undefined };
    return { capabilityId: String(r.capability_id), resource: this.toView(r).resource, req, risk: r.risk as RiskLevel };
  }

  private toView(r: Record<string, unknown>): ApprovalView {
    const v = json<ApprovalView>(r.view_json, {} as ApprovalView);
    let status = r.status as ApprovalStatus;
    if (status === "pending" && Date.parse(String(r.expires_at)) < this.clock.now().getTime()) status = "expired";
    return { ...v, status, decidedAt: (r.decided_at as string) ?? null, resultSummary: json<{ summary?: string }>(r.result_json, {}).summary ?? null };
  }

  list(filter: { status?: ApprovalStatus | "all"; chatId?: string; limit?: number } = {}): ApprovalView[] {
    this.expireStale();
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM approvals WHERE (? IS NULL OR status = ?) AND (? IS NULL OR chat_id = ?) ORDER BY created_at DESC LIMIT ?`,
      filter.status && filter.status !== "all" ? filter.status : null,
      filter.status && filter.status !== "all" ? filter.status : null,
      filter.chatId ?? null,
      filter.chatId ?? null,
      filter.limit ?? 100,
    );
    return rows.map((r) => this.toView(r));
  }

  pendingCount(): number {
    this.expireStale();
    return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")?.n ?? 0);
  }

  expireStale(): void {
    this.db.run("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", this.clock.now().toISOString());
  }

  decide(id: string, decision: "approve" | "reject", by: string, typedConfirmation?: string | null): ApprovalView {
    return this.db.tx(() => {
      const r = this.db.get<Record<string, unknown>>("SELECT * FROM approvals WHERE id = ?", id);
      if (!r) throw new AgentError("NOT_FOUND", "approval not found");
      const view = this.toView(r);
      if (view.status === "expired") {
        this.db.run("UPDATE approvals SET status = 'expired' WHERE id = ?", id);
        throw new AgentError("APPROVAL_REQUIRED", "approval expired; a new one must be requested", { details: { status: "expired" } });
      }
      if (view.status !== "pending") throw new AgentError("CONFLICT", `approval is already ${view.status}`);
      if (decision === "approve" && r.typed_confirmation && typedConfirmation !== r.typed_confirmation) {
        throw new AgentError("VALIDATION", "typed confirmation does not match the resource name");
      }
      const status = decision === "approve" ? "approved" : "rejected";
      this.db.run("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?", status, this.clock.now().toISOString(), by, id);
      return this.get(id)!;
    });
  }

  /**
   * Atomically verifies and consumes an approval immediately before execution.
   * Throws when missing, rejected, expired, already used, or the scope changed.
   */
  consume(id: string, capabilityId: string, resource: string, req: LiaraRequest): void {
    // The transaction commits state changes (expired/invalidated) before the error is raised.
    const problem = this.db.tx((): string | null => {
      const r = this.db.get<Record<string, unknown>>("SELECT * FROM approvals WHERE id = ?", id);
      if (!r) return "approval not found";
      if (r.status !== "approved") return `approval is ${String(r.status)}`;
      if (r.consumed_at) return "approval already used";
      if (Date.parse(String(r.expires_at)) < this.clock.now().getTime()) {
        this.db.run("UPDATE approvals SET status = 'expired' WHERE id = ?", id);
        return "approval expired";
      }
      if (r.capability_id !== capabilityId || r.scope_hash !== scopeHash(capabilityId, resource, req)) {
        this.db.run("UPDATE approvals SET status = 'invalidated' WHERE id = ?", id);
        return "action changed after approval; approval invalidated";
      }
      this.db.run("UPDATE approvals SET status = 'executing', consumed_at = ? WHERE id = ?", this.clock.now().toISOString(), id);
      return null;
    });
    if (problem) throw new AgentError("APPROVAL_REQUIRED", problem);
  }

  finish(id: string, ok: boolean, summary: string): ApprovalView | null {
    this.db.run("UPDATE approvals SET status = ?, result_json = ? WHERE id = ?", ok ? "executed" : "failed", JSON.stringify({ summary }), id);
    return this.get(id);
  }
}
