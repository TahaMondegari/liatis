import { AgentError } from "../errors.js";
import { DEMO_DB_PLANS, DEMO_PLANS, type DemoWorld, type MockApp } from "../demo/world.js";
import type { GeneratedOperation } from "./operations.generated.js";
import { buildPath, buildQuery, type LiaraRequest, type LiaraResponse, type LiaraTransport } from "./transport.js";

type Handler = (req: LiaraRequest, w: DemoWorld) => unknown;

const p = (req: LiaraRequest, k: string): string => String(req.pathParams?.[k] ?? "");
const body = <T>(req: LiaraRequest): T => (req.body ?? {}) as T;

function app(w: DemoWorld, name: string): MockApp {
  const a = w.apps.get(name);
  if (!a) throw new AgentError("NOT_FOUND", `App does not exists. (${name})`, { status: 404 });
  return a;
}

function series(w: DemoWorld, a: MockApp, key: "cpu" | "memory" | "rx" | "tx", sinceSec: number) {
  const end = w.clock.now().getTime();
  const from = Math.max(sinceSec * 1000, end - 6 * 3600_000);
  const step = Math.max(60_000, Math.floor((end - from) / 60));
  const values: [number, string][] = [];
  for (let t = from; t <= end; t += step) values.push([Math.floor(t / 1000), String(w.metric(a, key, t))]);
  return { end: Math.floor(end / 1000), result: [{ values, applet: `${a.project_id}-web` }] };
}

