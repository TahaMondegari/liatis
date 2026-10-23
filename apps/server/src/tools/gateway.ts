import type { ApprovalView, Money, RiskLevel } from "@liara-agent/shared";
import type { AuditLog } from "../audit/audit.js";
import { AgentError, toAgentError } from "../errors.js";
import type { LiaraClient } from "../liara/client.js";
import type { LiaraRequest } from "../liara/transport.js";
import type { ApprovalService } from "../policy/approvals.js";
import type { Actor, PolicyEngine } from "../policy/policy.js";
import { redact } from "../security/redact.js";
import { newId } from "../util.js";

export interface ToolContext {
  actor: Actor;
  chatId: string | null;
  runId: string | null;
  incidentId?: string | null;
  projectName?: string | null;
}

export interface ActionSpec {
  capabilityId: string;
  req: LiaraRequest;
  /** human-readable target (app name, db id, domain…) — also the L4 typed confirmation */
  resource: string;
  title: string;
  reason: string;
  evidence?: string[];
  effect: string;
  currentValue?: string | null;
  proposedValue?: string | null;
  diff?: string | null;
  downtime?: string | null;
  reversible?: string | null;
  cost?: Money | null;
}

export type GatewayOutcome<T = unknown> =
  | { status: "executed"; data: T; risk: RiskLevel; auditId: string; approvalId: string | null }
  | { status: "approval_required"; approval: ApprovalView }
  | { status: "denied"; code: string; reason: string; risk: RiskLevel };

/**
 * The single controlled execution boundary for Liara operations.
 * capability check → policy → approval (create or consume) → typed client → audit.
 * The model never reaches the client directly.
 */
export class ToolGateway {
  constructor(
    private client: LiaraClient,
    private policy: PolicyEngine,
    private approvals: ApprovalService,
    private audit: AuditLog,
    private onApprovalCreated: (a: ApprovalView) => void = () => {},
  ) {}

  /** Execute if policy allows; otherwise create a pending approval for exactly this action. */
  async run<T = unknown>(spec: ActionSpec, ctx: ToolContext, signal?: AbortSignal): Promise<GatewayOutcome<T>> {
    const decision = this.policy.evaluate({ capabilityId: spec.capabilityId, req: spec.req, actor: ctx.actor, resource: spec.resource });
    const cap = this.client.registry.get(spec.capabilityId);
    if (decision.kind === "deny") {
      this.audit.record({ actor: ctx.actor, kind: "policy.deny", capabilityId: spec.capabilityId, resource: spec.resource, risk: decision.risk, status: "denied", errorCode: decision.code, args: spec.req, chatId: ctx.chatId, runId: ctx.runId, evidence: decision.reason });
      return { status: "denied", code: decision.code, reason: decision.reason, risk: decision.risk };
    }
    if (decision.kind === "require_approval") {
      const approval = this.approvals.create({
        chatId: ctx.chatId,
        runId: ctx.runId,
        incidentId: ctx.incidentId ?? null,
        projectName: ctx.projectName ?? null,
        capabilityId: spec.capabilityId,
        tool: spec.capabilityId.split(".")[0] ?? "liara",
        action: spec.capabilityId,
        req: spec.req,
        resource: spec.resource,
        risk: decision.risk,
        typedConfirmation: decision.typedConfirmation,
        title: spec.title,
        toolLabel: cap?.labelFa ?? spec.capabilityId,
        reason: spec.reason,
        evidence: spec.evidence ?? [],
        currentValue: spec.currentValue ?? null,
        proposedValue: spec.proposedValue ?? null,
        diff: spec.diff ?? null,
        effect: spec.effect,
        downtime: spec.downtime ?? null,
        reversible: spec.reversible ?? null,
        cost: spec.cost ?? null,
        scope: `${cap?.labelFa ?? spec.capabilityId} · ${spec.resource}`,
      });
      this.audit.record({ actor: ctx.actor, kind: "approval.requested", capabilityId: spec.capabilityId, resource: spec.resource, risk: decision.risk, approvalId: approval.id, status: "pending", args: spec.req, chatId: ctx.chatId, runId: ctx.runId, evidence: decision.reason });
      this.onApprovalCreated(approval);
      return { status: "approval_required", approval };
    }
    const data = await this.exec<T>(spec.capabilityId, spec.resource, spec.req, decision.risk, null, ctx, signal);
    return { status: "executed", data: data.data, risk: decision.risk, auditId: data.auditId, approvalId: null };
  }

  /**
   * Execute a previously approved action. Uses the request stored with the approval.
   * `resolve` may substitute placeholders bound into the approved scope
   * (`{{secret:KEY}}`, `{{source:<sha256>}}`) right before sending; the audit
   * keeps the placeholder form.
   */
  async executeApproved<T = unknown>(approvalId: string, ctx: ToolContext, opts: { signal?: AbortSignal; resolve?: (req: LiaraRequest) => Promise<LiaraRequest> } = {}): Promise<{ data: T; auditId: string; risk: RiskLevel }> {
    const stored = this.approvals.storedRequest(approvalId);
    // Re-evaluate policy at execution time (capability may have changed status).
    const decision = this.policy.evaluate({ capabilityId: stored.capabilityId, req: stored.req, actor: "user", resource: stored.resource });
    if (decision.kind === "deny") throw new AgentError(decision.code, decision.reason);
    this.approvals.consume(approvalId, stored.capabilityId, stored.resource, stored.req);
    try {
      const sendReq = opts.resolve ? await opts.resolve(stored.req) : stored.req;
      const r = await this.exec<T>(stored.capabilityId, stored.resource, stored.req, stored.risk, approvalId, ctx, opts.signal, sendReq);
      this.approvals.finish(approvalId, true, "ok");
      return { ...r, risk: stored.risk };
    } catch (e) {
      this.approvals.finish(approvalId, false, toAgentError(e).code);
      throw e;
    }
  }

  private async exec<T>(capId: string, resource: string, req: LiaraRequest, risk: RiskLevel, approvalId: string | null, ctx: ToolContext, signal?: AbortSignal, sendReq: LiaraRequest = req): Promise<{ data: T; auditId: string }> {
    const toolExecutionId = newId("tx");
    const started = Date.now();
    try {
      const res = await this.client.executeUnchecked<T>(capId, sendReq, signal);
      const auditId = this.audit.record({ actor: ctx.actor, kind: risk === "L0" ? "tool.read" : "tool.mutation", capabilityId: capId, resource, risk, approvalId, status: "ok", durationMs: Date.now() - started, args: req, chatId: ctx.chatId, runId: ctx.runId, toolExecutionId });
      return { data: redact(res.data), auditId };
    } catch (e) {
      const err = toAgentError(e);
      this.audit.record({ actor: ctx.actor, kind: risk === "L0" ? "tool.read" : "tool.mutation", capabilityId: capId, resource, risk, approvalId, status: "error", errorCode: err.code, durationMs: Date.now() - started, args: req, chatId: ctx.chatId, runId: ctx.runId, toolExecutionId, evidence: err.message });
      throw err;
    }
  }
}
