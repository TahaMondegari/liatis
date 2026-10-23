import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskCard, Block, Invoice, Money, PlanOption, RootCauseReport, StepView } from "@liara-agent/shared";
import { analyzeProject, PLATFORM_LABEL_FA, readPackageName, suggestAppName, type ProjectProfile } from "../analyzer/analyzer.js";
import { REPO_ROOT } from "../context.js";
import { AgentError, ERROR_FA, toAgentError } from "../errors.js";
import { rootCause } from "../rca/rca.js";
import { failureBlocks } from "../gate/qualityGate.js";
import { STAGE_FA, T } from "../i18n/fa.js";
import { TERMINAL_RELEASE_STATES } from "../liara/services.js";
import type { LiaraRequest } from "../liara/transport.js";
import { checksFrom, overall, snapshot } from "../verify/observe.js";
import { faDuration, faNum, iso, sha256, sleep } from "../util.js";
import type { Run } from "./runs.js";
import { appNameCard, capacityHint, confirmCard, databaseCard, envCard, estimateRamGb, hourlyOf, invoiceCard, money, networkCard, patrolCard, planCard, platformCard, sourceCard, stageCard, usersCard } from "./cards.js";
import { text, type Kit } from "./kit.js";

type Step =
  | "source"
  | "platform"
  | "stage"
  | "users"
  | "appName"
  | "database"
  | "network"
  | "env"
  | "plan"
  | "gate"
  | "patch"
  | "acceptIssues"
  | "invoice"
  | "execute"
  | "fixEnv"
  | "redeployApproval"
  | "verify"
  | "patrol"
  | "done";

export interface DeployState {
  chatId: string;
  demoSample: boolean;
  source: { kind: "git" | "zip" | "sample"; origin: string } | null;
  workspaceId: string | null;
  profile: Omit<ProjectProfile, "root"> | null;
  platform: string | null;
  stage: "test" | "demo" | "production" | null;
  users: number;
  appName: string | null;
  existingApp: boolean;
  database: { mode: "new" | "existing" | "none"; type: string | null; planId: string | null; version: string | null; hostname: string | null; id: string | null } | null;
  network: string | null;
  envKeys: string[];
  planId: string | null;
  port: number;
  gateOverall: string | null;
  failingTests: string[];
  repairAttempts: number;
  attempts: RootCauseReport["attempts"];
  patchesTried: string[];
  pendingPatchId: string | null;
  acceptedKnownIssues: boolean;
  packageDigest: string | null;
  approvals: { createApp?: string; createDatabase?: string; updateEnvs?: string; release?: string };
  releaseId: string | null;
  previousRelease: string | null;
  deployStartedAt: string | null;
  timelineMsgId: string | null;
  deployAttempts: number;
  lastFailure: string | null;
}

const MAX_GATE_ROUNDS = 5;

/**
 * DeployGraph (BRIEF §8.3) as an explicit, persisted state machine.
 * Each `ask` pauses the run (waiting_user); each Liara mutation goes through
 * the Tool Gateway (approval required for L2+). Resumable after restarts.
 */
export class DeployFlow {
  constructor(private k: Kit) {}

  private get ctx() {
    return this.k.ctx;
  }

  start(chatId: string, userText: string): Run<DeployState> {
    const state: DeployState = {
      chatId,
      demoSample: false,
      source: null,
      workspaceId: null,
      profile: null,
      platform: null,
      stage: null,
      users: Number(/(\d[\d,٬]*)\s*(کاربر|user)/.exec(toAscii(userText))?.[1]?.replace(/[,٬]/g, "") ?? 0) || 0,
      appName: null,
      existingApp: false,
      database: null,
      network: null,
      envKeys: [],
      planId: null,
      port: 3000,
      gateOverall: null,
      failingTests: [],
      repairAttempts: 0,
      attempts: [],
      patchesTried: [],
      pendingPatchId: null,
      acceptedKnownIssues: false,
      packageDigest: null,
      approvals: {},
      releaseId: null,
      previousRelease: null,
      deployStartedAt: null,
      timelineMsgId: null,
      deployAttempts: 0,
      lastFailure: null,
    };
    const run = this.k.runs.create<DeployState>("deploy", chatId, "source", state);
    const url = /(https:\/\/[^\s]+?(?:\.git)?)(?=\s|$)/.exec(userText)?.[1];
    if (url) {
      this.k.bg("deploy:intake", () => this.answer(run.id, "source", { kind: "git", url }));
    } else {
      this.ask(run, sourceCard(this.ctx.cfg.mode === "demo"), T.agentIntro);
    }
    return run;
  }

  private ask(run: Run<DeployState>, card: AskCard, lead?: string): void {
    run.step = card.key as Step;
    run.status = "waiting_user";
    this.k.runs.save(run);
    this.k.chat.post(run.state.chatId, "assistant", lead ?? "", [...(lead ? [] : []), { type: "ask", card }]);
    this.k.chat.phase(run.state.chatId, "waiting_answer", run.id);
    this.k.chat.done(run.state.chatId, "waiting_for_user", run.id);
  }

  /** Marks a card answered in the transcript. */
  private markAnswered(chatId: string, key: string, answer: unknown): void {
    const msgs = this.k.chat.messages(chatId).reverse();
    for (const m of msgs) {
      const idx = m.blocks.findIndex((b) => b.type === "ask" && b.card.key === key && b.card.state === "pending");
      if (idx >= 0) {
        const blocks = m.blocks.map((b, i) => (i === idx && b.type === "ask" ? { ...b, card: { ...b.card, state: "answered" as const, answer } } : b));
        this.k.chat.update(m, { blocks });
        return;
      }
    }
  }

  /** Entry point for every answer (ask card, approval batch, patch decision). */
  async answer(runId: string, key: string, value: unknown): Promise<void> {
    const run = this.k.runs.get<DeployState>(runId);
    if (!run) throw new AgentError("NOT_FOUND", "run not found");
    if (["completed", "failed", "cancelled"].includes(run.status)) throw new AgentError("CONFLICT", "این فرایند تموم شده");
    if (key !== run.step && !(key === "source" && run.step === "source")) throw new AgentError("CONFLICT", `این کارت دیگه فعال نیست (مرحله‌ی فعلی: ${run.step})`);
    const s = run.state;
    this.markAnswered(s.chatId, key, value);
    run.status = "running";
    this.k.runs.save(run);
    this.k.chat.busy(s.chatId, true);
    try {
      if (value === "__defer__") {
        this.k.chat.post(s.chatId, "assistant", "باشه؛ هر وقت آماده بودی همین کارت رو از بالا تأیید کن یا یه پیام بفرست.");
        run.status = "waiting_user";
        this.k.runs.save(run);
        this.k.chat.done(s.chatId, "waiting_for_user", run.id);
        return;
      }
      await this.handle(run, key as Step, value);
    } catch (e) {
      const err = toAgentError(e);
      this.k.runs.fail(run, err.message);
      this.k.chat.post(s.chatId, "assistant", `${ERROR_FA[err.code]}`, [{ type: "code", title: "جزئیات فنی", language: "text", code: err.message.slice(0, 800) }]);
      this.k.chat.phase(s.chatId, "failed", run.id);
      this.k.chat.done(s.chatId, "failed", run.id);
    }
  }

