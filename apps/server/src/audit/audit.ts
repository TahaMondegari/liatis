import type { AppMode, AuditEntry, RiskLevel } from "@liara-agent/shared";
import type { Db } from "../db/db.js";
import { json } from "../db/db.js";
import { redact } from "../security/redact.js";
import { iso, newId } from "../util.js";

export interface AuditInput {
  actor: string;
  kind: string;
  capabilityId?: string | null;
  resource?: string | null;
  risk?: RiskLevel | null;
  approvalId?: string | null;
  status: string;
  errorCode?: string | null;
  durationMs?: number | null;
  args?: unknown;
  chatId?: string | null;
  runId?: string | null;
  toolExecutionId?: string | null;
  evidence?: string | null;
}

/** Append-only audit log (DB triggers reject UPDATE/DELETE). Secret values are redacted. */
export class AuditLog {
  constructor(
    private db: Db,
    private mode: AppMode,
  ) {}

  record(e: AuditInput): string {
    const id = newId("aud");
    this.db.run(
      `INSERT INTO audit(id, at, actor, kind, capability_id, resource, risk, approval_id, status, error_code, duration_ms, args_json, chat_id, run_id, tool_execution_id, mode, evidence)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      iso(),
      e.actor,
      e.kind,
      e.capabilityId ?? null,
      e.resource ?? null,
      e.risk ?? null,
      e.approvalId ?? null,
      e.status,
      e.errorCode ?? null,
      e.durationMs ?? null,
      e.args === undefined ? null : JSON.stringify(redact(e.args)),
      e.chatId ?? null,
      e.runId ?? null,
      e.toolExecutionId ?? null,
      this.mode,
      e.evidence ?? null,
    );
    return id;
  }

  list(opts: { limit?: number; before?: string; kind?: string } = {}): AuditEntry[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM audit WHERE (? IS NULL OR at < ?) AND (? IS NULL OR kind = ?) ORDER BY at DESC LIMIT ?`,
      opts.before ?? null,
      opts.before ?? null,
      opts.kind ?? null,
      opts.kind ?? null,
      Math.min(opts.limit ?? 100, 500),
    );
    return rows.map((r) => ({
      id: String(r.id),
      at: String(r.at),
      actor: String(r.actor),
      kind: String(r.kind),
      capabilityId: (r.capability_id as string) ?? null,
      resource: (r.resource as string) ?? null,
      risk: (r.risk as RiskLevel) ?? null,
      approvalId: (r.approval_id as string) ?? null,
      status: String(r.status),
      errorCode: (r.error_code as string) ?? null,
      durationMs: (r.duration_ms as number) ?? null,
      args: json(r.args_json, null),
      chatId: (r.chat_id as string) ?? null,
      runId: (r.run_id as string) ?? null,
      mode: r.mode as AppMode,
    }));
  }
}
