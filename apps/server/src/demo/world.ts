import type { Clock } from "../util.js";

/**
 * Deterministic simulated Liara account used by Demo Mode and tests.
 * Nothing here talks to the network. Every value is synthetic and the UI
 * labels it as «داده نمونه».
 */
export type Scenario =
  | "healthy"
  | "oom"
  | "http500"
  | "db_down"
  | "slow"
  | "crash_loop"
  | "build_fail_missing_env"
  | "bad_release_500"
  | "dns_error"
  | "timeout"
  | "auth_error";

export interface MockRelease {
  _id: string;
  sourceID: string;
  state: string;
  port: number;
  type: string;
  createdAt: string;
  finishedAt: string | null;
  tag: string;
  polls: number;
  willFail: boolean;
  buildLog: string[];
}

export interface MockApp {
  _id: string;
  project_id: string;
  type: string;
  status: string;
  scale: number;
  planID: string;
  envs: { key: string; value: string; encrypted: boolean; _id: string }[];
  created_at: string;
  isDeployed: boolean;
  zeroDowntime: boolean;
  defaultSubdomain: boolean;
  readOnlyRootFilesystem: boolean;
  network: string | null;
  scenario: Scenario;
  releases: MockRelease[];
  currentRelease: string | null;
  restarts: number;
  domains: string[];
  /** the app requires these env keys at build/run time (drives build_fail_missing_env) */
  requiredEnvs: string[];
}

export interface MockDatabase {
  id: string;
  hostname: string;
  type: string;
  planID: string;
  status: string;
  scale: number;
  version: string;
  publicNetwork: boolean;
  created_at: string;
  backups: { name: string; lastModified: string; size: number; etag: string }[];
  down: boolean;
}

/** Synthetic plan catalogue in the shape returned by GET /v1/me → plans.projects (demo only). */
export const DEMO_PLANS: Record<string, { available: boolean; RAM: { amount: number }; CPU: { amount: number }; volume: number; price: number; hourlyPrice: number; region: string }> = {
  "demo-earth": { available: true, RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, volume: 5, price: 280_000, hourlyPrice: 389, region: "iran" },
  "demo-mars": { available: true, RAM: { amount: 1 }, CPU: { amount: 1 }, volume: 10, price: 560_000, hourlyPrice: 778, region: "iran" },
  "demo-jupiter": { available: true, RAM: { amount: 2 }, CPU: { amount: 1 }, volume: 20, price: 1_120_000, hourlyPrice: 1_556, region: "iran" },
  "demo-saturn": { available: true, RAM: { amount: 4 }, CPU: { amount: 2 }, volume: 40, price: 2_240_000, hourlyPrice: 3_111, region: "iran" },
  "demo-uranus": { available: true, RAM: { amount: 8 }, CPU: { amount: 4 }, volume: 80, price: 4_480_000, hourlyPrice: 6_222, region: "iran" },
  "demo-neptune": { available: true, RAM: { amount: 16 }, CPU: { amount: 8 }, volume: 160, price: 8_960_000, hourlyPrice: 12_444, region: "iran" },
};

export const DEMO_DB_PLANS: Record<string, { available: boolean; RAM: { amount: number }; CPU: { amount: number }; volume: number; price: number; hourlyPrice: number }> = {
  "demo-db-small": { available: true, RAM: { amount: 1 }, CPU: { amount: 0.5 }, volume: 10, price: 420_000, hourlyPrice: 583 },
  "demo-db-medium": { available: true, RAM: { amount: 2 }, CPU: { amount: 1 }, volume: 20, price: 840_000, hourlyPrice: 1_167 },
};

export class DemoWorld {
  apps = new Map<string, MockApp>();
  databases = new Map<string, MockDatabase>();
  balance = 8_500_000;
  zones = new Map<string, { id: string; name: string; status: string; records: { id: string; name: string; type: string; ttl: number; contents: unknown[] }[] }>();
  buckets = new Map<string, { id: string; name: string; plan: string; status: string; permission: string; createdAt: string }>();
  domains = new Map<string, { _id: string; name: string; project: string; status: string; certificatesStatus: string; type: string; redirectTo: string | null }>();
  /** mutations performed (tests assert on this) */
  mutations: string[] = [];
  globalFault: "none" | "auth_error" | "timeout" = "none";
  private seq = 0;

  constructor(public clock: Clock) {
    this.seed();
  }

