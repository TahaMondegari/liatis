import { maxRisk, type AppMode, type RiskLevel } from "@liara-agent/shared";
import type { Capability, CapabilityRegistry } from "../liara/capabilities.js";
import type { LiaraRequest } from "../liara/transport.js";

export type Actor = "user" | "agent" | "patrol" | "system";

export type PolicyDecision =
  | { kind: "allow"; risk: RiskLevel; reason: string }
  | { kind: "require_approval"; risk: RiskLevel; typedConfirmation: boolean; reason: string }
  | { kind: "deny"; risk: RiskLevel; code: "UNSUPPORTED_OPERATION" | "UNSAFE_OPERATION" | "BUDGET_EXCEEDED"; reason: string };

export interface StandingAuthorization {
  /** e.g. patrol auto-restart on crash loop: capability + project, max N per window */
  capabilityId: string;
  resource: string;
  maxPerWindow: number;
  windowMs: number;
}

/**
 * Policy Engine (BRIEF §14). Pure decision logic; no I/O except the
 * injected usage counter for standing authorizations.
 */
export class PolicyEngine {
  constructor(
    private registry: CapabilityRegistry,
    private mode: AppMode,
    private transportKind: () => "http" | "mock",
    private standing: () => StandingAuthorization[] = () => [],
    private recentExecutions: (capId: string, resource: string, sinceMs: number) => number = () => 0,
  ) {}

  /** Some actions are riskier depending on their arguments. Never lowers the base risk. */
  effectiveRisk(cap: Capability, req: LiaraRequest): RiskLevel {
    let r = cap.risk;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if ((cap.id === "paas.turnApp" || cap.id === "dbaas.TurnDatabase") && Number(b.scale) === 0) r = maxRisk(r, "L2");
    if (cap.id === "dbaas.createDatabase" && b.publicNetwork === true) r = maxRisk(r, "L3");
    if (cap.id === "storage.changeBucketAccess" && String(req.pathParams?.permission ?? "").includes("public")) r = maxRisk(r, "L3");
    if (cap.id === "paas.createApp" && b.readOnlyRootFilesystem === false) r = maxRisk(r, "L3");
    return r;
  }

  evaluate(input: { capabilityId: string; req: LiaraRequest; actor: Actor; resource: string }): PolicyDecision {
    const cap = this.registry.get(input.capabilityId);
    if (!cap) return { kind: "deny", risk: "L4", code: "UNSUPPORTED_OPERATION", reason: "capability not in registry" };
    // Demo/Real separation is enforced here independently of configuration elsewhere.
    if (this.mode === "demo" && this.transportKind() !== "mock") return { kind: "deny", risk: cap.risk, code: "UNSAFE_OPERATION", reason: "demo mode must use the mock transport" };
    if (!this.registry.isExecutable(cap.id)) return { kind: "deny", risk: cap.risk, code: "UNSUPPORTED_OPERATION", reason: `${cap.status}: ${cap.notes ?? "no verified API operation"}` };
    if (input.actor === "agent" && !cap.exposedToAgent) return { kind: "deny", risk: cap.risk, code: "UNSAFE_OPERATION", reason: "capability is not exposed to the model" };

    const risk = this.effectiveRisk(cap, input.req);
    if (risk === "L0") return { kind: "allow", risk, reason: "read-only" };
    if (risk === "L1") {
      if (input.actor === "patrol" && !this.withinStanding(cap.id, input.resource)) {
        return { kind: "require_approval", risk, typedConfirmation: false, reason: "patrol may run L1 only within configured caps" };
      }
      return { kind: "allow", risk, reason: "low-risk reversible write (audited)" };
    }
    if (risk === "L4") return { kind: "require_approval", risk, typedConfirmation: true, reason: "destructive operation requires typed confirmation" };
    // L2 / L3: explicit approval unless a narrowly scoped standing authorization exists (never for L3).
    if (risk === "L2" && this.withinStanding(cap.id, input.resource)) return { kind: "allow", risk, reason: "within standing authorization" };
    return { kind: "require_approval", risk, typedConfirmation: false, reason: risk === "L3" ? "cost/exposure change requires approval" : "service-affecting change requires approval" };
  }

  private withinStanding(capId: string, resource: string): boolean {
    const s = this.standing().find((x) => x.capabilityId === capId && x.resource === resource);
    if (!s) return false;
    return this.recentExecutions(capId, resource, s.windowMs) < s.maxPerWindow;
  }
}
