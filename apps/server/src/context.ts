import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./config.js";
import { Db } from "./db/db.js";
import { EventBus } from "./events/bus.js";
import { AuditLog } from "./audit/audit.js";
import { CapabilityRegistry } from "./liara/capabilities.js";
import { LiaraClient } from "./liara/client.js";
import { HttpTransport } from "./liara/httpTransport.js";
import { MockTransport } from "./liara/mockTransport.js";
import { LiaraServices } from "./liara/services.js";
import type { LiaraTransport } from "./liara/transport.js";
import { DemoWorld } from "./demo/world.js";
import { PolicyEngine, type StandingAuthorization } from "./policy/policy.js";
import { ApprovalService } from "./policy/approvals.js";
import { ToolGateway } from "./tools/gateway.js";
import { loadModelsConfig, ModelRegistry } from "./ai/models.js";
import { LlmGateway } from "./ai/gateway.js";
import { WorkspaceManager } from "./workspace/source.js";
import { DisabledSandbox, DockerSandbox, SimulatedSandbox, type Sandbox } from "./sandbox/sandbox.js";
import { QualityGate } from "./gate/qualityGate.js";
import { ErrorKnowledgeBase } from "./rca/rca.js";
import { CodingAgent } from "./repair/coding.js";
import { MockProber, RealProber, type Prober } from "./verify/prober.js";
import { IncidentService } from "./monitor/incidents.js";
import { Notifier } from "./notify/notify.js";
import { registerSecret } from "./security/redact.js";
import { type Clock, systemClock } from "./util.js";
import { json } from "./db/db.js";
import type { PatrolSettings } from "@liara-agent/shared";

export const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(SERVER_ROOT, "..", "..");

export interface Ctx {
  cfg: AppConfig;
  clock: Clock;
  db: Db;
  bus: EventBus;
  audit: AuditLog;
  registry: CapabilityRegistry;
  transport: LiaraTransport;
  client: LiaraClient;
  liara: LiaraServices;
  world: DemoWorld | null;
  policy: PolicyEngine;
  approvals: ApprovalService;
  gateway: ToolGateway;
  models: ModelRegistry;
  llm: LlmGateway;
  workspaces: WorkspaceManager;
  sandbox: Sandbox;
  gate: QualityGate;
  kb: ErrorKnowledgeBase;
  coder: CodingAgent;
  prober: Prober;
  incidents: IncidentService;
  notifier: Notifier;
}

export interface CtxOverrides {
  clock?: Clock;
  db?: Db;
  transport?: LiaraTransport;
  fetchImpl?: typeof fetch;
  sandbox?: Sandbox;
  prober?: Prober;
}

export function createContext(cfg: AppConfig, o: CtxOverrides = {}): Ctx {
  const clock = o.clock ?? systemClock;
  const db = o.db ?? new Db(cfg.databasePath);
  registerSecret(cfg.liara.token);
  registerSecret(cfg.ai.apiKey);
  registerSecret(cfg.telegram.token);
  const bus = new EventBus(db);
  const audit = new AuditLog(db, cfg.mode);
  const registry = new CapabilityRegistry({ fileBrowserUrl: cfg.liara.fileBrowserUrl, dbInspectorUrl: cfg.liara.dbInspectorUrl });

  // Demo/Real separation: demo mode can only ever construct the mock transport.
  let world: DemoWorld | null = null;
  let transport: LiaraTransport;
  if (cfg.mode === "demo") {
    if (o.transport && o.transport.kind !== "mock") throw new Error("demo mode refuses a non-mock Liara transport");
    world = o.transport instanceof MockTransport ? o.transport.world : new DemoWorld(clock);
    transport = o.transport ?? new MockTransport(world);
  } else {
    transport = o.transport ?? new HttpTransport({ token: cfg.liara.token!, teamId: cfg.liara.teamId, aiApiKey: cfg.ai.apiKey, fileBrowserUrl: cfg.liara.fileBrowserUrl, dbInspectorUrl: cfg.liara.dbInspectorUrl, fetchImpl: o.fetchImpl });
  }
  const client = new LiaraClient(registry, transport);
  const liara = new LiaraServices(client);

  const standing = (): StandingAuthorization[] => {
    const out: StandingAuthorization[] = [];
    for (const r of db.all<{ project_name: string; settings_json: string }>("SELECT project_name, settings_json FROM patrol_settings")) {
      const s = json<PatrolSettings | null>(r.settings_json, null);
      if (s?.enabled && s.autoRestartOnCrashLoop) out.push({ capabilityId: "paas.restartApp", resource: r.project_name, maxPerWindow: 1, windowMs: 24 * 3600_000 });
    }
    if (cfg.notifyMail.to) out.push({ capabilityId: "mail.sendMail", resource: cfg.notifyMail.to, maxPerWindow: 24, windowMs: 24 * 3600_000 });
    return out;
  };
  const recent = (capId: string, resource: string, windowMs: number) =>
    Number(db.get<{ n: number }>("SELECT COUNT(*) n FROM audit WHERE capability_id = ? AND resource = ? AND status = 'ok' AND at >= ?", capId, resource, new Date(clock.now().getTime() - windowMs).toISOString())?.n ?? 0);
  const policy = new PolicyEngine(registry, cfg.mode, () => transport.kind, standing, recent);
  const approvals = new ApprovalService(db, clock, cfg.approvalTtlMinutes);
  const gateway = new ToolGateway(client, policy, approvals, audit, (a) => {
    bus.emit("approval.request", { approval: a }, { chatId: a.chatId, runId: a.runId });
  });

  const models = new ModelRegistry(loadModelsConfig(), db);
  const llm = new LlmGateway(models, db, clock, { baseUrl: cfg.ai.baseUrl, apiKey: cfg.ai.apiKey, dailyBudgetToman: cfg.ai.dailyBudgetToman, dailyBudgetUsd: cfg.ai.dailyBudgetUsd, runBudgetToman: cfg.ai.runBudgetToman, fetchImpl: o.fetchImpl });

  const workspaces = new WorkspaceManager(db, join(dirname(cfg.databasePath), "workspaces"));
  const sandbox = o.sandbox ?? (cfg.sandbox.driver === "disabled" ? new DisabledSandbox() : cfg.mode === "demo" ? new SimulatedSandbox() : new DockerSandbox({ cpu: cfg.sandbox.cpu, memory: cfg.sandbox.memory }));
  const gate = new QualityGate(sandbox, cfg.sandbox);
  const kb = new ErrorKnowledgeBase(db);
  const coder = new CodingAgent(llm);
  const prober = o.prober ?? (world ? new MockProber(world) : new RealProber());
  const incidents = new IncidentService(db, bus, clock);
  let gw: ToolGateway | null = null;
  const notifier = new Notifier(db, bus, clock, { telegram: cfg.telegram, mail: cfg.notifyMail, publicUrl: cfg.webOrigin }, () => gw);
  gw = gateway;

  return { cfg, clock, db, bus, audit, registry, transport, client, liara, world, policy, approvals, gateway, models, llm, workspaces, sandbox, gate, kb, coder, prober, incidents, notifier };
}
