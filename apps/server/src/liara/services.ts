import type { MetricSeries, PlanOption, Money } from "@liara-agent/shared";
import type { LiaraClient } from "./client.js";

/** Typed, defensive readers over L0 Liara endpoints used by deterministic workflows. */

export interface AppInfo {
  name: string;
  id: string | null;
  platform: string | null;
  status: string | null;
  scale: number | null;
  planId: string | null;
  isDeployed: boolean | null;
  createdAt: string | null;
  hourlyPrice: number | null;
  envKeys: string[];
  zeroDowntime: boolean | null;
  defaultSubdomain: boolean | null;
}

export interface ReleaseInfo {
  id: string;
  state: string;
  createdAt: string | null;
  finishedAt: string | null;
  tag: string | null;
  port: number | null;
  sourceAvailable: boolean | null;
}

export interface LogLine {
  type: string;
  datetime: string;
  message: string;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export const TERMINAL_RELEASE_STATES = new Set(["READY", "FAILED", "CANCELED", "CANCELLED", "TIMEOUT"]);

export class LiaraServices {
  constructor(readonly client: LiaraClient) {}

  async listApps(): Promise<AppInfo[]> {
    const d = obj(await this.client.read("paas.getApps"));
    const arr = Array.isArray(d.projects) ? d.projects : [];
    return arr.map((p) => this.toApp(obj(p)));
  }

  async getApp(name: string): Promise<AppInfo | null> {
    try {
      const d = obj(await this.client.read("paas.getAppByName", { pathParams: { name } }));
      return this.toApp(obj(d.project));
    } catch (e) {
      if ((e as { code?: string }).code === "NOT_FOUND") return null;
      throw e;
    }
  }

  private toApp(p: Record<string, unknown>): AppInfo {
    const envs = Array.isArray(p.envs) ? p.envs : [];
    return {
      name: str(p.project_id) ?? "?",
      id: str(p._id),
      platform: str(p.type),
      status: str(p.status),
      scale: num(p.scale),
      planId: str(p.planID),
      isDeployed: typeof p.isDeployed === "boolean" ? p.isDeployed : null,
      createdAt: str(p.created_at),
      hourlyPrice: num(p.hourlyPrice),
      envKeys: envs.map((e) => str(obj(e).key)).filter((k): k is string => !!k),
      zeroDowntime: typeof p.zeroDowntime === "boolean" ? p.zeroDowntime : null,
      defaultSubdomain: typeof p.defaultSubdomain === "boolean" ? p.defaultSubdomain : null,
    };
  }

  async releases(name: string, count = 10): Promise<{ current: string | null; releases: ReleaseInfo[] }> {
    const d = obj(await this.client.read("paas.getAppReleases", { pathParams: { name }, query: { page: 1, count } }));
    const rels = Array.isArray(d.releases) ? d.releases : [];
    return {
      current: str(d.currentRelease),
      releases: rels.map((r) => {
        const o = obj(r);
        return { id: str(o._id) ?? "?", state: (str(o.state) ?? "UNKNOWN").toUpperCase(), createdAt: str(o.createdAt), finishedAt: str(o.finishedAt), tag: str(o.tag), port: num(o.port), sourceAvailable: typeof o.sourceAvailable === "boolean" ? o.sourceAvailable : null };
      }),
    };
  }

  async logs(name: string, sinceSec: number): Promise<LogLine[]> {
    const d = await this.client.read("paas.getAppLogs", { pathParams: { name }, query: { since: String(Math.floor(sinceSec)) } });
    const arr = Array.isArray(d) ? d : [];
    return arr.map((l) => {
      const o = obj(l);
      return { type: str(o.type) ?? "stdout", datetime: str(o.datetime) ?? "", message: typeof o.message === "string" ? o.message : JSON.stringify(o.message ?? "") };
    });
  }

  async events(name: string): Promise<{ type: string | null; at: number | null; detail: string }[]> {
    const d = obj(await this.client.read("paas.getAppEvents", { pathParams: { name } }));
    const out: { type: string | null; at: number | null; detail: string }[] = [];
    for (const s of Array.isArray(d.data) ? d.data : []) {
      const so = obj(s);
      const type = str(obj(so.metaData).type);
      for (const v of Array.isArray(so.values) ? so.values : []) {
        const arr = Array.isArray(v) ? v : [];
        out.push({ type, at: num(arr[0]), detail: typeof arr[1] === "string" ? arr[1] : JSON.stringify(arr[1] ?? "") });
      }
    }
    return out;
  }

  async applets(name: string): Promise<{ name: string | null; state: string | null; reason: string | null }[]> {
    const d = obj(await this.client.read("paas.getAppApplets", { pathParams: { name } }));
    return (Array.isArray(d.applets) ? d.applets : []).map((a) => {
      const o = obj(a);
      return { name: str(o.name), state: str(o.state), reason: str(o.reason) };
    });
  }

