import type { Block } from "@liara-agent/shared";
import type { Ctx } from "../context.js";
import type { SecretStore } from "../security/secrets.js";
import type { ChatService } from "./chat.js";
import type { RunStore } from "./runs.js";
import type { PlanOption } from "@liara-agent/shared";

/** Dependencies shared by the workflows. */
export interface Kit {
  ctx: Ctx;
  chat: ChatService;
  runs: RunStore;
  secrets: SecretStore;
  plans: PlanCache;
  bg: (label: string, fn: () => Promise<void>) => void;
}

/** Caches GET /v1/me plan catalogue for 10 minutes. */
export class PlanCache {
  private cache: { at: number; projects: PlanOption[]; databases: PlanOption[]; dbVersions: Record<string, string[]> } | null = null;
  constructor(private ctx: Ctx) {}
  async get() {
    if (this.cache && Date.now() - this.cache.at < 600_000) return this.cache;
    const [p, d] = await Promise.all([this.ctx.liara.plans("projects"), this.ctx.liara.plans("databases")]);
    this.cache = { at: Date.now(), projects: p.plans, databases: d.plans, dbVersions: p.databaseVersions };
    return this.cache;
  }
  async ramOf(planId: string | null): Promise<{ ramGb: number | null; cpu: number | null; hourly: number | null }> {
    if (!planId) return { ramGb: null, cpu: null, hourly: null };
    try {
      const c = await this.get();
      const p = c.projects.find((x) => x.planId === planId);
      return { ramGb: p?.ramGb ?? null, cpu: p?.cpu ?? null, hourly: p?.price.hourlyToman ?? (p?.price.monthlyToman ? p.price.monthlyToman / 730 : null) };
    } catch {
      return { ramGb: null, cpu: null, hourly: null };
    }
  }
}

export const text = (t: string): Block => ({ type: "text", text: t });