/** Handlers for the operations the demo exercises in depth. Other ops get a generic response. */
const HANDLERS: Record<string, Handler> = {
  "paas.getApps": (_r, w) => ({
    projects: [...w.apps.values()].map((a) => ({ _id: a._id, project_id: a.project_id, type: a.type, status: a.status, scale: a.scale, planID: a.planID, created_at: a.created_at, isDeployed: a.isDeployed })),
  }),
  "paas.getAppByName": (r, w) => {
    const a = app(w, p(r, "name"));
    return {
      project: {
        _id: a._id,
        project_id: a.project_id,
        type: a.type,
        status: a.status,
        scale: a.scale,
        planID: a.planID,
        envs: a.envs,
        defaultSubdomain: a.defaultSubdomain,
        readOnlyRootFilesystem: a.readOnlyRootFilesystem,
        zeroDowntime: a.zeroDowntime,
        fixedIPStatus: "DISABLED",
        created_at: a.created_at,
        node: { _id: "node1", IP: "185.0.0.10" },
        hourlyPrice: DEMO_PLANS[a.planID]?.hourlyPrice ?? null,
        isDeployed: a.isDeployed,
        reservedDiskSpace: 0,
      },
    };
  },
  "paas.createApp": (r, w) => {
    const b = body<{ name: string; planID: string; platform: string; network?: string }>(r);
    if (w.apps.has(b.name)) throw new AgentError("CONFLICT", "App already exists.", { status: 409 });
    if (!DEMO_PLANS[b.planID]) throw new AgentError("VALIDATION", `Invalid planID ${b.planID}`, { status: 400 });
    const a = w.addApp(b.name, b.platform, b.planID, "healthy", []);
    a.isDeployed = false;
    a.releases = [];
    a.currentRelease = null;
    a.network = b.network ?? null;
    w.balance -= 0;
    return { message: "project created" };
  },
  "paas.deleteAppByName": (r, w) => {
    app(w, p(r, "name"));
    w.apps.delete(p(r, "name"));
    return null;
  },
  "paas.turnApp": (r, w) => {
    const a = app(w, p(r, "name"));
    a.scale = body<{ scale: number }>(r).scale;
    return null;
  },
  "paas.restartApp": (r, w) => {
    const a = app(w, p(r, "name"));
    a.restarts += 1;
    if (a.scenario === "crash_loop") a.scenario = "crash_loop";
    return null;
  },
  "paas.changePlan": (r, w) => {
    const a = app(w, p(r, "name"));
    const planID = body<{ planID: string }>(r).planID;
    if (!DEMO_PLANS[planID]) throw new AgentError("VALIDATION", `Invalid planID ${planID}`, { status: 400 });
    a.planID = planID;
    // More memory resolves the OOM scenario; this is what verify-delta measures.
    if (a.scenario === "oom" && (DEMO_PLANS[planID]?.RAM.amount ?? 0) >= 8) a.scenario = "healthy";
    return null;
  },
  "paas.updateEnvs": (r, w) => {
    const b = body<{ project: string; variables: { key: string; value: string }[] }>(r);
    const a = app(w, b.project);
    a.envs = b.variables.map((v) => ({ ...v, encrypted: false, _id: w.id("env") }));
    if (a.scenario === "db_down" && a.envs.some((e) => e.key === "DATABASE_URL")) a.scenario = "healthy";
    return { message: "envs updated" };
  },
  "paas.sourcesDeploy": (r, w) => {
    app(w, p(r, "name"));
    if (!r.file || r.file.data.byteLength === 0) throw new AgentError("VALIDATION", "file is required", { status: 400 });
    return { sourceID: w.id("src") };
  },
  "paas.releasesDeploy": (r, w) => {
    const a = app(w, p(r, "name"));
    const b = body<{ sourceID: string; port?: number; type?: string }>(r);
    const missing = a.requiredEnvs.filter((k) => !a.envs.some((e) => e.key === k));
    const willFail = a.scenario === "build_fail_missing_env" && missing.length > 0;
    const rel = {
      _id: w.id("rel"),
      sourceID: b.sourceID,
      state: "QUEUED",
      port: b.port ?? 3000,
      type: b.type ?? a.type,
      createdAt: w.nowIso(),
      finishedAt: null,
      tag: `v${a.releases.length + 1}`,
      polls: 0,
      willFail,
      buildLog: [
        "$ npm ci",
        "added 412 packages in 38s",
        "$ npm run build",
        willFail ? `Error: ${missing[0]} is not defined\n    at connect (src/db.ts:12:9)` : "✓ Compiled successfully",
      ],
    };
    a.releases.unshift(rel);
    return { releaseID: rel._id };
  },
  "paas.getAppReleases": (r, w) => {
    const a = app(w, p(r, "name"));
    for (const rel of a.releases) {
      if (rel.finishedAt) continue;
      rel.polls += 1;
      rel.state = rel.polls === 1 ? "BUILDING" : rel.polls === 2 ? "PUSHING" : rel.polls === 3 ? "DEPLOYING" : rel.willFail ? "FAILED" : "READY";
      if (rel.state === "READY" || rel.state === "FAILED") {
        rel.finishedAt = w.nowIso();
        if (rel.state === "READY") {
          a.currentRelease = rel._id;
          a.isDeployed = true;
          if (a.scenario === "build_fail_missing_env") a.scenario = "healthy";
        }
      }
    }
    const page = Number(r.query?.page ?? 1);
    const count = Number(r.query?.count ?? 10);
    const slice = a.releases.slice((page - 1) * count, page * count);
    return {
      total: a.releases.length,
      currentRelease: a.currentRelease,
      readyReleasesCount: a.releases.filter((x) => x.state === "READY").length,
      platform: a.type,
      releases: slice.map((x) => ({ _id: x._id, type: x.type, state: x.state, port: x.port, createdAt: x.createdAt, finishedAt: x.finishedAt, tag: x.tag, sourceAvailable: true, client: "api" })),
    };
  },
  "paas.getAppLogs": (r, w) => {
    const a = app(w, p(r, "name"));
    const since = Number(r.query?.since ?? 0);
    const building = a.releases.find((x) => !x.finishedAt || x.state === "FAILED");
    const build = building ? building.buildLog.map((m) => ({ type: "build", datetime: building.createdAt, message: m })) : [];
    return [...build, ...w.logs(a, since)];
  },
  "paas.getAppEvents": (r, w) => {
    const a = app(w, p(r, "name"));
    const values: unknown[] = [];
    for (let i = 0; i < a.restarts; i++) values.push([w.clock.now().getTime() - i * 600_000, JSON.stringify({ reason: a.scenario === "oom" ? "OOMKilled" : "Error", exitCode: a.scenario === "oom" ? 137 : 1 })]);
    return { data: [{ metaData: { type: "restart", project: a.project_id }, values }] };
  },
  "paas.getAppApplets": (r, w) => {
    const a = app(w, p(r, "name"));
    return { applets: [{ id: `${a.project_id}-web-1`, name: "web", timestamp: w.nowIso(), state: a.scale === 0 ? "stopped" : a.scenario === "crash_loop" ? "CrashLoopBackOff" : "running", reason: a.scenario === "oom" ? "OOMKilled" : null, release: { releaseID: a.currentRelease, tag: "latest" } }] };
  },
  "paas.getAppSummaryReports": (r, w) => {
    const a = app(w, p(r, "name"));
    const t = w.clock.now().getTime();
    return {
      cpuUsage: [{ value: [Math.floor(t / 1000), String(w.metric(a, "cpu", t))], applet: `${a.project_id}-web` }],
      memoryUsage: [{ value: [Math.floor(t / 1000), String(w.metric(a, "memory", t))], applet: `${a.project_id}-web` }],
      disksUsage: [],
    };
  },
  "paas.getAppCpuReports": (r, w) => series(w, app(w, p(r, "name")), "cpu", Number(r.query?.since ?? 0)),
  "paas.getAppMemoryReports": (r, w) => series(w, app(w, p(r, "name")), "memory", Number(r.query?.since ?? 0)),
  "paas.getAppNetworkReceiveReports": (r, w) => series(w, app(w, p(r, "name")), "rx", Number(r.query?.since ?? 0)),
  "paas.getNetworkTransmitReports": (r, w) => series(w, app(w, p(r, "name")), "tx", Number(r.query?.since ?? 0)),
  "paas.getAppDomains": (r, w) => ({
    domains: [...w.domains.values()]
      .filter((d) => !r.query?.project || d.project === r.query.project)
      .map((d) => ({ _id: d._id, name: d.name, type: d.type, project: { _id: w.apps.get(d.project)?._id, project_id: d.project }, status: d.status, certificatesStatus: d.certificatesStatus, redirectTo: d.redirectTo, CNameRecord: `${d.project}.liara.run` })),
  }),
  "paas.createAppDomain": (r, w) => {
    const b = body<{ name: string; project: string; type: string }>(r);
    app(w, b.project);
    const id = w.id("dom");
    w.domains.set(id, { _id: id, name: b.name, project: b.project, status: "PENDING", certificatesStatus: "NOT_ISSUED", type: b.type, redirectTo: null });
    return { domain: { _id: id } };
  },
  "paas.checkDomain": (r, w) => {
    const d = w.domains.get(p(r, "id"));
    if (!d) throw new AgentError("NOT_FOUND", "domain not found", { status: 404 });
    return { domain: { ...d, project: { project_id: d.project }, CNameRecord: `${d.project}.liara.run` } };
  },
  "paas.enableSsl": (r, w) => {
    const name = body<{ domain: string }>(r).domain;
    for (const d of w.domains.values()) if (d.name === name) d.certificatesStatus = "ACTIVE";
    return { code: "ok" };
  },
  "dbaas.getListDatabases": (_r, w) => ({ databases: [...w.databases.values()].map((d) => ({ DBId: d.id, id: d.id, type: d.type, planID: d.planID, status: d.down ? "STOPPED" : d.status, scale: d.scale, hostname: d.hostname, publicNetwork: d.publicNetwork, created_at: d.created_at, internalPort: 5432 })) }),
  "dbaas.getDatabase": (r, w) => {
    const d = [...w.databases.values()].find((x) => x.id === p(r, "id") || x.hostname === p(r, "id"));
    if (!d) throw new AgentError("NOT_FOUND", "database not found", { status: 404 });
    return { database: { id: d.id, DBId: d.id, type: d.type, planID: d.planID, status: d.down ? "STOPPED" : d.status, scale: d.scale, hostname: d.hostname, publicNetwork: d.publicNetwork, version: d.version, volumeSize: 20, created_at: d.created_at, port: 5432, internalPort: 5432, root_password: "demo-root-password", username: "root", hourlyPrice: DEMO_DB_PLANS[d.planID]?.hourlyPrice ?? null } };
  },
  "dbaas.createDatabase": (r, w) => {
    const b = body<{ hostname: string; type: string; planID: string; version?: string; publicNetwork?: boolean }>(r);
    const id = w.id("db");
    w.databases.set(b.hostname, { id, hostname: b.hostname, type: b.type, planID: b.planID, status: "RUNNING", scale: 1, version: b.version ?? "16", publicNetwork: Boolean(b.publicNetwork), created_at: w.nowIso(), backups: [], down: false });
    return { databaseID: id };
  },
  "dbaas.getListBackups": (r, w) => ({ backups: [...w.databases.values()].find((x) => x.id === p(r, "id"))?.backups ?? [] }),
  "dbaas.createBackup": (r, w) => {
    const d = [...w.databases.values()].find((x) => x.id === p(r, "id"));
    d?.backups.unshift({ name: `${d.hostname}-${w.nowIso().slice(0, 10)}.gz`, lastModified: w.nowIso(), size: 12_400_000, etag: w.id("e") });
    return null;
  },
  "billing.getBilling": (_r, w) => ({ user: { balance: w.balance, accountType: "personal", minCreditAmount: 50_000, isManualMinCredit: false } }),
  "account.getMe": (_r, w) => ({
    user: { _id: "demo-user", fullname: "کاربر نمونه", email: "demo@example.ir", isTeam: false, accountType: "personal" },
    plans: { projects: DEMO_PLANS, databases: DEMO_DB_PLANS, projectBundlePlans: {}, databaseBundlePlans: {} },
    databaseVersions: { postgres: [{ label: "16", value: "16" }, { label: "15", value: "15" }], mysql: [{ label: "8.0", value: "8.0.30" }], mongodb: ["7"], redis: ["7"] },
    defaultDatabaseVersions: { postgres: "16" },
    balanceHint: w.balance,
  }),
  "account.getMeFreeCredit": () => ({ remainingFreeCredit: 0 }),
  "dns.getListZones": (_r, w) => ({ status: "success", data: [...w.zones.values()].map((z) => ({ id: z.id, name: z.name, status: z.status, nameServers: ["ns1.liara.ir", "ns2.liara.ir"], currentNameServers: ["ns1.liara.ir", "ns2.liara.ir"], createdAt: w.nowIso() })) }),
  "dns.getListDnsRecords": (r, w) => ({ status: "success", data: w.zones.get(p(r, "zone"))?.records ?? [] }),
  "dns.checkNameServer": () => ({ status: "success", data: "ok" }),
  "storage.getBuckets": (_r, w) => ({ status: "success", buckets: [...w.buckets.values()] }),
};