  /** Metric series. Units are as returned by Liara (memory in bytes, cpu in cores — per observed responses; flagged in RECON). */
  async metric(name: string, kind: "cpu" | "memory" | "network-receive" | "network-transmit", sinceSec: number): Promise<MetricSeries> {
    const capId = { cpu: "paas.getAppCpuReports", memory: "paas.getAppMemoryReports", "network-receive": "paas.getAppNetworkReceiveReports", "network-transmit": "paas.getNetworkTransmitReports" }[kind];
    const d = obj(await this.client.read(capId, { pathParams: { name }, query: { since: Math.floor(sinceSec) } }));
    const points: { t: number; v: number }[] = [];
    for (const r of Array.isArray(d.result) ? d.result : []) {
      for (const v of Array.isArray(obj(r).values) ? (obj(r).values as unknown[]) : []) {
        const a = Array.isArray(v) ? v : [];
        const t = num(a[0]);
        const val = num(a[1]);
        if (t !== null && val !== null) points.push({ t: t * 1000, v: val });
      }
    }
    points.sort((a, b) => a.t - b.t);
    const labels = { cpu: ["پردازنده", "core"], memory: ["حافظه", "bytes"], "network-receive": ["ترافیک ورودی", "B/s"], "network-transmit": ["ترافیک خروجی", "B/s"] } as const;
    return { key: kind, label: labels[kind][0], unit: labels[kind][1], points, source: capId };
  }

  /** GET /v1/domains requires the `project` query parameter (spec). */
  async domains(project: string): Promise<{ id: string; name: string; status: string | null; certificatesStatus: string | null; project: string | null; cname: string | null }[]> {
    const d = obj(await this.client.read("paas.getAppDomains", { query: { project } }));
    return (Array.isArray(d.domains) ? d.domains : []).map((x) => {
      const o = obj(x);
      return { id: str(o._id) ?? "?", name: str(o.name) ?? "?", status: str(o.status), certificatesStatus: str(o.certificatesStatus), project: str(obj(o.project).project_id), cname: str(o.CNameRecord) };
    });
  }

  /** In team mode (`?teamID=`) Liara returns the team wallet under `team`; that is the one services are billed from. */
  async balance(): Promise<{ balance: number | null; minCredit: number | null; scope: "team" | "user" }> {
    const r = obj(await this.client.read("billing.getBilling"));
    const team = obj(r.team);
    const d = Object.keys(team).length ? team : obj(r.user);
    return { balance: num(d.balance), minCredit: num(d.minCreditAmount), scope: Object.keys(team).length ? "team" : "user" };
  }

  async databases(): Promise<{ id: string; hostname: string; type: string | null; status: string | null; planId: string | null; publicNetwork: boolean | null }[]> {
    const d = obj(await this.client.read("dbaas.getListDatabases"));
    return (Array.isArray(d.databases) ? d.databases : []).map((x) => {
      const o = obj(x);
      return { id: str(o.id) ?? str(o.DBId) ?? "?", hostname: str(o.hostname) ?? "?", type: str(o.type), status: str(o.status), planId: str(o.planID), publicNetwork: typeof o.publicNetwork === "boolean" ? o.publicNetwork : null };
    });
  }

  /**
   * Plan catalogue from GET /v1/me (plans.projects / plans.databases).
   * The spec types these as free-form objects, so each field is parsed
   * defensively and missing values stay null (shown as «نامشخص»).
   */
  async plans(kind: "projects" | "databases"): Promise<{ plans: PlanOption[]; databaseVersions: Record<string, string[]> }> {
    const me = obj(await this.client.read("account.getMe"));
    const raw = obj(obj(me.plans)[kind]);
    const plans: PlanOption[] = [];
    for (const [planId, v] of Object.entries(raw)) {
      const o = obj(v);
      const ram = num(obj(o.RAM).amount) ?? num(o.ram) ?? num(o.memory);
      const cpu = num(obj(o.CPU).amount) ?? num(o.cpu);
      const disk = num(o.volume) ?? num(o.disk) ?? num(o.storage);
      // Observed on the live API: `price` is the hourly Toman price (Liara CLI shows price × 720 per month).
      const hourly = num(o.hourlyPrice) ?? num(o.price);
      const monthly = num(o.monthlyPrice) ?? (hourly !== null ? hourly * 720 : null);
      const price: Money = {
        status: hourly !== null ? "from_api" : "unavailable",
        hourlyToman: hourly,
        monthlyToman: monthly,
        source: "GET /v1/me → plans",
        note: hourly === null ? "قیمت این پلن در پاسخ API نبود." : "ماهانه = ساعتی × ۷۲۰ (روش Liara CLI).",
      };
      plans.push({
        planId,
        title: planId,
        cpu,
        ramGb: ram,
        diskGb: disk,
        capacityHint: null,
        price,
        recommended: false,
        available: o.available === undefined ? true : Boolean(o.available),
        details: Object.entries(o)
          .filter(([k, val]) => (typeof val !== "object" || Array.isArray(val)) && !/price/i.test(k))
          .slice(0, 10)
          .map(([k, val]) => ({ label: k, value: Array.isArray(val) ? val.join(",") : String(val) })),
      });
    }
    const dv = obj(me.databaseVersions);
    const databaseVersions: Record<string, string[]> = {};
    // Live shape: [{ label: "9.0", value: "9.0.1" }, …] newest first; older/demo shape: plain strings.
    for (const [k, v] of Object.entries(dv)) if (Array.isArray(v)) databaseVersions[k] = v.map((x) => (typeof x === "string" ? x : (str(obj(x).value) ?? str(obj(x).label) ?? String(x))));
    plans.sort((a, b) => (a.ramGb ?? 0) - (b.ramGb ?? 0));
    return { plans, databaseVersions };
  }
}
