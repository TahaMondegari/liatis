import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { toAgentError } from "../errors.js";
import { ALLOWED_MODEL_IDS, type AllowedModelId, type ProbeResult } from "./models.js";

const PERSIAN = /[؀-ۿ]/;

/**
 * Reproducible capability evaluation for every allowed model (BRIEF §7.4).
 * Each capability is marked supported / unsupported / unknown from an actual
 * call — one successful call is not treated as proof of other features.
 */
export async function probeModels(ctx: Ctx, only?: AllowedModelId[]): Promise<Record<string, ProbeResult>> {
  await ctx.models.refreshCatalog();
  const out: Record<string, ProbeResult> = {};
  if (!ctx.llm.configured) {
    for (const id of only ?? ALLOWED_MODEL_IDS) out[id] = { at: new Date().toISOString(), ok: false, latencyMs: null, note: "AI_API_BASE_URL / AI_API_KEY not configured — not probed", supports: {} };
    return out;
  }
  for (const id of only ?? ALLOWED_MODEL_IDS) {
    const m = ctx.models.model(id);
    const supports: ProbeResult["supports"] = {};
    let ok = false;
    let latencyMs: number | null = null;
    const notes: string[] = [];
    if (m.kind === "embedding") {
      const t0 = Date.now();
      try {
        const v = await ctx.llm.embedWith(id, ["سلام دنیا"]);
        ok = Array.isArray(v[0]) && v[0].length > 0;
        latencyMs = Date.now() - t0;
        notes.push(`dimensions=${v[0]?.length ?? 0}`);
        supports.embeddings = ok ? "supported" : "unsupported";
      } catch (e) {
        notes.push(toAgentError(e).message.slice(0, 160));
      }
    } else {
      try {
        const r = await ctx.llm.direct(id, { role: "normal_reasoning", maxTokens: 300, messages: [{ role: "user", content: "در یک جمله‌ی کوتاه فارسی بگو دپلوی یعنی چه." }] });
        ok = true;
        latencyMs = r.latencyMs;
        supports.persian_output = PERSIAN.test(r.content) ? "supported" : "unsupported";
        notes.push(`tokens=${r.usage.promptTokens ?? "?"}/${r.usage.completionTokens ?? "?"} cost_toman=${r.usage.costToman ?? "?"}`);
      } catch (e) {
        notes.push(`basic: ${toAgentError(e).message.slice(0, 160)}`);
      }
      if (ok) {
        try {
          const r = await ctx.llm.direct(id, { role: "normal_reasoning", maxTokens: 300, schema: z.object({ status: z.enum(["ok"]), count: z.number() }), schemaName: "probe", messages: [{ role: "user", content: 'Return {"status":"ok","count":3}.' }] });
          supports.structured_output = r.parsed ? "supported" : "unsupported";
        } catch {
          supports.structured_output = "unsupported";
        }
        try {
          const r = await ctx.llm.direct(id, {
            role: "normal_reasoning",
            maxTokens: 300,
            toolChoice: "required",
            tools: [{ type: "function", function: { name: "get_status", description: "Get app status", parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } } }],
            messages: [{ role: "user", content: "Check the status of app shop-front." }],
          });
          supports.tool_calling = r.toolCalls.some((c) => c.function.name === "get_status") ? "supported" : "unsupported";
        } catch {
          supports.tool_calling = "unsupported";
        }
        try {
          let deltas = 0;
          await ctx.llm.direct(id, { role: "normal_reasoning", maxTokens: 120, onDelta: () => deltas++, messages: [{ role: "user", content: "Count from 1 to 5." }] });
          supports.streaming = deltas > 1 ? "supported" : "unsupported";
        } catch {
          supports.streaming = "unsupported";
        }
      }
    }
    const res: ProbeResult = { at: new Date().toISOString(), ok, latencyMs, note: notes.join("; ") || null, supports };
    ctx.models.saveProbe(id, res);
    out[id] = res;
  }
  const report = { generatedAt: new Date().toISOString(), provider: ctx.models.config.provider, baseUrlConfigured: Boolean(ctx.cfg.ai.baseUrl), catalogFetchedAt: ctx.models.catalogFetchedAt, models: ctx.models.views() };
  try {
    writeFileSync(join(process.cwd(), "llm_capabilities.json"), JSON.stringify(report, null, 2));
  } catch {
    /* best effort */
  }
  return out;
}

// CLI: npm run probe:models
if (process.argv[1] && /probe\.(ts|js)$/.test(process.argv[1])) {
  const { loadConfig } = await import("../config.js");
  const { createContext } = await import("../context.js");
  const ctx = createContext(loadConfig());
  const r = await probeModels(ctx);
  for (const [id, p] of Object.entries(r)) console.log(`${p.ok ? "✓" : "✗"} ${id.padEnd(24)} ${String(p.latencyMs ?? "-").padStart(6)}ms  ${JSON.stringify(p.supports)}  ${p.note ?? ""}`);
}
