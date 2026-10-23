import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { z } from "zod";
import type { ModelView } from "@liara-agent/shared";
import type { Db } from "../db/db.js";
import { json } from "../db/db.js";

/** Exactly the permitted model IDs (BRIEF §7.2). Config is validated against this set. */
export const ALLOWED_MODEL_IDS = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-5-mini",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "text-embedding-3-small",
  "text-embedding-3-large",
] as const;
export type AllowedModelId = (typeof ALLOWED_MODEL_IDS)[number];

export const ROLES = [
  "simple_classification",
  "router_complex",
  "project_analysis",
  "infrastructure_planning",
  "normal_reasoning",
  "operations_chat",
  "root_cause_analysis",
  "incident_diagnosis",
  "coding",
  "escalation",
  "daily_digest",
  "embeddings",
] as const;
export type Role = (typeof ROLES)[number];

const ModelsFile = z.object({
  provider: z.object({ name: z.string(), default_base_url: z.string(), catalog_url: z.string().url() }),
  models: z.array(z.object({ id: z.enum(ALLOWED_MODEL_IDS), provider_id: z.string(), kind: z.enum(["chat", "embedding"]), tier: z.number() })),
  roles: z.record(
    z.enum(ROLES),
    z.object({ primary: z.enum(ALLOWED_MODEL_IDS), fallback: z.array(z.enum(ALLOWED_MODEL_IDS)), reasoning_effort: z.enum(["minimal", "low", "medium", "high"]).optional() }),
  ),
});
export type ModelsConfig = z.infer<typeof ModelsFile>;

export function loadModelsConfig(path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "models.yaml")): ModelsConfig {
  const cfg = ModelsFile.parse(yaml.load(readFileSync(path, "utf8")));
  // Guard rails from the brief.
  if (cfg.roles.simple_classification && [cfg.roles.simple_classification.primary, ...cfg.roles.simple_classification.fallback].includes("gpt-6-astra")) {
    throw new Error("gpt-6-astra must never be used for simple classification");
  }
  for (const id of ALLOWED_MODEL_IDS) if (!cfg.models.some((m) => m.id === id)) throw new Error(`models.yaml is missing allowed model ${id}`);
  return cfg;
}

/** Entry from the Liara AI public catalog (GET https://ai.liara.ir/v1/models). */
export interface CatalogEntry {
  id: string;
  context_length?: number | null;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string; cost?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  top_provider?: { max_completion_tokens?: number | null };
}

export interface ProbeResult {
  at: string;
  ok: boolean;
  latencyMs: number | null;
  note: string | null;
  supports: Record<string, "supported" | "unsupported" | "unknown">;
}

export class ModelRegistry {
  private catalog = new Map<string, CatalogEntry>();
  catalogFetchedAt: string | null = null;
  catalogError: string | null = null;

  constructor(
    readonly config: ModelsConfig,
    private db: Db,
  ) {
    const cached = db.kvGet<{ at: string; entries: CatalogEntry[] }>("ai.catalog");
    if (cached) {
      for (const e of cached.entries) this.catalog.set(e.id, e);
      this.catalogFetchedAt = cached.at;
    }
  }

  /** Refresh pricing/context/parameters from the public catalog (no auth required). */
  async refreshCatalog(fetchImpl: typeof fetch = fetch): Promise<void> {
    try {
      const res = await fetchImpl(this.config.provider.catalog_url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { models?: CatalogEntry[]; data?: CatalogEntry[] };
      const all = body.models ?? body.data ?? [];
      const wanted = new Set(this.config.models.map((m) => m.provider_id));
      const entries = all.filter((e) => wanted.has(e.id));
      this.catalog.clear();
      for (const e of entries) this.catalog.set(e.id, e);
      this.catalogFetchedAt = new Date().toISOString();
      this.catalogError = null;
      this.db.kvSet("ai.catalog", { at: this.catalogFetchedAt, entries });
    } catch (e) {
      this.catalogError = (e as Error).message;
    }
  }

  model(id: AllowedModelId) {
    const m = this.config.models.find((x) => x.id === id);
    if (!m) throw new Error(`model ${id} is not allowed`);
    return m;
  }

  catalogEntry(id: AllowedModelId): CatalogEntry | null {
    return this.catalog.get(this.model(id).provider_id) ?? null;
  }

  probe(id: AllowedModelId): ProbeResult | null {
    const r = this.db.get<{ result_json: string }>("SELECT result_json FROM model_probes WHERE model = ?", id);
    return r ? json<ProbeResult | null>(r.result_json, null) : null;
  }

  saveProbe(id: AllowedModelId, p: ProbeResult): void {
    this.db.run("INSERT INTO model_probes(model, at, result_json) VALUES(?,?,?) ON CONFLICT(model) DO UPDATE SET at = excluded.at, result_json = excluded.result_json", id, p.at, JSON.stringify(p));
  }

  /** Parameter support from catalog (`supported_parameters`). Unknown when the catalog is unavailable. */
  supportsParam(id: AllowedModelId, param: string): "supported" | "unsupported" | "unknown" {
    const e = this.catalogEntry(id);
    if (!e?.supported_parameters) return "unknown";
    return e.supported_parameters.includes(param) ? "supported" : "unsupported";
  }

  /** A model is usable unless it is missing from the catalog or its last probe failed. */
  usable(id: AllowedModelId): boolean {
    const p = this.probe(id);
    if (p && !p.ok) return false;
    if (this.catalogFetchedAt && !this.catalogEntry(id)) return false;
    return true;
  }

  pricePerToken(id: AllowedModelId): { prompt: number | null; completion: number | null } {
    const e = this.catalogEntry(id);
    const n = (s?: string) => (s !== undefined && Number.isFinite(Number(s)) ? Number(s) : null);
    return { prompt: n(e?.pricing?.prompt ?? e?.pricing?.cost), completion: n(e?.pricing?.completion) };
  }

  rolesFor(id: AllowedModelId): string[] {
    return Object.entries(this.config.roles)
      .filter(([, r]) => r && (r.primary === id || r.fallback.includes(id)))
      .map(([k]) => k);
  }

  views(): ModelView[] {
    return this.config.models.map((m) => {
      const e = this.catalogEntry(m.id);
      const p = this.probe(m.id);
      const price = this.pricePerToken(m.id);
      const supports: ModelView["supports"] = {
        tools: this.supportsParam(m.id, "tools"),
        structured_outputs: this.supportsParam(m.id, "structured_outputs"),
        response_format: this.supportsParam(m.id, "response_format"),
        reasoning: this.supportsParam(m.id, "reasoning"),
        temperature: this.supportsParam(m.id, "temperature"),
        ...(p?.supports ?? {}),
      };
      return {
        id: m.id,
        providerId: m.provider_id,
        kind: m.kind,
        available: p ? (p.ok ? "verified" : "unavailable") : e ? "listed" : this.catalogFetchedAt ? "unavailable" : "unknown",
        contextLength: e?.context_length ?? null,
        promptPricePerToken: price.prompt,
        completionPricePerToken: price.completion,
        supports,
        roles: this.rolesFor(m.id),
        lastProbe: p ? { at: p.at, ok: p.ok, latencyMs: p.latencyMs, note: p.note } : null,
      };
    });
  }
}
