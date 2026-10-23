import { z } from "zod";
import type { Db } from "../db/db.js";
import { AgentError, toAgentError } from "../errors.js";
import { redact, redactString } from "../security/redact.js";
import { newId, sleep, type Clock } from "../util.js";
import type { AllowedModelId, ModelRegistry, Role } from "./models.js";

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean };
}

export interface ChatRequest<S extends z.ZodTypeAny | undefined = undefined> {
  role: Role;
  messages: LlmMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none" | "required";
  schema?: S;
  schemaName?: string;
  maxTokens?: number;
  onDelta?: (text: string) => void;
  runId?: string | null;
  chatId?: string | null;
  /** force escalation to the next tier (e.g. after two failed repair attempts) */
  escalate?: boolean;
  signal?: AbortSignal;
}

export interface ChatResult<T = unknown> {
  content: string;
  parsed: T;
  toolCalls: ToolCall[];
  model: AllowedModelId;
  usage: { promptTokens: number | null; completionTokens: number | null; costToman: number | null; costUsd: number | null };
  fallbackReason: string | null;
  latencyMs: number;
}

export interface GatewayOptions {
  baseUrl: string | null;
  apiKey: string | null;
  dailyBudgetToman: number;
  /** BoxAPI reports cost in USD (`usage.cost`) instead of Toman. 0 = no cap. */
  dailyBudgetUsd?: number;
  runBudgetToman: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Central LLM Gateway (BRIEF §7.1). The only place models are called.
 * Owns: allow-listed model resolution, role routing + fallback, per-model
 * parameter filtering (from catalog supported_parameters), retries/backoff,
 * structured output validation, tool calling, streaming, usage/cost ledger,
 * spend caps, prompt redaction.
 */
export class LlmGateway {
  private fetchImpl: typeof fetch;
  constructor(
    private registry: ModelRegistry,
    private db: Db,
    private clock: Clock,
    private opts: GatewayOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.opts.baseUrl && this.opts.apiKey);
  }

  /** Ordered model chain for a role, filtered to usable models of the right kind. */
  chain(role: Role, escalate = false): AllowedModelId[] {
    const r = this.registry.config.roles[role];
    if (!r) throw new AgentError("MODEL_UNAVAILABLE", `no role config for ${role}`);
    let ids = [r.primary, ...r.fallback].filter((id, i, a) => a.indexOf(id) === i);
    if (escalate) {
      const esc = this.registry.config.roles.escalation;
      if (esc) ids = [esc.primary, ...esc.fallback, ...ids].filter((id, i, a) => a.indexOf(id) === i);
    }
    const kind = role === "embeddings" ? "embedding" : "chat";
    return ids.filter((id) => this.registry.model(id).kind === kind && this.registry.usable(id));
  }

  spentTodayToman(): number {
    const day = this.clock.now().toISOString().slice(0, 10);
    return Number(this.db.get<{ s: number | null }>("SELECT SUM(cost_toman) AS s FROM model_calls WHERE substr(at,1,10) = ?", day)?.s ?? 0);
  }

  spentTodayUsd(): number {
    const day = this.clock.now().toISOString().slice(0, 10);
    return Number(this.db.get<{ s: number | null }>("SELECT SUM(cost_usd) AS s FROM model_calls WHERE substr(at,1,10) = ?", day)?.s ?? 0);
  }

  spentRunToman(runId: string): number {
    return Number(this.db.get<{ s: number | null }>("SELECT SUM(cost_toman) AS s FROM model_calls WHERE run_id = ?", runId)?.s ?? 0);
  }

  callsForRun(runId: string): number {
    return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM model_calls WHERE run_id = ?", runId)?.n ?? 0);
  }

  private checkBudget(runId?: string | null): void {
    if (this.opts.dailyBudgetToman > 0 && this.spentTodayToman() >= this.opts.dailyBudgetToman) throw new AgentError("BUDGET_EXCEEDED", "daily AI budget reached");
    if ((this.opts.dailyBudgetUsd ?? 0) > 0 && this.spentTodayUsd() >= this.opts.dailyBudgetUsd!) throw new AgentError("BUDGET_EXCEEDED", "daily AI budget (USD) reached");
    if (runId && this.opts.runBudgetToman > 0 && this.spentRunToman(runId) >= this.opts.runBudgetToman) throw new AgentError("BUDGET_EXCEEDED", "per-run AI budget reached");
  }