/**
 * In-process Mock Liara API. Implements the same contract as HttpTransport and
 * validates paths/queries with the same spec-derived rules, so demo flows
 * exercise the real request-building code.
 */
export class MockTransport implements LiaraTransport {
  readonly kind = "mock" as const;
  readonly calls: { opId: string; method: string; path: string }[] = [];
  constructor(readonly world: DemoWorld) {}

  async send<T>(op: GeneratedOperation, req: LiaraRequest): Promise<LiaraResponse<T>> {
    const path = buildPath(op, req.pathParams) + buildQuery(op, req.query);
    this.calls.push({ opId: op.id, method: op.method, path });
    if (this.world.globalFault === "auth_error") throw new AgentError("AUTHENTICATION", `${op.id} → HTTP 401: Missing authentication`, { status: 401 });
    if (this.world.globalFault === "timeout") throw new AgentError("TIMEOUT", `${op.id}: The operation was aborted due to timeout`, { retryable: true });
    if (op.method !== "GET") this.world.mutations.push(op.id);
    const h = HANDLERS[op.id];
    const data = h ? h(req, this.world) : op.method === "GET" ? genericRead(op) : { message: "ok (demo)" };
    return { status: 200, data: data as T, requestId: `mock_${this.calls.length}`, durationMs: 5, attempts: 1 };
  }
}

function genericRead(op: GeneratedOperation): unknown {
  // Empty-but-well-formed responses for read operations not modelled in depth.
  const s = op.service;
  if (s === "iaas") return op.operationId === "getVMs" ? { vms: [] } : {};
  if (s === "mail") return { status: "success", data: { mailServers: [] } };
  if (s === "storage") return { status: "success", data: {} };
  return {};
}
