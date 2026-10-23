import { AgentError } from "../errors.js";
import { redact } from "../security/redact.js";
import type { Capability, CapabilityRegistry } from "./capabilities.js";
import type { LiaraRequest, LiaraResponse, LiaraTransport } from "./transport.js";

/**
 * Liara client facade. Resolves a capability id to its verified OpenAPI
 * operation and sends it through the configured transport (HTTP or Mock).
 *
 * - `read()` is restricted to L0 capabilities and may be used by deterministic code.
 * - `executeUnchecked()` is ONLY called by the Tool Gateway after policy and approval checks.
 */
export class LiaraClient {
  constructor(
    readonly registry: CapabilityRegistry,
    private transport: LiaraTransport,
  ) {}

  get transportKind(): "http" | "mock" {
    return this.transport.kind;
  }

  private resolve(capId: string): Capability & { op: NonNullable<Capability["op"]> } {
    const cap = this.registry.get(capId);
    if (!cap) throw new AgentError("UNSUPPORTED_OPERATION", `capability ${capId} is not in the registry`);
    if (!cap.op || !this.registry.isExecutable(capId)) {
      throw new AgentError("UNSUPPORTED_OPERATION", `capability ${capId} is ${cap.status}: ${cap.notes ?? "not available through the official API"}`, { details: { capabilityId: capId } });
    }
    return cap as Capability & { op: NonNullable<Capability["op"]> };
  }

  async read<T = unknown>(capId: string, req: LiaraRequest = {}, signal?: AbortSignal): Promise<T> {
    const cap = this.resolve(capId);
    if (cap.risk !== "L0") throw new AgentError("UNSAFE_OPERATION", `${capId} is ${cap.risk}; use the Tool Gateway`);
    const res = await this.transport.send<T>(cap.op, req, signal);
    return res.data;
  }

  /** Like read(), but secret-bearing fields are redacted (for anything that may reach a model/UI). */
  async readSafe<T = unknown>(capId: string, req: LiaraRequest = {}, signal?: AbortSignal): Promise<T> {
    return redact(await this.read<T>(capId, req, signal));
  }

  async executeUnchecked<T = unknown>(capId: string, req: LiaraRequest, signal?: AbortSignal): Promise<LiaraResponse<T>> {
    const cap = this.resolve(capId);
    return this.transport.send<T>(cap.op, req, signal);
  }
}