  async chat<S extends z.ZodTypeAny | undefined = undefined>(req: ChatRequest<S>): Promise<ChatResult<S extends z.ZodTypeAny ? z.infer<S> : null>> {
    if (!this.configured) throw new AgentError("MODEL_UNAVAILABLE", "AI_API_BASE_URL / AI_API_KEY are not configured");
    this.checkBudget(req.runId);
    const chain = this.chain(req.role, req.escalate);
    if (chain.length === 0) throw new AgentError("MODEL_UNAVAILABLE", `no usable model for role ${req.role}`);
    const messages = req.messages.map((m) => ({ ...m, content: m.content === null ? null : redactString(m.content) }));
    let fallbackReason: string | null = null;
    let lastErr: AgentError | null = null;

    for (const model of chain) {
      // Capability gate: skip models that the catalog says cannot do what's needed.
      if (req.tools?.length && this.registry.supportsParam(model, "tools") === "unsupported") {
        fallbackReason = `${model}: tools unsupported`;
        continue;
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await this.callOnce(model, req, messages);
          return { ...r, fallbackReason } as ChatResult<S extends z.ZodTypeAny ? z.infer<S> : null>;
        } catch (e) {
          const err = toAgentError(e);
          lastErr = err;
          this.record(model, req, false, null, null, err.code, fallbackReason, Boolean(req.onDelta));
          const transient = err.retryable && attempt < 3;
          if (!transient) break;
          await sleep(500 * 2 ** (attempt - 1) + Math.random() * 300, req.signal);
        }
      }
      fallbackReason = `${model}: ${lastErr?.code ?? "error"}`;
      if (lastErr?.code === "BUDGET_EXCEEDED" || req.signal?.aborted) break;
    }
    throw lastErr ?? new AgentError("MODEL_UNAVAILABLE", "all models failed");
  }

  private body(model: AllowedModelId, req: ChatRequest<z.ZodTypeAny | undefined>, messages: LlmMessage[]): Record<string, unknown> {
    const reg = this.registry;
    const roleCfg = reg.config.roles[req.role];
    const b: Record<string, unknown> = { model: reg.model(model).provider_id, messages };
    const sup = (p: string) => reg.supportsParam(model, p) !== "unsupported";
    if (req.maxTokens) b[sup("max_completion_tokens") ? "max_completion_tokens" : "max_tokens"] = req.maxTokens;
    if (roleCfg?.reasoning_effort && reg.supportsParam(model, "reasoning_effort") === "supported") b.reasoning_effort = roleCfg.reasoning_effort;
    if (req.tools?.length) {
      b.tools = req.tools;
      b.tool_choice = req.toolChoice ?? "auto";
      if (sup("parallel_tool_calls")) b.parallel_tool_calls = false;
    }
    if (req.schema) {
      const schema = z.toJSONSchema(req.schema, { target: "draft-7" }) as Record<string, unknown>;
      delete schema.$schema;
      if (sup("structured_outputs") && sup("response_format")) {
        b.response_format = { type: "json_schema", json_schema: { name: req.schemaName ?? "result", strict: false, schema } };
      } else if (sup("response_format")) {
        b.response_format = { type: "json_object" };
      }
    }
    if (req.onDelta) {
      b.stream = true;
      b.stream_options = { include_usage: true };
    }
    return b;
  }

  private async callOnce(model: AllowedModelId, req: ChatRequest<z.ZodTypeAny | undefined>, messages: LlmMessage[]) {
    const started = Date.now();
    const url = `${this.opts.baseUrl!.replace(/\/$/, "")}/chat/completions`;
    let msgs = messages;
    if (req.schema && !msgs.some((m) => m.role === "system" && m.content?.includes("JSON"))) {
      msgs = [{ role: "system", content: "Respond ONLY with a JSON object that matches the requested schema." }, ...msgs];
    }
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
    const body = this.body(model, req, msgs);
    const send = (b: Record<string, unknown>) =>
      this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify(b),
        signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
      });
    let res = await send(body);
    if (res.status === 400 && body.reasoning_effort !== undefined) {
      // Effort levels differ per model family (e.g. gpt-6 rejects "minimal"); retry once with the provider default.
      const text = await res.clone().text().catch(() => "");
      if (/reasoning_effort/.test(text)) {
        delete body.reasoning_effort;
        res = await send(body);
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const code = res.status === 401 ? "AUTHENTICATION" : res.status === 403 ? "AUTHORIZATION" : res.status === 429 ? "RATE_LIMIT" : res.status === 400 ? "VALIDATION" : "MODEL_UNAVAILABLE";
      throw new AgentError(code, `model ${model} HTTP ${res.status}: ${redactString(text).slice(0, 300)}`, { status: res.status, retryable: TRANSIENT.has(res.status) });
    }
    let content = "";
    let toolCalls: ToolCall[] = [];
    let usage: Record<string, number> = {};
    if (req.onDelta) {
      ({ content, toolCalls, usage } = await this.readStream(res, req.onDelta));
    } else {
      const data = (await res.json()) as { choices?: { message?: { content?: unknown; tool_calls?: ToolCall[] } }[]; usage?: Record<string, number> };
      const msg = data.choices?.[0]?.message;
      content = typeof msg?.content === "string" ? msg.content : Array.isArray(msg?.content) ? (msg.content as { text?: string }[]).map((c) => c.text ?? "").join("") : "";
      toolCalls = msg?.tool_calls ?? [];
      usage = data.usage ?? {};
    }
    let parsed: unknown = null;
    if (req.schema) {
      const raw = extractJson(content);
      const r = req.schema.safeParse(raw);
      if (!r.success) throw new AgentError("VALIDATION", `model ${model} returned output that does not match schema: ${r.error.message.slice(0, 200)}`, { retryable: true });
      parsed = r.data;
    }
    const latencyMs = Date.now() - started;
    const u = {
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      costToman: usage.total_cost_toman ?? null,
      costUsd: usage.total_cost ?? usage.cost ?? null,
    };
    this.record(model, req, true, latencyMs, u, null, null, Boolean(req.onDelta));
    return { content, parsed, toolCalls, model, usage: u, latencyMs };
  }

  private async readStream(res: Response, onDelta: (t: string) => void) {
    let content = "";
    const tools = new Map<number, ToolCall>();
    let usage: Record<string, number> = {};
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]; usage?: Record<string, number> };
          const d = chunk.choices?.[0]?.delta;
          if (d?.content) {
            content += d.content;
            onDelta(d.content);
          }
          for (const tc of d?.tool_calls ?? []) {
            const cur = tools.get(tc.index) ?? { id: tc.id ?? newId("call"), type: "function" as const, function: { name: "", arguments: "" } };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
            tools.set(tc.index, cur);
          }
          if (chunk.usage) usage = chunk.usage;
        } catch {
          /* ignore keep-alive / partial lines */
        }
      }
    }
    return { content, toolCalls: [...tools.values()], usage };
  }

  /** Single-model call without fallback — used only by the probe/evaluation harness. */
  async direct<S extends z.ZodTypeAny | undefined = undefined>(model: AllowedModelId, req: ChatRequest<S>) {
    if (!this.configured) throw new AgentError("MODEL_UNAVAILABLE", "AI is not configured");
    const messages = req.messages.map((m) => ({ ...m, content: m.content === null ? null : redactString(m.content) }));
    return this.callOnce(model, req as ChatRequest<z.ZodTypeAny | undefined>, messages);
  }

  async embedWith(model: AllowedModelId, texts: string[]): Promise<number[][]> {
    const res = await this.fetchImpl(`${this.opts.baseUrl!.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({ model: this.registry.model(model).provider_id, input: texts }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new AgentError("MODEL_UNAVAILABLE", `embedding HTTP ${res.status}`, { status: res.status });
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  }

  async embed(texts: string[], opts: { runId?: string | null } = {}): Promise<{ vectors: number[][]; model: AllowedModelId }> {
    if (!this.configured) throw new AgentError("MODEL_UNAVAILABLE", "AI is not configured");
    this.checkBudget(opts.runId);
    let lastErr: AgentError | null = null;
    for (const model of this.chain("embeddings")) {
      const started = Date.now();
      try {
        const res = await this.fetchImpl(`${this.opts.baseUrl!.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify({ model: this.registry.model(model).provider_id, input: texts.map(redactString) }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new AgentError("MODEL_UNAVAILABLE", `embedding HTTP ${res.status}`, { retryable: TRANSIENT.has(res.status), status: res.status });
        const data = (await res.json()) as { data: { embedding: number[]; index: number }[]; usage?: Record<string, number> };
        const u = { promptTokens: data.usage?.prompt_tokens ?? null, completionTokens: 0, costToman: data.usage?.total_cost_toman ?? null, costUsd: data.usage?.total_cost ?? data.usage?.cost ?? null };
        this.record(model, { role: "embeddings", runId: opts.runId }, true, Date.now() - started, u, null, null, false);
        return { vectors: data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding), model };
      } catch (e) {
        lastErr = toAgentError(e);
        this.record(model, { role: "embeddings", runId: opts.runId }, false, Date.now() - started, null, lastErr.code, null, false);
      }
    }
    throw lastErr ?? new AgentError("MODEL_UNAVAILABLE", "no embedding model");
  }

  private record(
    model: AllowedModelId,
    req: Pick<ChatRequest<z.ZodTypeAny | undefined>, "role" | "runId" | "chatId">,
    ok: boolean,
    latencyMs: number | null,
    usage: ChatResult["usage"] | null,
    errorCode: string | null,
    fallbackReason: string | null,
    stream: boolean,
  ): void {
    this.db.run(
      `INSERT INTO model_calls(id, at, role, model, provider_id, ok, latency_ms, prompt_tokens, completion_tokens, cost_toman, cost_usd, fallback_reason, error_code, run_id, chat_id, stream)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId("mc"),
      this.clock.now().toISOString(),
      req.role,
      model,
      this.registry.model(model).provider_id,
      ok ? 1 : 0,
      latencyMs,
      usage?.promptTokens ?? null,
      usage?.completionTokens ?? null,
      usage?.costToman ?? null,
      usage?.costUsd ?? null,
      fallbackReason,
      errorCode,
      req.runId ?? null,
      req.chatId ?? null,
      stream ? 1 : 0,
    );
  }

  usageSummary(days = 7): { byModel: { model: string; calls: number; failures: number; promptTokens: number; completionTokens: number; costToman: number | null; avgLatencyMs: number | null }[]; byDay: { day: string; costToman: number | null; calls: number }[]; todayToman: number } {
    const since = new Date(this.clock.now().getTime() - days * 86400_000).toISOString();
    const byModel = this.db
      .all<{ model: string; calls: number; failures: number; pt: number | null; ct: number | null; cost: number | null; lat: number | null }>(
        `SELECT model, COUNT(*) calls, SUM(1-ok) failures, SUM(prompt_tokens) pt, SUM(completion_tokens) ct, SUM(cost_toman) cost, AVG(latency_ms) lat FROM model_calls WHERE at >= ? GROUP BY model ORDER BY calls DESC`,
        since,
      )
      .map((r) => ({ model: r.model, calls: r.calls, failures: r.failures, promptTokens: r.pt ?? 0, completionTokens: r.ct ?? 0, costToman: r.cost, avgLatencyMs: r.lat === null ? null : Math.round(r.lat) }));
    const byDay = this.db
      .all<{ day: string; cost: number | null; calls: number }>(`SELECT substr(at,1,10) day, SUM(cost_toman) cost, COUNT(*) calls FROM model_calls WHERE at >= ? GROUP BY day ORDER BY day`, since)
      .map((r) => ({ day: r.day, costToman: r.cost, calls: r.calls }));
    return { byModel, byDay, todayToman: this.spentTodayToman() };
  }

  /** Sanitizes arbitrary objects before they are put into a prompt. */
  static promptSafe(v: unknown, max = 6000): string {
    const s = typeof v === "string" ? v : JSON.stringify(redact(v), null, 1);
    return redactString(s).slice(0, max);
  }
}

/** Accepts raw JSON or JSON wrapped in ```json fences / prose. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1]);
      } catch {
        /* fallthrough */
      }
    }
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