  id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(6, "0")}`;
  }

  nowIso(): string {
    return this.clock.now().toISOString();
  }

  private seed(): void {
    const t = this.nowIso();
    this.addApp("shop-front-prod", "next", "demo-saturn", "healthy", ["DATABASE_URL"], [{ key: "DATABASE_URL", value: "postgres://shop:secret@shop-db:5432/shop" }]);
    this.addApp("payment-api", "node", "demo-jupiter", "http500", [], [{ key: "NODE_ENV", value: "production" }]);
    this.addApp("blog-wp", "wordpress", "demo-mars", "healthy", []);
    this.databases.set("shop-db", {
      id: "db0001",
      hostname: "shop-db",
      type: "postgres",
      planID: "demo-db-medium",
      status: "RUNNING",
      scale: 1,
      version: "16",
      publicNetwork: false,
      created_at: t,
      backups: [{ name: "shop-db-2026-01-01.gz", lastModified: t, size: 12_300_000, etag: "e1" }],
      down: false,
    });
    this.domains.set("dom0001", { _id: "dom0001", name: "shop.example.ir", project: "shop-front-prod", status: "ACTIVE", certificatesStatus: "ACTIVE", type: "ROOT", redirectTo: null });
    this.zones.set("example.ir", {
      id: "zone0001",
      name: "example.ir",
      status: "ACTIVE",
      records: [{ id: "rec0001", name: "shop", type: "CNAME", ttl: 3600, contents: [{ host: "shop-front-prod.liara.run" }] }],
    });
    this.buckets.set("shop-media", { id: "b0001", name: "shop-media", plan: "free", status: "CREATED", permission: "private", createdAt: t });
  }

  addApp(name: string, type: string, planID: string, scenario: Scenario, requiredEnvs: string[], envs: { key: string; value: string }[] = []): MockApp {
    const t = this.nowIso();
    const rel: MockRelease = { _id: this.id("rel"), sourceID: this.id("src"), state: "READY", port: 3000, type, createdAt: t, finishedAt: t, tag: "v1", polls: 99, willFail: false, buildLog: [] };
    const app: MockApp = {
      _id: this.id("app"),
      project_id: name,
      type,
      status: "ACTIVE",
      scale: 1,
      planID,
      envs: envs.map((e) => ({ ...e, encrypted: false, _id: this.id("env") })),
      created_at: t,
      isDeployed: true,
      zeroDowntime: false,
      defaultSubdomain: true,
      readOnlyRootFilesystem: true,
      network: null,
      scenario,
      releases: [rel],
      currentRelease: rel._id,
      restarts: scenario === "crash_loop" ? 6 : scenario === "oom" ? 3 : 0,
      domains: [],
      requiredEnvs,
    };
    this.apps.set(name, app);
    return app;
  }

  setScenario(app: string, s: Scenario): void {
    const a = this.apps.get(app);
    if (a) a.scenario = s;
  }

  planRamGb(planID: string): number | null {
    return DEMO_PLANS[planID]?.RAM.amount ?? null;
  }

  /** Synthetic metric value for a series at a point in time. */
  metric(app: MockApp, key: "cpu" | "memory" | "rx" | "tx", t: number): number {
    const ramBytes = (this.planRamGb(app.planID) ?? 1) * 1024 ** 3;
    const wave = (Math.sin(t / 600_000) + 1) / 2;
    const s = app.scenario;
    if (app.scale === 0) return 0;
    switch (key) {
      case "cpu":
        return s === "slow" || s === "oom" ? 0.85 + wave * 0.08 : 0.25 + wave * 0.12;
      case "memory":
        return ramBytes * (s === "oom" ? 0.91 + wave * 0.05 : s === "crash_loop" ? 0.7 : 0.48 + wave * 0.1);
      case "rx":
        return 900_000 + wave * 300_000;
      case "tx":
        return 1_100_000 + wave * 250_000;
    }
  }

  /** Synthetic HTTP behaviour of the deployed app. */
  httpProbe(app: MockApp, path: string): { status: number; latencyMs: number; body: string } {
    if (app.scale === 0) return { status: 503, latencyMs: 40, body: "Service Unavailable" };
    const s = app.scenario;
    if (s === "http500" && path.includes("api")) return { status: 500, latencyMs: 180, body: "Internal Server Error" };
    if (s === "bad_release_500") return { status: 500, latencyMs: 120, body: "Internal Server Error" };
    if (s === "db_down" && /orders|api/.test(path)) return { status: 500, latencyMs: 2100, body: "ECONNREFUSED" };
    if (s === "oom") return { status: path.includes("cart") ? 500 : 200, latencyMs: 2400, body: "ok" };
    if (s === "slow") return { status: 200, latencyMs: 2600, body: "ok" };
    if (s === "crash_loop") return { status: 502, latencyMs: 30, body: "Bad Gateway" };
    return { status: 200, latencyMs: 280 + (path.length % 7) * 12, body: "ok" };
  }

  logs(app: MockApp, since: number): { type: string; datetime: string; message: string }[] {
    const now = this.clock.now().getTime();
    const out: { type: string; datetime: string; message: string }[] = [];
    const push = (dt: number, type: string, message: string) => {
      if (dt / 1000 >= since) out.push({ type, datetime: new Date(dt).toISOString(), message });
    };
    for (let i = 30; i >= 0; i--) {
      const t = now - i * 60_000;
      push(t, "stdout", `GET / 200 ${30 + (i % 9)}ms`);
      if (i % 3 === 0) push(t + 1000, "stdout", `GET /api/health 200 ${6 + (i % 4)}ms`);
      switch (app.scenario) {
        case "oom":
          if (i % 10 === 0) push(t + 2000, "stderr", "Container restarted (exit code 137) OOMKilled");
          if (i % 4 === 0) push(t + 3000, "stderr", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
          break;
        case "http500":
        case "bad_release_500":
          if (i % 2 === 0) push(t + 1500, "stderr", "TypeError: Cannot read properties of undefined (reading 'amount')\n    at handler (src/routes/orders.ts:40:18)");
          if (i % 2 === 0) push(t + 1600, "stdout", "POST /api/orders 500 12ms");
          break;
        case "db_down":
          if (i % 2 === 0) push(t + 1200, "stderr", "Error: connect ECONNREFUSED 10.0.0.5:5432\n    at connect (src/db.ts:12:9)");
          break;
        case "slow":
          if (i % 3 === 0) push(t + 1300, "stdout", "warn slow query 1840ms GET /api/orders");
          break;
        case "crash_loop":
          if (i % 5 === 0) push(t + 1400, "stderr", "Error: listen EADDRINUSE: address already in use :::3000");
          if (i % 5 === 0) push(t + 1500, "stderr", "Container restarted (exit code 1)");
          break;
        default:
          break;
      }
    }
    return out;
  }
}