  private async handle(run: Run<DeployState>, step: Step, v: unknown): Promise<void> {
    const s = run.state;
    switch (step) {
      case "source":
        return this.onSource(run, v as { kind: string; url?: string; uploadId?: string });
      case "platform":
        s.platform = String(v);
        return this.ask(run, stageCard());
      case "stage":
        s.stage = v as DeployState["stage"];
        return this.ask(run, usersCard(s.users || (s.stage === "production" ? 1000 : 100)));
      case "users":
        s.users = Math.max(1, Math.round(Number(v)));
        return this.ask(run, appNameCard(s.appName ?? "app"));
      case "appName":
        return this.onAppName(run, String(v));
      case "database":
        return this.onDatabase(run, String(v));
      case "network": {
        const a = v as { choice: string; name?: string } | string;
        const choice = typeof a === "string" ? a : a.choice;
        s.network = choice === "yes" ? (typeof a === "object" && a.name ? a.name.trim() : null) : null;
        if (choice === "yes" && !s.network) {
          this.k.chat.post(s.chatId, "assistant", "", [
            { type: "limitation", title: "ساخت شبکه‌ی خصوصی از طریق API لیارا ممکن نیست", reason: "API فقط اجازه می‌ده هنگام ساخت برنامه، نام یک شبکه‌ی موجود رو بدیم.", capabilityId: "paas.privateNetwork.create", steps: ["در کنسول لیارا یک شبکه‌ی خصوصی بساز.", "نامش رو در همین کارت وارد کن."], link: { label: "کنسول لیارا", href: "https://console.liara.ir" } },
          ]);
          return this.ask(run, networkCard(s.database?.mode !== "none"));
        }
        return this.askEnv(run);
      }
      case "env":
        return this.onEnv(run, v as Record<string, string>);
      case "plan":
        s.planId = String(v);
        return this.runGate(run);
      case "patch":
        return this.onPatchDecision(run, String(v));
      case "acceptIssues":
        if (v === "accept") {
          s.acceptedKnownIssues = true;
          this.ctx.audit.record({ actor: "user", kind: "gate.override", resource: s.appName, status: "accepted", chatId: s.chatId, runId: run.id, evidence: `known failures: ${s.failingTests.join(", ")}` });
          return this.prepareInvoice(run);
        }
        this.k.chat.post(s.chatId, "assistant", "باشه؛ دپلوی متوقف شد. وقتی مشکل‌ها رو درست کردی، دوباره بگو تا از اول بررسی کنم.");
        return this.finish(run, "cancelled");
      case "invoice":
      case "redeployApproval":
        return this.onApprovals(run, step);
      case "fixEnv":
        return this.onFixEnv(run, v as Record<string, string>);
      case "patrol":
        return this.onPatrol(run, String(v));
      default:
        throw new AgentError("CONFLICT", `unexpected step ${step}`);
    }
  }

  // ---- source & analysis ----------------------------------------------------
  private async onSource(run: Run<DeployState>, v: { kind: string; url?: string; uploadId?: string }): Promise<void> {
    const s = run.state;
    if (v.kind === "image") {
      this.k.chat.post(s.chatId, "assistant", "", [{ type: "limitation", title: "دپلوی Docker Image آماده از طریق API لیارا ممکن نیست", reason: "API انتشار فقط سورس فشرده (.tar.gz) قبول می‌کنه و فیلدی برای ایمیج نداره.", capabilityId: "paas.deployImage", steps: ["از Liara CLI استفاده کن: liara deploy --image <image>", "یا سورس پروژه رو با Git/ZIP بده تا ایجنت دپلوی کنه."], link: null }]);
      return this.ask(run, sourceCard(this.ctx.cfg.mode === "demo"));
    }
    this.k.chat.phase(s.chatId, "fetching_project", run.id);
    let ws;
    if (v.kind === "git") {
      if (this.ctx.cfg.mode === "demo") {
        this.k.chat.post(s.chatId, "assistant", "در حالت دمو به اینترنت وصل نمی‌شم؛ به‌جای مخزن، پروژه‌ی نمونه‌ی فروشگاه رو بررسی می‌کنم.");
        ws = this.ctx.workspaces.fromDirectory(join(REPO_ROOT, "samples", "shop-next"), "samples/shop-next", s.chatId);
        s.demoSample = true;
      } else {
        ws = await this.ctx.workspaces.fromGit(String(v.url ?? ""), s.chatId);
      }
    } else if (v.kind === "zip") {
      const up = uploads.get(String(v.uploadId));
      if (!up) throw new AgentError("VALIDATION", "فایل آپلودشده پیدا نشد؛ دوباره آپلود کن.");
      ws = this.ctx.workspaces.fromZip(up.data, up.name, s.chatId);
      uploads.delete(String(v.uploadId));
    } else {
      ws = this.ctx.workspaces.fromDirectory(join(REPO_ROOT, "samples", "shop-next"), "samples/shop-next", s.chatId);
      s.demoSample = true;
    }
    s.workspaceId = ws.id;
    s.source = { kind: v.kind === "git" && !s.demoSample ? "git" : v.kind === "zip" ? "zip" : "sample", origin: ws.origin };
    this.k.chat.phase(s.chatId, "analyzing_project", run.id);
    const profile = analyzeProject(ws.deployPath);
    const { root: _r, ...rest } = profile;
    s.profile = rest;
    s.port = Number(profile.port.value) || 3000;
    s.appName = suggestAppName(ws.origin.replace(/\.git$/, ""), readPackageName(ws.deployPath));
    this.k.chat.post(s.chatId, "assistant", "پروژه‌ات رو بررسی کردم. این چیزها رو پیدا کردم:", [
      {
        type: "table",
        title: "تحلیل پروژه",
        columns: ["مورد", "یافته", "شاهد"],
        ltrColumns: [2],
        rows: [
          ["فریم‌ورک", profile.frameworks.map((f) => f.value).join("، ") || "نامشخص", profile.frameworks[0]?.evidence ?? "—"],
          ["پلتفرم لیارا", PLATFORM_LABEL_FA[profile.liaraPlatform.value] ?? profile.liaraPlatform.value, profile.liaraPlatform.evidence],
          ["مدیریت بسته", profile.packageManager?.value ?? "—", profile.packageManager?.evidence ?? "—"],
          ["پورت", profile.port.value, profile.port.evidence],
          ["دیتابیس", profile.database?.value ?? "—", profile.database?.evidence ?? "—"],
          ["متغیرهای محیطی", faNum(profile.envVars.length), profile.envVars.map((e) => e.key).slice(0, 6).join(", ") || "—"],
          ["build / test / start", [profile.commands.build, profile.commands.test, profile.commands.start].map((c) => (c ? "✓" : "—")).join(" / "), [profile.commands.build?.value, profile.commands.test?.value, profile.commands.start?.value].filter(Boolean).join(" · ") || "—"],
        ],
      },
      ...(profile.unknowns.length || profile.port.hardcoded
        ? [{ type: "report" as const, title: "نکته‌های نامطمئن", sections: [{ heading: "باید تأیید بشه", items: [...profile.unknowns, ...(profile.port.hardcoded ? [`پورت در کد ثابت نوشته شده (${profile.port.evidence})؛ لیارا پورت رو از تنظیمات انتشار می‌خونه.`] : [])] }] }]
        : []),
    ]);
    this.ask(run, platformCard(profile));
  }

  private async onAppName(run: Run<DeployState>, raw: string): Promise<void> {
    const s = run.state;
    const name = raw.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(name)) {
      this.k.chat.post(s.chatId, "assistant", "شناسه باید ۴ تا ۳۲ کاراکتر و فقط حروف انگلیسی کوچک، عدد و خط تیره باشه.");
      return this.ask(run, appNameCard(s.appName ?? "app"));
    }
    s.appName = name;
    this.k.chat.setProject(s.chatId, name);
    this.k.chat.phase(s.chatId, "calling_liara", run.id);
    const existing = await this.ctx.liara.getApp(name);
    if (existing) {
      s.existingApp = true;
      s.planId = existing.planId;
      this.k.chat.post(s.chatId, "assistant", `برنامه‌ی «${name}» از قبل در حسابت وجود داره (${existing.platform ?? "?"} · پلن ${existing.planId ?? "?"}). کد جدید رو روی همین برنامه منتشر می‌کنم و چیز جدیدی نمی‌سازم.`);
      return this.askEnv(run);
    }
    this.k.chat.post(s.chatId, "assistant", `«${name}» در حساب تو آزاده. (آزاد بودن نام در کل لیارا فقط هنگام ساخت مشخص می‌شه؛ اگه گرفته شده باشه همون موقع خبر می‌دم.)`);
    if (s.profile?.database) {
      const [dbs, plans] = await Promise.all([this.ctx.liara.databases().catch(() => []), this.k.plans.get().catch(() => null)]);
      return this.ask(run, databaseCard(s.profile.database.value, s.profile.database.evidence, dbs, plans?.dbVersions[s.profile.database.value] ?? []));
    }
    s.database = { mode: "none", type: null, planId: null, version: null, hostname: null, id: null };
    return this.ask(run, networkCard(false));
  }

  private async onDatabase(run: Run<DeployState>, v: string): Promise<void> {
    const s = run.state;
    const kind = s.profile?.database?.value ?? "postgres";
    if (v === "new") {
      const plans = await this.k.plans.get().catch(() => null);
      // Only plans the API marks available and that support this engine (live plans carry `supports`).
      const usable = (plans?.databases ?? []).filter((p) => p.available && !p.details.some((d) => d.label === "supports" && !d.value.includes(kind)));
      const dbPlan = usable[s.stage === "production" ? 1 : 0] ?? usable[0] ?? null;
      s.database = { mode: "new", type: kind, planId: dbPlan?.planId ?? null, version: plans?.dbVersions[kind]?.[0] ?? null, hostname: `${s.appName}-db`.slice(0, 30), id: null };
      if (!dbPlan) this.k.chat.post(s.chatId, "assistant", "فهرست پلن‌های دیتابیس از API دریافت نشد؛ ساخت دیتابیس بدون پلن ممکن نیست و این مرحله رد می‌شه.");
    } else if (v.startsWith("existing:")) {
      const [, id, hostname] = v.split(":");
      s.database = { mode: "existing", type: kind, planId: null, version: null, hostname: hostname ?? null, id: id ?? null };
    } else {
      s.database = { mode: "none", type: null, planId: null, version: null, hostname: null, id: null };
    }
    return this.ask(run, networkCard(s.database.mode !== "none"));
  }

  private askEnv(run: Run<DeployState>): void {
    const s = run.state;
    const auto = new Set(s.database?.mode === "new" ? ["DATABASE_URL"] : []);
    const keys = (s.profile?.envVars ?? []).filter((e) => !auto.has(e.key));
    if (keys.length === 0) return void this.afterEnv(run);
    this.ask(run, envCard(keys.map((e) => ({ key: e.key, required: e.required, hint: `از ${e.source}` }))));
  }

  private async onEnv(run: Run<DeployState>, values: Record<string, string>): Promise<void> {
    const s = run.state;
    for (const [k, val] of Object.entries(values ?? {})) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k) || typeof val !== "string" || val === "") continue;
      this.k.secrets.set(run.id, k, val);
      if (!s.envKeys.includes(k)) s.envKeys.push(k);
    }
    const missing = (s.profile?.envVars ?? []).filter((e) => e.required && !s.envKeys.includes(e.key) && !(e.key === "DATABASE_URL" && s.database?.mode === "new"));
    if (missing.length) this.k.chat.post(s.chatId, "assistant", `این متغیرهای ضروری خالی موندن: ${missing.map((m) => m.key).join("، ")}. اگه برنامه بدون اون‌ها اجرا نشه، بعد از build پیداش می‌کنم و دوباره ازت می‌پرسم.`);
    return this.afterEnv(run);
  }

  private async afterEnv(run: Run<DeployState>): Promise<void> {
    const s = run.state;
    if (s.existingApp) return this.runGate(run);
    this.k.chat.phase(s.chatId, "planning", run.id);
    let plans: PlanOption[] = [];
    try {
      plans = (await this.k.plans.get()).projects.filter((p) => p.available);
    } catch (e) {
      this.k.chat.post(s.chatId, "assistant", "", [{ type: "limitation", title: "فهرست پلن‌ها دریافت نشد", reason: toAgentError(e).message, capabilityId: "paas.planPrices", steps: ["شناسه‌ی پلن رو از کنسول لیارا (بخش ساخت برنامه) پیدا کن و در چت بنویس."], link: null }]);
    }
    const need = estimateRamGb(s.platform ?? "node", s.users || 100);
    const rec = plans.find((p) => (p.ramGb ?? 0) >= need) ?? plans.at(-1);
    const shown = plans.slice(Math.max(0, plans.indexOf(rec!) - 1), Math.max(0, plans.indexOf(rec!) - 1) + 3);
    const cards = (shown.length ? shown : plans.slice(0, 3)).map((p) => ({ ...p, recommended: p.planId === rec?.planId, capacityHint: capacityHint(s.platform ?? "node", p.ramGb) }));
    if (!cards.length) throw new AgentError("UNSUPPORTED_OPERATION", "no plan catalogue available from the API");
    this.ask(run, planCard(cards, s.users || 100, `برای ${faNum(s.users || 100)} کاربر همزمان حدود ${faNum(Math.round(need * 10) / 10)} گیگ RAM تخمین زدم (تخمین تقریبی بر پایه‌ی نوع برنامه، نه اندازه‌گیری). قیمت‌ها از API لیارا (GET /v1/me) خونده شدن.`));
  }

  // ---- quality gate & fix loop ---------------------------------------------
  private timeline(run: Run<DeployState>, title: string, steps: StepView[], logs: { level: "info" | "warn" | "error" | "cmd" | "ok"; text: string }[], subtitle?: string): void {
    const s = run.state;
    const block: Block = { type: "timeline", title, subtitle, risk: "L2", steps, logs: logs.slice(-40) };
    const m = s.timelineMsgId ? this.k.chat.message(s.timelineMsgId) : null;
    if (m) this.k.chat.update(m, { blocks: [block] });
    else s.timelineMsgId = this.k.chat.post(s.chatId, "assistant", "", [block]).id;
  }

  private async runGate(run: Run<DeployState>): Promise<void> {
    const s = run.state;
    const ws = this.ctx.workspaces.get(s.workspaceId!);
    if (!ws) throw new AgentError("NOT_FOUND", "workspace missing");
    this.k.chat.phase(s.chatId, "running_tests", run.id);
    run.step = "gate";
    this.k.runs.save(run);
    const profile = analyzeProject(ws.deployPath);
    const scratch = this.ctx.workspaces.scratchCopy(ws, "gate");
    const steps: StepView[] = [];
    s.timelineMsgId = null;
    const gate = await this.ctx.gate.run(
      scratch,
      profile,
      (st) => {
        const i = steps.findIndex((x) => x.key === st.key);
        const view: StepView = { key: st.key, label: st.label, status: st.status, detail: st.detail ?? (st.command ?? null), startedAt: st.startedAt, finishedAt: st.finishedAt, command: st.command };
        if (i >= 0) steps[i] = view;
        else steps.push(view);
        this.timeline(run, "آزمایش قبل از دپلوی", steps, st.output ? st.output.split("\n").slice(-8).map((t) => ({ level: /error|ERR|×|fail/i.test(t) ? "error" : "info", text: t })) : [], `فقط روی نسخه‌ی آزمایشی · ${this.ctx.sandbox.label}`);
      },
      { previousFailingTests: s.failingTests },
    );
    s.gateOverall = gate.report.overall;
    if (!s.failingTests.length) s.failingTests = gate.stages.find((x) => x.key === "test")?.failingTests ?? [];
    this.k.chat.post(s.chatId, "assistant", "", [{ type: "gate", report: gate.report }]);
    if (gate.report.overall !== "FAIL") {
      if (gate.report.overall === "WARN") this.k.chat.post(s.chatId, "assistant", `آزمایش با هشدار تموم شد${gate.report.coverageNotes.length ? `: ${gate.report.coverageNotes.join(" ")}` : "."} ادامه می‌دم.`);
      return this.prepareInvoice(run);
    }
    // FAIL → RCA → fix loop
    const failure = gate.failures[0]!;
    const preexisting = gate.report.preexistingFailures;
    const onlyPreexisting = failure.key === "test" && failure.failingTests.length > 0 && failure.failingTests.every((t) => preexisting.includes(t));
    if (onlyPreexisting || s.repairAttempts >= this.ctx.cfg.maxRepairAttempts) return this.askAcceptIssues(run, failure.failingTests, onlyPreexisting);
    this.k.chat.phase(s.chatId, "finding_root_cause", run.id);
    s.repairAttempts += 1;
    s.attempts.push({ n: s.repairAttempts, label: "تحلیل و پیشنهاد اصلاح", status: "running" });
    // Focus the analysis on the failures that are not pre-existing.
    const blocks = failureBlocks(failure.output);
    const targets = failure.failingTests.filter((t) => !preexisting.includes(t));
    const focused = targets.length ? `${targets.map((t) => `× ${t}${blocks.get(t) ?? ""}`).join("\n")}\n${failure.output.slice(-1500)}` : failure.output;
    const rca = await rootCause(
      { failureText: focused, failingCommand: failure.command ?? null, workspaceDir: ws.deployPath, context: [`stage=${failure.key}`, ...failure.failingTests.map((t) => `failing test: ${t}`)], attempts: s.attempts, maxAttempts: this.ctx.cfg.maxRepairAttempts, runId: run.id, chatId: s.chatId, escalate: s.repairAttempts > 2 },
      { llm: this.ctx.llm, kb: this.ctx.kb },
    );
    this.k.chat.post(s.chatId, "assistant", "", [{ type: "root_cause", report: rca.report }]);
    if (rca.report.category === "CONFIG_ENV") {
      const key = /([A-Z][A-Z0-9_]{2,})/.exec(rca.report.cause)?.[1];
      if (key) {
        this.k.chat.post(s.chatId, "assistant", `این خطا با کد درست نمی‌شه؛ متغیر ${key} باید تنظیم بشه. موقع دپلوی برای لیارا تنظیمش می‌کنیم.`);
        if (!s.envKeys.includes(key) && !(key === "DATABASE_URL" && s.database?.mode === "new")) return this.ask(run, envCard([{ key, required: true, hint: "build بدون این متغیر شکست خورد" }]));
      }
      return this.askAcceptIssues(run, failure.failingTests, false);
    }
    this.k.chat.phase(s.chatId, "building_patch", run.id);
    const proposal = await this.ctx.coder.propose(ws.deployPath, rca.report, { failureText: failure.output, previousPatches: s.patchesTried, runId: run.id, chatId: s.chatId, escalate: s.repairAttempts > 2 }).catch(() => null);
    if (!proposal) {
      s.attempts[s.attempts.length - 1]!.status = "failed";
      this.k.chat.post(s.chatId, "assistant", "برای این خطا اصلاح مطمئنی پیدا نکردم و تغییر حدسی پیشنهاد نمی‌دم.");
      return this.askAcceptIssues(run, failure.failingTests, false);
    }
    s.patchesTried.push(JSON.stringify(proposal.edits));
    // Trial: apply on a scratch copy and rerun only the failing stage.
    const trial = this.ctx.workspaces.scratchCopy(ws, "patch");
    let files: { path: string; diff: string }[];
    try {
      files = this.ctx.coder.apply(trial, proposal);
    } catch (e) {
      s.attempts[s.attempts.length - 1]!.status = "failed";
      this.k.chat.post(s.chatId, "assistant", `پیشنهاد اصلاح رد شد: ${toAgentError(e).message}`);
      if (s.repairAttempts < this.ctx.cfg.maxRepairAttempts) return this.runGate(run);
      return this.askAcceptIssues(run, failure.failingTests, false);
    }
    const retest = await this.ctx.gate.run(trial, analyzeProject(trial), () => undefined, { previousFailingTests: s.failingTests });
    const tStage = retest.stages.find((x) => x.key === "test");
    const fixedTarget = !failure.failingTests.length || !failure.failingTests.some((t) => tStage?.failingTests.includes(t) && !preexisting.includes(t));
    const stillFailing = (tStage?.failingTests ?? []).filter((t) => !failure.failingTests.includes(t) || preexisting.includes(t));
    const passed = tStage?.output.match(/(\d+) passed/)?.[1];
    const total = tStage?.output.match(/(\d+) total/)?.[1];
    if (!fixedTarget || retest.stages.some((x) => x.key === "build" && x.status === "FAIL")) {
      s.attempts[s.attempts.length - 1] = { n: s.repairAttempts, label: proposal.explanation.slice(0, 60), status: "failed" };
      this.ctx.kb.record(rca.classified.signature, { category: rca.report.category, cause: rca.report.cause, fix: proposal.explanation, ok: false });
      this.k.chat.post(s.chatId, "assistant", `تلاش ${faNum(s.repairAttempts)} از ${faNum(this.ctx.cfg.maxRepairAttempts)}: این اصلاح مشکل رو حل نکرد. ${s.repairAttempts < this.ctx.cfg.maxRepairAttempts ? "یه راه متفاوت امتحان می‌کنم." : ""}`);
      if (s.repairAttempts < this.ctx.cfg.maxRepairAttempts) return this.runGate(run);
      return this.askAcceptIssues(run, failure.failingTests, false);
    }
    s.attempts[s.attempts.length - 1] = { n: s.repairAttempts, label: proposal.explanation.slice(0, 60), status: "succeeded" };
    const patchId = `patch_${sha256(JSON.stringify(proposal.edits)).slice(0, 12)}`;
    this.ctx.db.run("INSERT OR REPLACE INTO patches(id, chat_id, workspace_id, files_json, summary, status, signature, attempt, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", patchId, s.chatId, ws.id, JSON.stringify({ edits: proposal.edits, files }), proposal.explanation, "proposed", rca.classified.signature, s.repairAttempts, iso(), iso());
    s.pendingPatchId = patchId;
    s.failingTests = stillFailing;
    this.k.chat.post(s.chatId, "assistant", proposal.explanation, [
      { type: "patch", patchId, files, testsPassed: passed && total ? `${faNum(Number(passed))} از ${faNum(Number(total))}` : null, summary: `${proposal.source === "rule" ? "اصلاح قاعده‌محور" : `پیشنهاد مدل ${proposal.model}`} · تست‌ها روی نسخه‌ی آزمایشی دوباره اجرا شدن.`, status: "proposed" },
    ]);
    this.ask(run, confirmCard("patch", "تأیید تغییر پیشنهادی", "تغییرات فقط روی نسخه‌ی دیپلوی‌شده اعمال می‌شه. مطمئن باش: مخزن اصلیت دست نمی‌خوره.", [
      { value: "apply", label: "اعمال فقط روی نسخه‌ی دیپلوی‌شده", recommended: true },
      { value: "download", label: "دانلود فایل پچ" },
      { value: "reject", label: "رد کردن" },
    ]));
  }

  private async onPatchDecision(run: Run<DeployState>, v: string): Promise<void> {
    const s = run.state;
    const row = this.ctx.db.get<{ files_json: string; signature: string; summary: string }>("SELECT * FROM patches WHERE id = ?", s.pendingPatchId ?? "");
    if (!row) throw new AgentError("NOT_FOUND", "patch not found");
    const data = JSON.parse(row.files_json) as { edits: { path: string; search: string; replace: string }[] };
    const setStatus = (status: "applied" | "rejected" | "exported") => {
      this.ctx.db.run("UPDATE patches SET status = ?, updated_at = ? WHERE id = ?", status, iso(), s.pendingPatchId!);
      for (const m of this.k.chat.messages(s.chatId)) if (m.blocks.some((b) => b.type === "patch" && b.patchId === s.pendingPatchId)) this.k.chat.patchBlock(m.id, (b) => b.type === "patch" && b.patchId === s.pendingPatchId, (b) => ({ ...(b as Extract<Block, { type: "patch" }>), status }));
    };
    this.ctx.audit.record({ actor: "user", kind: "patch.decision", resource: s.pendingPatchId, status: v, chatId: s.chatId, runId: run.id });
    if (v === "apply") {
      const ws = this.ctx.workspaces.get(s.workspaceId!)!;
      const before = this.ctx.workspaces.treeHash(ws.originalPath);
      this.ctx.coder.apply(ws.deployPath, { edits: data.edits, explanation: row.summary, source: "rule", model: null });
      if (this.ctx.workspaces.treeHash(ws.originalPath) !== before) throw new AgentError("UNSAFE_OPERATION", "original repository changed — aborting");
      setStatus("applied");
      this.ctx.kb.record(row.signature, { category: "CODE_DEFECT", fix: row.summary, ok: true });
      this.k.chat.post(s.chatId, "assistant", "تغییر روی نسخه‌ی دیپلوی اعمال شد. آزمایش‌ها رو دوباره کامل اجرا می‌کنم.");
      s.pendingPatchId = null;
      return this.runGate(run);
    }
    if (v === "download") {
      setStatus("exported");
      this.k.chat.post(s.chatId, "assistant", "فایل پچ آماده‌ست؛ از دکمه‌ی دانلود روی کارت تغییرات بگیرش. تا تصمیم نگرفتی دپلوی انجام نمی‌شه.");
      return this.ask(run, confirmCard("patch", "بعد از دانلود چی کار کنیم؟", "می‌تونی پچ رو خودت اعمال کنی یا همین‌جا روی نسخه‌ی دیپلوی اعمالش کنیم.", [
        { value: "apply", label: "اعمال روی نسخه‌ی دیپلوی", recommended: true },
        { value: "reject", label: "بدون این تغییر ادامه بده" },
      ]));
    }
    setStatus("rejected");
    return this.askAcceptIssues(run, s.failingTests, false);
  }

  private askAcceptIssues(run: Run<DeployState>, failing: string[], preexisting: boolean): void {
    const s = run.state;
    this.k.chat.post(s.chatId, "assistant", "", [
      {
        type: "report",
        title: "دپلوی با مشکل‌های شناخته‌شده",
        sections: [
          { heading: "این موارد هنوز درست نشدن", items: failing.length ? failing.map((t) => `تست «${t}»${preexisting ? " از قبل خراب بود" : ""}`) : [s.lastFailure ?? "آزمایش قبل از دپلوی رد شد"] },
          { heading: "ریسک", items: ["این بخش‌ها ممکنه روی سایت زنده درست کار نکنن."] },
        ],
      },
    ]);
    this.ask(run, confirmCard("acceptIssues", "این مشکل‌ها هنوز هستن؛ ادامه بدیم؟", "ادامه دادن در لاگ فعالیت ثبت می‌شه.", [
      { value: "accept", label: "ریسکش رو می‌فهمم و ادامه می‌دم" },
      { value: "stop", label: "برگرد و درست کن", recommended: true },
    ]));
  }

  // ---- invoice & approvals ------------------------------------------------
  private async prepareInvoice(run: Run<DeployState>): Promise<void> {
    const s = run.state;
    this.k.chat.phase(s.chatId, "planning", run.id);
    const ws = this.ctx.workspaces.get(s.workspaceId!)!;
    // Package now so the deploy approval binds to the exact archive digest.
    const pkg = await this.ctx.workspaces.packageForLiara(ws);
    s.packageDigest = sha256(Buffer.from(pkg.data).toString("base64"));
    writeFileSync(join(ws.deployPath, "..", `package-${s.packageDigest}.tar.gz`), pkg.data);
    const ctxT = { actor: "agent" as const, chatId: s.chatId, runId: run.id, projectName: s.appName };
    const plans = await this.k.plans.get().catch(() => null);
    const plan = plans?.projects.find((p) => p.planId === s.planId) ?? null;
    const dbPlan = s.database?.mode === "new" ? (plans?.databases.find((p) => p.planId === s.database!.planId) ?? null) : null;
    const lines: Invoice["lines"] = [];
    const ids: string[] = [];
    const unavailable: Money = { status: "unavailable", hourlyToman: null, monthlyToman: null, source: null, note: T.priceUnavailable };

    if (!s.existingApp) {
      const createApp = await this.ctx.gateway.run(
        {
          capabilityId: "paas.createApp",
          req: { body: { name: s.appName, planID: s.planId, platform: s.platform, readOnlyRootFilesystem: true, ...(s.network ? { network: s.network } : {}) } },
          resource: s.appName!,
          title: `ساخت برنامه‌ی ${s.appName}`,
          reason: `پروژه‌ی ${PLATFORM_LABEL_FA[s.platform ?? ""] ?? s.platform} روی لیارا`,
          effect: "یک برنامه‌ی جدید با هزینه‌ی ساعتی ساخته می‌شه.",
          cost: plan?.price ?? unavailable,
          reversible: "با حذف برنامه هزینه قطع می‌شه",
          proposedValue: `plan: ${s.planId}`,
        },
        ctxT,
      );
      if (createApp.status === "approval_required") ids.push((s.approvals.createApp = createApp.approval.id));
      lines.push({ label: `سرور ${plan?.title ?? s.planId}`, detail: plan ? `${plan.cpu ?? "?"} هسته · ${plan.ramGb ?? "?"} گیگ RAM · ${plan.diskGb ?? "?"} گیگ` : null, price: plan?.price ?? unavailable });
    }
    if (s.database?.mode === "new" && s.database.planId) {
      const createDb = await this.ctx.gateway.run(
        {
          capabilityId: "dbaas.createDatabase",
          req: { body: { hostname: s.database.hostname, type: s.database.type, planID: s.database.planId, ...(s.database.version ? { version: s.database.version } : {}), publicNetwork: false } },
          resource: s.database.hostname!,
          title: `ساخت دیتابیس ${s.database.type} (${s.database.hostname})`,
          reason: s.profile?.database?.evidence ?? "پروژه دیتابیس لازم داره",
          effect: "یک دیتابیس جدید با هزینه‌ی ساعتی ساخته می‌شه (دسترسی عمومی خاموش).",
          cost: dbPlan?.price ?? unavailable,
          reversible: "حذف دیتابیس غیرقابل‌برگشته و جداگانه تأیید می‌خواد",
        },
        ctxT,
      );
      if (createDb.status === "approval_required") ids.push((s.approvals.createDatabase = createDb.approval.id));
      lines.push({ label: `دیتابیس ${s.database.type}`, detail: dbPlan ? `${dbPlan.planId} · ${dbPlan.ramGb ?? "?"} گیگ RAM` : null, price: dbPlan?.price ?? unavailable });
    }
    const envVars = [...new Set([...s.envKeys, ...(s.database && s.database.mode !== "none" ? ["DATABASE_URL"] : [])])];
    if (envVars.length) {
      const upd = await this.ctx.gateway.run(
        {
          capabilityId: "paas.updateEnvs",
          req: { body: { project: s.appName, variables: envVars.map((k) => ({ key: k, value: `{{secret:${k}}}` })) } },
          resource: s.appName!,
          title: `تنظیم ${faNum(envVars.length)} متغیر محیطی`,
          reason: "برنامه این متغیرها رو لازم داره",
          effect: "متغیرها تنظیم می‌شن و لیارا برنامه رو برای اعمالشون ری‌استارت می‌کنه.",
          proposedValue: envVars.join(", "),
          downtime: "چند ثانیه ری‌استارت",
        },
        ctxT,
      );
      if (upd.status === "approval_required") ids.push((s.approvals.updateEnvs = upd.approval.id));
    }
    const rel = await this.ctx.gateway.run(
      {
        capabilityId: "paas.releasesDeploy",
        req: { pathParams: { name: s.appName! }, body: { sourceID: `{{source:${s.packageDigest}}}`, port: s.port, type: s.platform } },
        resource: s.appName!,
        title: `انتشار نسخه‌ی جدید ${s.appName}`,
        reason: `سورس با شناسه‌ی ${s.packageDigest.slice(0, 12)} (${faNum(pkg.files)} فایل، بدون فایل‌های .env)`,
        effect: s.existingApp ? "نسخه‌ی فعلی با نسخه‌ی جدید جایگزین می‌شه." : "اولین نسخه‌ی برنامه منتشر می‌شه.",
        downtime: s.existingApp ? "بسته به تنظیم دپلوی بدون اختلال، ممکنه چند ثانیه قطعی داشته باشه" : null,
        reversible: "نسخه‌ی قبلی (اگه باشه) قابل انتشار مجدده",
        diff: `port: ${s.port}\nplatform: ${s.platform}`,
      },
      ctxT,
    );
    if (rel.status === "approval_required") ids.push((s.approvals.release = rel.approval.id));
    else if (rel.status === "denied") throw new AgentError("UNSUPPORTED_OPERATION", rel.reason);

    const bal = await this.ctx.liara.balance().catch(() => ({ balance: null, minCredit: null }));
    const hourly = lines.map((l) => hourlyOf(l.price)).reduce<number | null>((a, b) => (a === null || b === null ? null : a + b), 0);
    const total: Money = hourly === null ? unavailable : { status: "from_api", hourlyToman: hourly, monthlyToman: hourly * 730, source: "GET /v1/me → plans", note: lines.some((l) => l.price.hourlyToman === null) ? "ساعتی از قیمت ماهانه (÷۷۳۰) محاسبه شده." : null };
    const invoice: Invoice = {
      summary: [
        { label: "پلن", value: plan?.title ?? s.planId ?? (s.existingApp ? "بدون تغییر" : "—") },
        { label: "منابع", value: plan ? `${plan.cpu ?? "?"} هسته · ${plan.ramGb ?? "?"} گیگ · ${plan.diskGb ?? "?"} گیگ SSD` : "—" },
        { label: "نوع برنامه", value: PLATFORM_LABEL_FA[s.platform ?? ""] ?? s.platform ?? "—" },
        { label: "مرحله", value: STAGE_FA[s.stage ?? ""] ?? "—" },
        { label: "شبکه خصوصی", value: s.network ?? "ندارد" },
        { label: "ظرفیت", value: `${faNum(s.users || 0)} کاربر همزمان` },
      ],
      lines,
      total,
      balanceToman: bal.balance,
      balanceSource: bal.balance === null ? null : "GET /v1/billing",
      notes: [
        "پرداخت از کیف پول لیارا انجام می‌شه. هر وقت سرویس رو متوقف کنی، هزینه قطع می‌شه.",
        ...(bal.balance !== null && hourly ? [`با این موجودی حدود ${faNum(Math.floor(bal.balance / (hourly * 24)))} روز کافیه (فقط برای منابع همین فاکتور).`] : []),
        "کد تخفیف و افزایش موجودی از طریق API لیارا ممکن نیست؛ از کنسول انجام بشه.",
        T.approvalMeaning,
      ],
    };
    if (bal.balance !== null && hourly !== null && bal.balance < hourly * 24 * 7) {
      this.k.chat.post(s.chatId, "assistant", "", [{ type: "limitation", title: "موجودی کیف پول کافی نیست", reason: `برای ۷ روز اول حدود ${faNum(Math.round(hourly * 24 * 7))} تومان لازمه و موجودی فعلی ${faNum(bal.balance)} تومانه. افزایش موجودی از طریق API لیارا ممکن نیست.`, capabilityId: "billing.topUp", steps: ["روی «افزایش موجودی در لیارا» بزن", "مبلغ رو شارژ کن و برگرد اینجا", "فاکتور رو تأیید کن تا دوباره چک کنم"], link: { label: "افزایش موجودی در لیارا ↗", href: "https://console.liara.ir/billing" } }]);
    }
    s.deployAttempts += 1;
    this.ask(run, invoiceCard(invoice, ids));
  }

  /** Called after the user approved the invoice/redeploy approvals in the UI. */
  private async onApprovals(run: Run<DeployState>, step: Step): Promise<void> {
    const s = run.state;
    const pending = Object.values(s.approvals).filter((id): id is string => !!id).map((id) => this.ctx.approvals.get(id)!);
    const notApproved = pending.filter((a) => a.status !== "approved" && a.status !== "executed");
    if (notApproved.length) {
      const expired = notApproved.some((a) => a.status === "expired" || a.status === "invalidated");
      if (expired) {
        this.k.chat.post(s.chatId, "assistant", "مهلت تأیید تموم شد یا عملیات تغییر کرد؛ فاکتور رو دوباره می‌سازم.");
        s.approvals = {};
        return this.prepareInvoice(run);
      }
      if (notApproved.some((a) => a.status === "rejected")) {
        this.k.chat.post(s.chatId, "assistant", "تأیید نشد؛ هیچ تغییری در لیارا انجام نشد. اگه خواستی انتخاب‌ها رو عوض کنیم بگو.");
        return this.finish(run, "cancelled");
      }
      run.step = step;
      run.status = "waiting_approval";
      this.k.runs.save(run);
      this.k.chat.phase(s.chatId, "waiting_approval", run.id);
      return this.k.chat.done(s.chatId, "waiting_for_approval", run.id);
    }
    return this.execute(run);
  }

  private resolver(run: Run<DeployState>) {
    return async (req: LiaraRequest): Promise<LiaraRequest> => {
      let r = this.k.secrets.resolve(run.id, req);
      const json = JSON.stringify(r.body ?? null);
      const m = /\{\{source:([0-9a-f]{64})\}\}/.exec(json);
      if (m) {
        const sourceID = await this.uploadSource(run, m[1]!);
        r = { ...r, body: JSON.parse(json.replace(m[0], sourceID)) };
      }
      return r;
    };
  }

  private async uploadSource(run: Run<DeployState>, digest: string): Promise<string> {
    const s = run.state;
    const ws = this.ctx.workspaces.get(s.workspaceId!)!;
    const p = join(ws.deployPath, "..", `package-${digest}.tar.gz`);
    if (!existsSync(p)) throw new AgentError("VALIDATION", "approved source archive is missing");
    const data = new Uint8Array(readFileSync(p));
    if (sha256(Buffer.from(data).toString("base64")) !== digest) throw new AgentError("UNSAFE_OPERATION", "source archive changed after approval");
    const res = await this.ctx.gateway.run<{ sourceID?: string }>(
      { capabilityId: "paas.sourcesDeploy", req: { pathParams: { name: s.appName! }, file: { field: "file", name: "source.tar.gz", data, contentType: "application/gzip" } }, resource: s.appName!, title: "آپلود سورس", reason: "انتشار تأییدشده", effect: "سورس روی لیارا آپلود می‌شه" },
      { actor: "user", chatId: s.chatId, runId: run.id },
    );
    if (res.status !== "executed" || !res.data?.sourceID) throw new AgentError("DEPLOYMENT", "source upload did not return a sourceID");
    return res.data.sourceID;
  }

  private async execute(run: Run<DeployState>): Promise<void> {
    const s = run.state;
    run.step = "execute";
    this.k.runs.save(run);
    this.k.chat.phase(s.chatId, "deploying", run.id);
    const tctx = { actor: "user" as const, chatId: s.chatId, runId: run.id, projectName: s.appName };
    const steps: StepView[] = [
      { key: "createApp", label: "ساخت برنامه", status: s.approvals.createApp ? "PENDING" : "SKIPPED", detail: null, startedAt: null, finishedAt: null },
      { key: "createDatabase", label: "ساخت دیتابیس", status: s.approvals.createDatabase ? "PENDING" : "SKIPPED", detail: null, startedAt: null, finishedAt: null },
      { key: "env", label: "تنظیم متغیرها", status: s.approvals.updateEnvs ? "PENDING" : "SKIPPED", detail: null, startedAt: null, finishedAt: null },
      { key: "upload", label: "آپلود", status: "PENDING", detail: null, startedAt: null, finishedAt: null },
      { key: "build", label: "build و انتشار", status: "PENDING", detail: null, startedAt: null, finishedAt: null },
      { key: "health", label: "بررسی سلامت", status: "PENDING", detail: null, startedAt: null, finishedAt: null },
    ];
    const logs: { level: "info" | "warn" | "error" | "cmd" | "ok"; text: string }[] = [];
    s.timelineMsgId = null;
    const t0 = Date.now();
    const set = (key: string, status: StepView["status"], detail: string | null = null) => {
      const st = steps.find((x) => x.key === key)!;
      st.status = status;
      st.detail = detail;
      if (status === "RUNNING") st.startedAt = iso();
      else st.finishedAt = iso();
      this.timeline(run, `در حال دپلوی ${s.appName}`, steps, logs, `می‌تونی این صفحه رو ببندی؛ بعد از پایان بهت خبر می‌دم. · ${faDuration(Date.now() - t0)}`);
    };
    set("createApp", steps[0]!.status);

    if (s.existingApp) {
      const rels = await this.ctx.liara.releases(s.appName!, 3).catch(() => null);
      s.previousRelease = rels?.current ?? null;
    }
    if (s.approvals.createApp && this.ctx.approvals.get(s.approvals.createApp)?.status === "approved") {
      set("createApp", "RUNNING");
      await this.ctx.gateway.executeApproved(s.approvals.createApp, tctx);
      set("createApp", "PASS");
    }
    if (s.approvals.createDatabase && this.ctx.approvals.get(s.approvals.createDatabase)?.status === "approved") {
      set("createDatabase", "RUNNING");
      const r = await this.ctx.gateway.executeApproved<{ databaseID?: string }>(s.approvals.createDatabase, tctx);
      s.database!.id = r.data?.databaseID ?? null;
      await this.waitDatabase(run, logs);
      set("createDatabase", "PASS");
    }
    if (s.database && s.database.mode !== "none" && s.database.id) await this.composeDatabaseUrl(run);
    if (s.approvals.updateEnvs && this.ctx.approvals.get(s.approvals.updateEnvs)?.status === "approved") {
      set("env", "RUNNING");
      await this.ctx.gateway.executeApproved(s.approvals.updateEnvs, tctx, { resolve: this.resolver(run) });
      set("env", "PASS", `${faNum(s.envKeys.length + (s.database?.mode !== "none" ? 1 : 0))} متغیر`);
    }
    set("upload", "RUNNING");
    s.deployStartedAt = this.ctx.clock.now().toISOString();
    const res = await this.ctx.gateway.executeApproved<{ releaseID?: string }>(s.approvals.release!, tctx, { resolve: this.resolver(run) });
    set("upload", "PASS");
    s.releaseId = res.data?.releaseID ?? null;
    this.k.runs.save(run);
    set("build", "RUNNING", s.releaseId ? `release ${s.releaseId}` : null);
    const state = await this.pollRelease(run, logs, () => set("build", "RUNNING"));
    if (state !== "READY") {
      set("build", "FAIL", state);
      return this.onDeployFailed(run, logs);
    }
    set("build", "PASS");
    set("health", "RUNNING");
    const ok = await this.verify(run);
    set("health", ok ? "PASS" : "FAIL");
    if (!ok) return;
  }

  private async waitDatabase(run: Run<DeployState>, logs: { level: "info" | "warn" | "error" | "cmd" | "ok"; text: string }[]): Promise<void> {
    const s = run.state;
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const d = await this.ctx.client.readSafe<{ database?: { status?: string } }>("dbaas.getDatabase", { pathParams: { id: s.database!.id! } }).catch(() => null);
      const st = d?.database?.status ?? "?";
      logs.push({ level: "info", text: `database ${s.database!.hostname}: ${st}` });
      if (/RUNNING|READY|ACTIVE/i.test(st)) return;
      if (/FAIL|ERROR/i.test(st)) throw new AgentError("DEPLOYMENT", `database creation failed (${st})`);
      await sleep(this.ctx.cfg.mode === "demo" ? 50 : 5000);
    }
    throw new AgentError("TIMEOUT", "database did not become ready within 5 minutes");
  }

  /** Builds DATABASE_URL server-side from the raw (unredacted) DB record; the value goes straight into the SecretStore. */
  private async composeDatabaseUrl(run: Run<DeployState>): Promise<void> {
    const s = run.state;
    if (s.envKeys.includes("DATABASE_URL")) return;
    const raw = await this.ctx.client.read<{ database?: { hostname?: string; internalPort?: number; port?: number; root_password?: string; username?: string; type?: string; dbName?: string } }>("dbaas.getDatabase", { pathParams: { id: s.database!.id! } });
    const d = raw.database ?? {};
    const scheme = { postgres: "postgresql", mysql: "mysql", mariadb: "mysql", mongodb: "mongodb", redis: "redis" }[d.type ?? s.database!.type ?? "postgres"] ?? "postgresql";
    if (!d.root_password || !d.hostname) {
      this.k.chat.post(s.chatId, "assistant", "اطلاعات اتصال دیتابیس در پاسخ API کامل نبود؛ DATABASE_URL رو باید خودت وارد کنی.");
      return;
    }
    const host = s.network ? d.hostname : (d.hostname ?? "");
    const port = s.network ? (d.internalPort ?? d.port) : (d.port ?? d.internalPort);
    const url = `${scheme}://${encodeURIComponent(d.username ?? "root")}:${encodeURIComponent(d.root_password)}@${host}:${port}/${d.dbName ?? ""}`;
    this.k.secrets.set(run.id, "DATABASE_URL", url);
  }

  private async pollRelease(run: Run<DeployState>, logs: { level: "info" | "warn" | "error" | "cmd" | "ok"; text: string }[], tick: () => void): Promise<string> {
    const s = run.state;
    const deadline = Date.now() + 20 * 60_000;
    const since = Math.floor(Date.parse(s.deployStartedAt ?? iso()) / 1000) - 5;
    const seen = new Set<string>();
    let state = "QUEUED";
    while (Date.now() < deadline) {
      const rels = await this.ctx.liara.releases(s.appName!, 5).catch(() => null);
      const r = rels?.releases.find((x) => x.id === s.releaseId) ?? rels?.releases[0];
      state = r?.state ?? "UNKNOWN";
      const lines = await this.ctx.liara.logs(s.appName!, since).catch(() => []);
      for (const l of lines) {
        const key = `${l.datetime}|${l.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const t of l.message.split("\n").slice(0, 6)) logs.push({ level: t.startsWith("$") ? "cmd" : /error|ERR!|fail/i.test(t) ? "error" : /warn/i.test(t) ? "warn" : "info", text: t });
      }
      logs.push({ level: "info", text: `release ${s.releaseId ?? "?"} → ${state}` });
      tick();
      if (TERMINAL_RELEASE_STATES.has(state)) return state;
      await sleep(this.ctx.cfg.mode === "demo" ? 300 : 5000);
    }
    return "TIMEOUT";
  }

  private async onDeployFailed(run: Run<DeployState>, logs: { level: string; text: string }[]): Promise<void> {
    const s = run.state;
    this.k.chat.phase(s.chatId, "finding_root_cause", run.id);
    const failureText = logs.filter((l) => l.level === "error" || l.level === "cmd").map((l) => l.text).join("\n") || logs.map((l) => l.text).join("\n");
    s.lastFailure = failureText.slice(0, 500);
    s.attempts.push({ n: s.attempts.length + 1, label: "build روی لیارا", status: "failed" });
    const ws = this.ctx.workspaces.get(s.workspaceId!)!;
    const rca = await rootCause({ failureText, failingCommand: "liara build", workspaceDir: ws.deployPath, context: [`release ${s.releaseId}`], attempts: s.attempts, maxAttempts: this.ctx.cfg.maxRepairAttempts, runId: run.id, chatId: s.chatId }, { llm: this.ctx.llm, kb: this.ctx.kb });
    this.k.chat.post(s.chatId, "assistant", "", [{ type: "root_cause", report: rca.report }]);
    if (s.deployAttempts >= this.ctx.cfg.maxRepairAttempts) {
      this.k.chat.post(s.chatId, "assistant", "", [{ type: "report", title: "دپلوی بعد از چند تلاش موفق نشد", sections: [{ heading: "چه کارهایی انجام شد", items: s.attempts.map((a) => `تلاش ${faNum(a.n)}: ${a.label} → ${a.status === "failed" ? "ناموفق" : "موفق"}`) }, { heading: "پیشنهاد", items: [rca.report.proposedFix] }] }]);
      return this.finish(run, "failed");
    }
    const key = rca.report.category === "CONFIG_ENV" ? /([A-Z][A-Z0-9_]{2,})/.exec(rca.report.cause)?.[1] : undefined;
    if (key) {
      if (key === "DATABASE_URL" && s.database?.id) {
        await this.composeDatabaseUrl(run);
        if (!s.envKeys.includes(key)) s.envKeys.push(key);
        return this.proposeRedeploy(run, [key]);
      }
      return this.ask(run, { ...envCard([{ key, required: true, hint: "build بدون این متغیر شکست خورد" }]), key: "fixEnv" });
    }
    if (rca.report.category === "CODE_DEFECT" && rca.report.location) {
      this.k.chat.post(s.chatId, "assistant", "خطا از کده؛ برمی‌گردم سراغ آزمایش و اصلاح روی نسخه‌ی دیپلوی.");
      return this.runGate(run);
    }
    this.k.chat.post(s.chatId, "assistant", `${rca.report.proposedFix} ${s.previousRelease ? "نسخه‌ی قبلی هنوز در حال اجراست." : ""}`);
    return this.finish(run, "failed");
  }

  private async onFixEnv(run: Run<DeployState>, values: Record<string, string>): Promise<void> {
    const keys: string[] = [];
    for (const [k, v] of Object.entries(values ?? {})) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k) || !v) continue;
      this.k.secrets.set(run.id, k, v);
      if (!run.state.envKeys.includes(k)) run.state.envKeys.push(k);
      keys.push(k);
    }
    return this.proposeRedeploy(run, keys);
  }

  /** New approvals for env update + re-release of the same approved archive. */
  private async proposeRedeploy(run: Run<DeployState>, changedKeys: string[]): Promise<void> {
    const s = run.state;
    const ctxT = { actor: "agent" as const, chatId: s.chatId, runId: run.id, projectName: s.appName };
    s.approvals = {};
    const all = [...new Set([...s.envKeys, ...(s.database && s.database.mode !== "none" ? ["DATABASE_URL"] : [])])];
    const upd = await this.ctx.gateway.run({ capabilityId: "paas.updateEnvs", req: { body: { project: s.appName, variables: all.map((k) => ({ key: k, value: `{{secret:${k}}}` })) } }, resource: s.appName!, title: `تنظیم متغیر ${changedKeys.join("، ")}`, reason: "build بدون این متغیر شکست خورد", effect: "متغیرها تنظیم می‌شن و برنامه ری‌استارت می‌شه.", downtime: "چند ثانیه" }, ctxT);
    if (upd.status === "approval_required") s.approvals.updateEnvs = upd.approval.id;
    const rel = await this.ctx.gateway.run({ capabilityId: "paas.releasesDeploy", req: { pathParams: { name: s.appName! }, body: { sourceID: `{{source:${s.packageDigest}}}`, port: s.port, type: s.platform } }, resource: s.appName!, title: "تلاش دوباره برای انتشار", reason: `تلاش ${faNum(s.deployAttempts + 1)} از ${faNum(this.ctx.cfg.maxRepairAttempts)}`, effect: "همون سورس دوباره build و منتشر می‌شه." }, ctxT);
    if (rel.status === "approval_required") s.approvals.release = rel.approval.id;
    s.deployAttempts += 1;
    const ids = Object.values(s.approvals).filter((x): x is string => !!x);
    this.k.chat.post(s.chatId, "assistant", `راه‌حل: ${changedKeys.join("، ")} رو تنظیم کنم و دوباره build بگیرم. اگه بعد از ${faNum(this.ctx.cfg.maxRepairAttempts)} تلاش حل نشد، گزارش کامل و قدم‌های پیشنهادی رو برات می‌ذارم.`, ids.map((id) => ({ type: "approval" as const, approval: this.ctx.approvals.get(id)! })));
    run.step = "redeployApproval";
    run.status = "waiting_approval";
    this.k.runs.save(run);
    this.k.chat.phase(s.chatId, "waiting_approval", run.id);
    this.k.chat.done(s.chatId, "waiting_for_approval", run.id);
  }

  private async verify(run: Run<DeployState>): Promise<boolean> {
    const s = run.state;
    this.k.chat.phase(s.chatId, "verifying", run.id);
    const plan = await this.k.plans.ramOf(s.planId);
    const paths = s.profile?.healthPaths ?? ["/"];
    const snap = await snapshot(this.ctx.liara, this.ctx.prober, s.appName!, { healthPaths: paths, planRamGb: plan.ramGb, planCpu: plan.cpu, nowMs: this.ctx.clock.now().getTime(), samples: 2, windowSec: 600 });
    const checks = checksFrom(snap);
    const verdict = overall(checks);
    const url = `https://${s.appName}.liara.run`;
    this.ctx.db.run(
      "INSERT INTO deployments(id, project_name, chat_id, source_id, release_id, port, platform, status, started_at, finished_at, verification_json, previous_release, workspace_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      `dep_${run.id}_${s.deployAttempts}`,
      s.appName!,
      s.chatId,
      s.packageDigest,
      s.releaseId,
      s.port,
      s.platform,
      verdict === "unhealthy" ? "failed_verification" : "succeeded",
      s.deployStartedAt ?? iso(),
      iso(),
      JSON.stringify(checks),
      s.previousRelease,
      s.workspaceId,
    );
    this.ctx.db.run(
      `INSERT INTO projects(name, platform, plan_id, environment, profile_json, health, health_url, last_deploy_at, created_by_agent, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET platform=excluded.platform, plan_id=COALESCE(excluded.plan_id, plan_id), environment=excluded.environment, profile_json=excluded.profile_json, health=excluded.health, last_deploy_at=excluded.last_deploy_at, updated_at=excluded.updated_at`,
      s.appName!,
      s.platform,
      s.planId,
      s.stage,
      JSON.stringify(s.profile),
      verdict === "healthy" ? "healthy" : verdict === "warning" ? "warning" : "failing",
      paths[0] ?? "/",
      iso(),
      s.existingApp ? 0 : 1,
      iso(),
      iso(),
    );
    this.k.chat.post(s.chatId, "assistant", "", [{ type: "verification", title: "بررسی سلامت بعد از دپلوی", checks, delta: [] }]);
    if (verdict === "unhealthy") {
      const items = checks.filter((c) => c.status === "FAIL").map((c) => `${c.label}: ${c.value ?? ""} ${c.evidence ?? ""}`);
      this.k.chat.post(s.chatId, "assistant", "انتشار انجام شد ولی بررسی سلامت رد شد؛ دپلوی رو موفق اعلام نمی‌کنم.", [
        { type: "report", title: "چرا موفق نیست", sections: [{ heading: "بررسی‌های ناموفق", items }, { heading: "قدم بعدی", items: [s.previousRelease ? "می‌تونم نسخه‌ی قبلی رو دوباره منتشر کنم (rollback) — بگو «rollback کن»." : "بگو «ببین چرا خطا می‌ده» تا علت رو بررسی کنم."] }] },
      ]);
      this.ctx.notifier.push({ kind: "deploy", title: `دپلوی ${s.appName} بررسی سلامت رو رد کرد`, body: items.join(" · ").slice(0, 300), severity: "warning", href: `/chat/${s.chatId}` });
      this.finish(run, "failed");
      return false;
    }
    this.k.chat.post(s.chatId, "assistant", "دپلوی تموم شد و بررسی‌ها رد نشدن.", [
      {
        type: "success",
        title: "سایتت بالا اومد",
        url,
        facts: [
          { label: "برنامه", value: s.appName! },
          { label: "انتشار", value: s.releaseId ?? "—" },
          { label: "بررسی سلامت", value: verdict === "healthy" ? "سالم" : "سالم با هشدار" },
          { label: "حالت", value: this.ctx.cfg.mode === "demo" ? "دمو (شبیه‌سازی)" : "واقعی" },
        ],
        next: ["برای وصل کردن دامنه بگو: «دامنه example.ir رو وصل کن».", "پایش هر ۳ ساعت رو فعال کن تا اگه مشکلی پیش اومد خبرت کنم."],
      },
    ]);
    this.ctx.notifier.push({ kind: "deploy", title: `${s.appName} با موفقیت دپلوی شد`, body: url, severity: "success", href: `/projects/${s.appName}` });
    this.ask(run, patrolCard(s.appName!, this.ctx.cfg.monitorIntervalHours));
    return true;
  }

  private async onPatrol(run: Run<DeployState>, v: string): Promise<void> {
    const s = run.state;
    if (v === "on") {
      savePatrolSettings(this.k, s.appName!, { enabled: true, intervalHours: this.ctx.cfg.monitorIntervalHours, healthUrl: s.profile?.healthPaths[0] ?? "/" });
      this.k.chat.post(s.chatId, "assistant", `پایش فعال شد؛ هر ${faNum(this.ctx.cfg.monitorIntervalHours)} ساعت چک می‌کنم و فقط اگه مشکلی بود خبرت می‌کنم.`);
    } else this.k.chat.post(s.chatId, "assistant", "باشه؛ هر وقت خواستی از صفحه‌ی پروژه پایش رو روشن کن.");
    return this.finish(run, "completed");
  }

  private finish(run: Run<DeployState>, status: "completed" | "failed" | "cancelled"): void {
    run.status = status;
    run.step = "done";
    this.k.runs.save(run);
    this.k.chat.done(run.state.chatId, status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled", run.id);
  }
}

/** Temporary in-memory store for uploaded ZIPs between upload and card answer. */
export const uploads = new Map<string, { name: string; data: Uint8Array; at: number }>();

export function savePatrolSettings(k: Kit, project: string, patch: Partial<{ enabled: boolean; intervalHours: number; healthUrl: string | null; checks: Record<string, boolean>; channels: { inApp: boolean; telegram: boolean; email: boolean }; autoRestartOnCrashLoop: boolean }>): void {
  const row = k.ctx.db.get<{ settings_json: string }>("SELECT settings_json FROM patrol_settings WHERE project_name = ?", project);
  const prev = row ? (JSON.parse(row.settings_json) as Record<string, unknown>) : {};
  const settings = {
    projectName: project,
    enabled: true,
    intervalHours: k.ctx.cfg.monitorIntervalHours,
    healthUrl: "/",
    checks: { status: true, http: true, tls: true, resources: true, logs: true, disk: true, wallet: true },
    channels: { inApp: true, telegram: Boolean(k.ctx.cfg.telegram.token), email: Boolean(k.ctx.cfg.notifyMail.to) },
    autoRestartOnCrashLoop: false,
    ...prev,
    ...patch,
  };
  const next = new Date(k.ctx.clock.now().getTime() + (settings.intervalHours as number) * 3600_000).toISOString();
  k.ctx.db.run(
    "INSERT INTO patrol_settings(project_name, settings_json, next_run_at) VALUES(?,?,?) ON CONFLICT(project_name) DO UPDATE SET settings_json = excluded.settings_json, next_run_at = COALESCE(patrol_settings.next_run_at, excluded.next_run_at)",
    project,
    JSON.stringify(settings),
    next,
  );
  k.ctx.audit.record({ actor: "user", kind: "patrol.settings", resource: project, status: "saved", args: settings });
}

function toAscii(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}
