import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalView, Block } from "@liara-agent/shared";
import type { Ctx } from "../context.js";
import { AgentError, ERROR_FA, toAgentError } from "../errors.js";
import type { LiaraRequest } from "../liara/transport.js";
import { SecretStore } from "../security/secrets.js";
import { checksFrom, overall, snapshot } from "../verify/observe.js";
import { TERMINAL_RELEASE_STATES } from "../liara/services.js";
import { T } from "../i18n/fa.js";
import { faNum, sha256, sleep } from "../util.js";
import { ChatService } from "./chat.js";
import { DeployFlow, savePatrolSettings, type DeployState } from "./deployFlow.js";
import { IncidentFlow } from "./incidentFlow.js";
import { PlanCache, text, type Kit } from "./kit.js";
import { OpsAgent } from "./opsAgent.js";
import { RunStore } from "./runs.js";
import { classifyIntent, extractDomain, findAppMention, IntentSchema, type Intent } from "./supervisor.js";
import { confirmCard } from "./cards.js";
import { dirname } from "node:path";

/**
 * Supervisor / RouterGraph: routes a Persian request to DeployFlow,
 * IncidentFlow, deterministic handlers, or the LLM OpsAgent; resumes
 * workflows when the user answers a card or decides an approval.
 */
export class Agent {
  readonly kit: Kit;
  readonly chat: ChatService;
  readonly runs: RunStore;
  readonly deploy: DeployFlow;
  readonly incidents: IncidentFlow;
  readonly ops: OpsAgent;
  private inflight = new Set<Promise<void>>();

  constructor(readonly ctx: Ctx) {
    this.chat = new ChatService(ctx);
    this.runs = new RunStore(ctx);
    const secrets = new SecretStore(ctx.db, join(dirname(ctx.cfg.databasePath), "secret.key"));
    this.kit = { ctx, chat: this.chat, runs: this.runs, secrets, plans: new PlanCache(ctx), bg: (label, fn) => this.bg(label, fn) };
    this.deploy = new DeployFlow(this.kit);
    this.incidents = new IncidentFlow(this.kit);
    this.ops = new OpsAgent(this.kit, this.incidents);
  }

  /** Fire-and-forget with error capture; tests can await `idle()`. */
  bg(label: string, fn: () => Promise<void>): void {
    const p = fn()
      .catch((e) => {
        const err = toAgentError(e);
        this.ctx.bus.emit("error", { code: err.code, message: `${label}: ${ERROR_FA[err.code]}`, retryable: err.retryable });
      })
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /** Mark interrupted runs on boot so the UI shows an honest state. */
  recover(): void {
    for (const r of this.runs.interrupted()) {
      this.runs.fail(r, "process restarted during this step");
      if (r.chatId) this.chat.post(r.chatId, "assistant", "سرور وسط این مرحله ری‌استارت شد. وضعیت ذخیره شده؛ برای ادامه همون درخواست رو دوباره بفرست.");
    }
    for (const c of this.chat.list().filter((c) => c.busy)) this.chat.busy(c.id, false);
  }

  // ---- user messages --------------------------------------------------------
  async userMessage(chatId: string, text: string): Promise<void> {
    const summary = this.chat.summary(chatId);
    if (!summary) throw new AgentError("NOT_FOUND", "chat not found");
    if (summary.busy) throw new AgentError("CONFLICT", "ایجنت هنوز روی پیام قبلی کار می‌کنه");
    this.chat.post(chatId, "user", text.slice(0, 4000));
    if (this.chat.messages(chatId).filter((m) => m.role === "user").length === 1) this.chat.rename(chatId, text);
    this.chat.busy(chatId, true);
    this.ctx.bus.emit("agent.started", { label: "ایجنت شروع کرد" }, { chatId });
    this.chat.phase(chatId, "analyzing_request");
    this.bg("message", () => this.route(chatId, text));
  }

  private async route(chatId: string, text: string): Promise<void> {
    const apps = await this.ctx.liara.listApps().then((a) => a.map((x) => x.name)).catch(() => [] as string[]);
    let { intent, confident } = classifyIntent(text);
    let app = findAppMention(text, apps) ?? this.chat.summary(chatId)?.projectName ?? null;
    if (app && !apps.includes(app) && apps.length) app = findAppMention(text, apps);
    if (!confident && this.ctx.llm.configured) {
      try {
        const r = await this.ctx.llm.chat({ role: "simple_classification", schema: IntentSchema, schemaName: "intent", chatId, maxTokens: 200, messages: [{ role: "system", content: `Classify a Persian DevOps request for the Liara cloud. Known apps: ${apps.join(", ") || "none"}.` }, { role: "user", content: text }] });
        intent = r.parsed.intent;
        app = r.parsed.app && apps.includes(r.parsed.app) ? r.parsed.app : app;
      } catch {
        /* keep deterministic result */
      }
    }
    if (app) this.chat.setProject(chatId, app);
    try {
      await this.dispatch(chatId, intent, text, app, apps);
    } catch (e) {
      const err = toAgentError(e);
      this.chat.post(chatId, "assistant", ERROR_FA[err.code], [{ type: "code", title: "جزئیات فنی", language: "text", code: err.message.slice(0, 600) }]);
      this.chat.phase(chatId, "failed");
      this.chat.done(chatId, "failed");
    }
  }

  private needApp(chatId: string, app: string | null, apps: string[]): app is string {
    if (app) return true;
    this.chat.post(chatId, "assistant", apps.length ? `منظورت کدوم برنامه‌ست؟ ${apps.map((a) => `«${a}»`).join("، ")}` : "هنوز برنامه‌ای در حسابت پیدا نکردم. اول بگو «پروژه‌م رو دیپلوی کن».");
    this.chat.done(chatId, "waiting_for_user");
    return false;
  }

  private async dispatch(chatId: string, intent: Intent, text: string, app: string | null, apps: string[]): Promise<void> {
    switch (intent) {
      case "deploy":
        this.deploy.start(chatId, text);
        return;
      case "redeploy_latest":
      case "deploy_failure": {
        if (!this.needApp(chatId, app, apps)) return;
        if (intent === "deploy_failure") return this.explainDeployFailure(chatId, app);
        this.chat.post(chatId, "assistant", "برای انتشار نسخه‌ی جدید به سورس جدید نیاز دارم؛ API لیارا امکان build از Git متصل رو نداره. منبع کد رو انتخاب کن.");
        this.deploy.start(chatId, text);
        return;
      }
      case "diagnose":
        if (!this.needApp(chatId, app, apps)) return;
        return this.incidents.diagnose(chatId, app, text);
      case "logs":
        if (!this.needApp(chatId, app, apps)) return;
        return this.showLogs(chatId, app);
      case "rollback":
        if (!this.needApp(chatId, app, apps)) return;
        return this.proposeRollback(chatId, app);
      case "domain":
        if (!this.needApp(chatId, app, apps)) return;
        return this.domain(chatId, app, extractDomain(text));
      case "database":
        return this.databaseHealth(chatId);
      case "plan":
        return this.planAndCost(chatId, app);
      case "list_projects":
        return this.listProjects(chatId);
      case "restart":
        if (!this.needApp(chatId, app, apps)) return;
        return this.simpleAction(chatId, app, "paas.restartApp", { pathParams: { name: app } }, `ری‌استارت ${app}`, "کانتینرها دوباره راه‌اندازی می‌شن؛ چند ثانیه قطعی.");
      case "auto_fix_policy":
        if (!this.needApp(chatId, app, apps)) return;
        this.chat.post(chatId, "assistant", "می‌تونم فقط یک کار کم‌خطر رو بدون پرسیدن انجام بدم: ری‌استارت وقتی برنامه مدام کرش می‌کنه (حداکثر ۱ بار در ۲۴ ساعت). بقیه‌ی تغییرها همیشه تأیید تو رو لازم دارن.", [
          { type: "ask", card: confirmCard("autoRestart", `اجازه‌ی ری‌استارت خودکار برای ${app}؟`, "هشدار: ایجنت بدون اینکه ازت بپرسه ری‌استارت می‌کنه. روی سرویس اثر می‌ذاره.", [{ value: `on:${app}`, label: "اجازه می‌دم" }, { value: "off", label: "نه", recommended: true }]) },
        ]);
        this.chat.done(chatId, "waiting_for_user");
        return;
      case "help":
        this.chat.post(chatId, "assistant", "سلام! من ایجنت دپلوی لیارا هستم. می‌تونم پروژه‌ات رو بررسی، تست و روی لیارا دپلوی کنم، سلامتش رو پایش کنم، علت خطاها رو پیدا کنم و با تأیید تو درستشون کنم.", [
          { type: "report", title: "چند نمونه درخواست", sections: [{ heading: "امتحان کن", items: ["پروژه فروشگاهی منو روی لیارا دیپلوی کن.", "چرا سایت کند شده؟", "لاگ‌های امروز رو بررسی کن.", "پلن مناسب رو انتخاب کن و هزینه تقریبی رو نشون بده.", "دامنه example.ir رو به پروژه وصل کن.", "ببین دیتابیس سالمه یا نه."] }] },
        ]);
        this.chat.done(chatId, "completed");
        return;
      default:
        if (this.ctx.llm.configured) return this.ops.handle(chatId, this.chat.messages(chatId), text, app);
        this.chat.post(chatId, "assistant", `${T.aiNotConfigured} این درخواست رو مطمئن نیستم چطور انجام بدم. یکی از نمونه‌ها رو امتحان کن یا AI_API_KEY رو تنظیم کن.`);
        this.chat.done(chatId, "completed");
    }
  }

  // ---- deterministic handlers ---------------------------------------------
  private async showLogs(chatId: string, app: string): Promise<void> {
    this.chat.phase(chatId, "reading_logs");
    const since = Math.floor(this.ctx.clock.now().getTime() / 1000) - 24 * 3600;
    const lines = await this.ctx.liara.logs(app, since);
    const { condenseLogs } = await import("../rca/rca.js");
    const groups = condenseLogs(lines, 10);
    this.chat.post(chatId, "assistant", groups.length ? `در ۲۴ ساعت اخیر ${faNum(lines.length)} خط لاگ بود؛ ${faNum(groups.length)} الگوی خطا/هشدار پیدا کردم:` : `در ۲۴ ساعت اخیر ${faNum(lines.length)} خط لاگ بود و الگوی خطایی پیدا نشد.`, groups.length ? [{ type: "table", title: `لاگ‌های ${app}`, columns: ["سطح", "تکرار", "آخرین بار", "نمونه"], ltrColumns: [2, 3], rows: groups.map((g) => [g.level === "error" ? "خطا" : "هشدار", faNum(g.count), g.last.slice(11, 19), g.sample.slice(0, 160)]) }] : []);
    this.chat.done(chatId, "completed");
  }

  private async explainDeployFailure(chatId: string, app: string): Promise<void> {
    this.chat.phase(chatId, "reading_logs");
    const rels = await this.ctx.liara.releases(app, 5);
    const failed = rels.releases.find((r) => ["FAILED", "TIMEOUT", "CANCELED"].includes(r.state));
    if (!failed) {
      this.chat.post(chatId, "assistant", `آخرین انتشارهای ${app} ناموفق نبودن (${rels.releases.slice(0, 3).map((r) => `${r.tag ?? r.id}: ${r.state}`).join("، ")}). اگه سایت مشکل داره بگو «ببین چرا خطا می‌ده».`);
      return this.chat.done(chatId, "completed");
    }
    const since = Math.floor(Date.parse(failed.createdAt ?? new Date().toISOString()) / 1000) - 60;
    const logs = await this.ctx.liara.logs(app, since).catch(() => []);
    const { rootCause } = await import("../rca/rca.js");
    const rca = await rootCause({ failureText: logs.map((l) => l.message).join("\n").slice(-8000), failingCommand: "liara build", workspaceDir: null, context: [`release ${failed.id} → ${failed.state}`], attempts: [], maxAttempts: this.ctx.cfg.maxRepairAttempts, chatId }, { llm: this.ctx.llm, kb: this.ctx.kb });
    this.chat.post(chatId, "assistant", "آخرین انتشار ناموفق رو بررسی کردم:", [{ type: "root_cause", report: rca.report }, { type: "text", text: "برای اصلاح و انتشار دوباره بگو «پروژه رو دوباره دیپلوی کن» و سورس رو بده." }]);
    this.chat.done(chatId, "completed");
  }

  private async proposeRollback(chatId: string, app: string): Promise<void> {
    const deps = this.ctx.db.all<{ source_id: string | null; release_id: string | null; started_at: string; workspace_id: string | null }>("SELECT source_id, release_id, started_at, workspace_id FROM deployments WHERE project_name = ? AND status = 'succeeded' ORDER BY started_at DESC LIMIT 5", app);
    const prev = deps[1];
    const cap = this.ctx.registry.get("paas.rollback")!;
    if (!prev?.source_id || !this.packagePath(prev.source_id)) {
      this.chat.post(chatId, "assistant", "", [{ type: "limitation", title: "rollback از طریق API لیارا مستقیم ممکن نیست", reason: `${cap.evidence} ایجنت فقط می‌تونه سورسی رو دوباره منتشر کنه که خودش قبلاً دپلوی کرده، و نسخه‌ی قبلی ${app} در سابقه‌ی ایجنت نیست.`, capabilityId: "paas.rollback", steps: ["در کنسول لیارا بخش «تاریخچه‌ی استقرار» نسخه‌ی قبلی رو انتخاب کن.", "یا با Liara CLI نسخه‌ی قبلی کد رو دوباره دپلوی کن."], link: { label: "کنسول لیارا", href: "https://console.liara.ir" } }]);
      return this.chat.done(chatId, "completed");
    }
    const platform = (await this.ctx.liara.getApp(app))?.platform ?? undefined;
    const port = this.ctx.db.get<{ port: number | null }>("SELECT port FROM deployments WHERE source_id = ? LIMIT 1", prev.source_id)?.port ?? 3000;
    const out = await this.ctx.gateway.run(
      { capabilityId: "paas.releasesDeploy", req: { pathParams: { name: app }, body: { sourceID: `{{source:${prev.source_id}}}`, port, type: platform } }, resource: app, title: `بازگشت ${app} به نسخه‌ی ${prev.started_at.slice(0, 16).replace("T", " ")}`, reason: "rollback درخواستی کاربر", effect: "نسخه‌ی فعلی با نسخه‌ی قبلی جایگزین می‌شه.", downtime: "ممکنه چند ثانیه", reversible: "نسخه‌ی فعلی هم دوباره قابل انتشاره", evidence: [`release قبلی: ${prev.release_id ?? "?"}`] },
      { actor: "agent", chatId, runId: null, projectName: app },
    );
    if (out.status === "approval_required") this.chat.post(chatId, "assistant", "نسخه‌ی قبلی رو پیدا کردم. با تأیید تو دوباره منتشرش می‌کنم و بعد سلامت رو بررسی می‌کنم.", [{ type: "approval", approval: out.approval }]);
    this.chat.done(chatId, "waiting_for_approval");
  }

  private async domain(chatId: string, app: string, domain: string | null): Promise<void> {
    const existing = await this.ctx.liara.domains(app).catch(() => []);
    if (!domain) {
      this.chat.post(chatId, "assistant", existing.length ? "دامنه‌های فعلی:" : `${app} هنوز دامنه‌ای نداره. اسم دامنه رو بنویس (مثلاً «دامنه shop.example.ir رو وصل کن»).`, existing.length ? [{ type: "table", title: "دامنه‌ها", columns: ["دامنه", "وضعیت", "SSL", "CNAME"], ltrColumns: [0, 3], rows: existing.map((d) => [d.name, d.status ?? "—", d.certificatesStatus ?? "—", d.cname ?? "—"]) }] : []);
      return this.chat.done(chatId, "completed");
    }
    const found = existing.find((d) => d.name === domain);
    if (found) {
      this.chat.post(chatId, "assistant", `«${domain}» از قبل به ${app} وصله (وضعیت ${found.status ?? "?"}, SSL ${found.certificatesStatus ?? "?"}).`, [{ type: "report", title: "تنظیم DNS", sections: [{ heading: "در پنل دامنه", items: [`یک رکورد CNAME برای ${domain} به ${found.cname ?? `${app}.liara.run`} بساز.`, "بعد از انتشار DNS بگو «SSL رو فعال کن»."] }] }]);
      return this.chat.done(chatId, "completed");
    }
    const sub = domain.split(".").length > 2;
    const out = await this.ctx.gateway.run({ capabilityId: "paas.createAppDomain", req: { body: { name: domain, project: app, type: sub ? "SUBDOMAIN" : "ROOT" } }, resource: domain, title: `اتصال دامنه‌ی ${domain} به ${app}`, reason: "درخواست کاربر", effect: "دامنه به برنامه اضافه می‌شه؛ بعدش باید رکورد DNS تنظیم بشه." }, { actor: "agent", chatId, runId: null, projectName: app });
    this.chat.post(chatId, "assistant", "برای وصل کردن دامنه دو بخش داره: یکی در لیارا (با تأیید تو) و یکی در پنل ثبت‌کننده‌ی دامنه (دستی، چون API لیارا به ثبت‌کننده دسترسی نداره).", [
      ...(out.status === "approval_required" ? [{ type: "approval" as const, approval: out.approval }] : []),
      { type: "report", title: "قدم‌های دستی بعد از تأیید", sections: [{ heading: "در پنل ثبت‌کننده یا DNS", items: [sub ? `رکورد CNAME: ${domain} → ${app}.liara.run` : `نیم‌سرورها رو به DNS لیارا بده یا رکورد ALIAS/A طبق راهنمای لیارا بساز`, "منتظر انتشار DNS بمون (چند دقیقه تا چند ساعت)", "بعد بگو «SSL دامنه رو فعال کن» تا گواهی صادر بشه"] }] },
      { type: "limitation", title: "تغییر رکورد در ثبت‌کننده‌ی دامنه", reason: "API لیارا به حساب ثبت‌کننده‌ی دامنه (مثل nic.ir) دسترسی نداره.", capabilityId: "domain.registrar", steps: [], link: null },
    ]);
    this.chat.done(chatId, out.status === "approval_required" ? "waiting_for_approval" : "completed");
  }

  private async databaseHealth(chatId: string): Promise<void> {
    this.chat.phase(chatId, "calling_liara");
    const dbs = await this.ctx.liara.databases();
    if (!dbs.length) {
      this.chat.post(chatId, "assistant", "در حسابت دیتابیسی پیدا نکردم.");
      return this.chat.done(chatId, "completed");
    }
    const rows: string[][] = [];
    for (const d of dbs.slice(0, 10)) {
      const backups = await this.ctx.client.readSafe<{ backups?: { lastModified?: string }[] }>("dbaas.getListBackups", { pathParams: { id: d.id } }).catch(() => null);
      const last = backups?.backups?.[0]?.lastModified ?? null;
      rows.push([d.hostname, d.type ?? "—", d.status ?? "—", d.publicNetwork ? "باز ⚠" : "بسته", last ? last.slice(0, 10) : "بکاپی نیست"]);
    }
    const warn = dbs.filter((d) => !/RUNNING|ACTIVE/i.test(d.status ?? "") || d.publicNetwork);
    this.chat.post(chatId, "assistant", warn.length ? `${faNum(warn.length)} مورد نیاز به توجه داره:` : "همه‌ی دیتابیس‌ها روشن هستن و دسترسی عمومی ندارن.", [{ type: "table", title: "وضعیت دیتابیس‌ها", columns: ["نام", "نوع", "وضعیت", "دسترسی عمومی", "آخرین بکاپ"], ltrColumns: [0], rows }]);
    this.chat.done(chatId, "completed");
  }

  private async planAndCost(chatId: string, app: string | null): Promise<void> {
    this.chat.phase(chatId, "planning");
    const [plans, bal, apps] = await Promise.all([this.kit.plans.get().catch(() => null), this.ctx.liara.balance().catch(() => ({ balance: null, minCredit: null })), this.ctx.liara.listApps().catch(() => [])]);
    const blocks: Block[] = [];
    let hourlyTotal = 0;
    let unknown = 0;
    const rows: string[][] = [];
    for (const a of apps) {
      const detail = await this.ctx.liara.getApp(a.name).catch(() => null);
      const h = detail?.hourlyPrice ?? null;
      if (h === null) unknown++;
      else hourlyTotal += h;
      rows.push([a.name, a.planId ?? "—", a.scale === 0 ? "خاموش" : "روشن", h === null ? "نامشخص" : `${faNum(Math.round(h))}`]);
    }
    blocks.push({ type: "table", title: "هزینه‌ی برنامه‌ها (از API)", columns: ["برنامه", "پلن", "وضعیت", "تومان/ساعت"], ltrColumns: [0, 1], rows });
    if (plans) blocks.push({ type: "table", title: "پلن‌های موجود (GET /v1/me)", columns: ["پلن", "CPU", "RAM", "دیسک", "قیمت"], ltrColumns: [0], rows: plans.projects.slice(0, 8).map((p) => [p.planId, p.cpu === null ? "?" : faNum(p.cpu), p.ramGb === null ? "?" : `${faNum(p.ramGb)}GB`, p.diskGb === null ? "?" : `${faNum(p.diskGb)}GB`, p.price.monthlyToman !== null ? `${faNum(p.price.monthlyToman)} ماهانه` : p.price.hourlyToman !== null ? `${faNum(p.price.hourlyToman)} ساعتی` : "نامشخص"]) });
    const runway = bal.balance !== null && hourlyTotal > 0 ? Math.floor(bal.balance / (hourlyTotal * 24)) : null;
    const lines = [
      bal.balance !== null ? `موجودی کیف پول: ${faNum(bal.balance)} تومان (GET /v1/billing)` : "موجودی از API دریافت نشد.",
      `مصرف ساعتی برنامه‌ها: ${faNum(Math.round(hourlyTotal))} تومان${unknown ? ` + ${faNum(unknown)} برنامه با قیمت نامشخص` : ""}`,
      runway !== null ? `با این روند موجودی حدود ${faNum(runway)} روز کافیه (فقط برنامه‌ها؛ دیتابیس و سایر سرویس‌ها جدا).` : T.priceUnavailable,
      "ریز فاکتور و تاریخچه‌ی مصرف از طریق API لیارا در دسترس نیست.",
    ];
    if (app) {
      const inc = this.ctx.incidents.list({ project: app, openOnly: true });
      if (inc.some((i) => /حافظه/.test(i.title))) lines.push(`برای ${app} رخداد باز کمبود حافظه وجود داره؛ ارتقای پلن رو در کارت رخداد پیشنهاد دادم.`);
    }
    this.chat.post(chatId, "assistant", "خلاصه‌ی هزینه و پلن‌ها:", [{ type: "report", title: "هزینه", sections: [{ heading: "بر پایه‌ی داده‌ی API", items: lines }] }, ...blocks]);
    this.chat.done(chatId, "completed");
  }

  private async listProjects(chatId: string): Promise<void> {
    const apps = await this.ctx.liara.listApps();
    this.chat.post(chatId, "assistant", `${faNum(apps.length)} برنامه در حسابت هست:`, [{ type: "table", title: "برنامه‌ها", columns: ["نام", "پلتفرم", "پلن", "وضعیت", "رخداد باز"], ltrColumns: [0], rows: apps.map((a) => [a.name, a.platform ?? "—", a.planId ?? "—", a.scale === 0 ? "خاموش" : (a.status ?? "—"), faNum(this.ctx.incidents.openCount(a.name))]) }]);
    this.chat.done(chatId, "completed");
  }

  private async simpleAction(chatId: string, app: string, capId: string, req: LiaraRequest, title: string, effect: string): Promise<void> {
    const out = await this.ctx.gateway.run({ capabilityId: capId, req, resource: app, title, reason: "درخواست کاربر", effect }, { actor: "agent", chatId, runId: null, projectName: app });
    if (out.status === "approval_required") this.chat.post(chatId, "assistant", "این کار روی سرویس اثر می‌ذاره؛ با تأیید تو انجامش می‌دم:", [{ type: "approval", approval: out.approval }]);
    else if (out.status === "denied") this.chat.post(chatId, "assistant", "", [{ type: "limitation", title: `${title} ممکن نیست`, reason: out.reason, capabilityId: capId, steps: [], link: null }]);
    else this.chat.post(chatId, "assistant", `${title} انجام شد.`);
    this.chat.done(chatId, out.status === "approval_required" ? "waiting_for_approval" : "completed");
  }

  // ---- answers & approvals ------------------------------------------------
  async answer(chatId: string, cardId: string, value: unknown): Promise<void> {
    const found = this.chat.findAsk(chatId, cardId);
    if (!found) throw new AgentError("NOT_FOUND", "card not found");
    if (found.card.state !== "pending") throw new AgentError("CONFLICT", "این کارت قبلاً جواب داده شده");
    if (found.card.key === "autoRestart") {
      this.chat.patchBlock(found.message.id, (b) => b.type === "ask" && b.card.id === cardId, (b) => (b.type === "ask" ? { ...b, card: { ...b.card, state: "answered", answer: value } } : b));
      const v = String(value);
      if (v.startsWith("on:")) {
        savePatrolSettings(this.kit, v.slice(3), { autoRestartOnCrashLoop: true, enabled: true });
        this.chat.post(chatId, "assistant", `ری‌استارت خودکار برای ${v.slice(3)} فعال شد (حداکثر ۱ بار در ۲۴ ساعت، همه در لاگ فعالیت).`);
      } else this.chat.post(chatId, "assistant", "باشه؛ بدون تأیید تو هیچ تغییری نمی‌دم.");
      return;
    }
    const run = this.runs.activeForChat<DeployState>(chatId, "deploy");
    if (!run) throw new AgentError("CONFLICT", "این کارت به فرایند فعالی وصل نیست");
    this.chat.busy(chatId, true);
    this.bg("answer", () => this.deploy.answer(run.id, found.card.key, value));
  }

  async decide(approvalId: string, decision: "approve" | "reject", typed: string | null, actor: string): Promise<ApprovalView> {
    const a = this.ctx.approvals.decide(approvalId, decision, actor, typed);
    this.ctx.audit.record({ actor, kind: `approval.${decision}`, capabilityId: a.capabilityId, resource: a.resource, risk: a.risk, approvalId, status: a.status, chatId: a.chatId, runId: a.runId });
    this.ctx.bus.emit("approval.received", { approval: a }, { chatId: a.chatId, runId: a.runId });
    this.chat.refreshApproval(approvalId);
    if (a.runId) {
      const run = this.runs.get<DeployState>(a.runId);
      if (run && run.status === "waiting_user" && run.step === "invoice") return a; // invoice resumes on batch confirm
      if (run && (run.step === "invoice" || run.step === "redeployApproval")) {
        const ids = Object.values(run.state.approvals).filter((x): x is string => !!x);
        const all = ids.map((id) => this.ctx.approvals.get(id)!);
        if (decision === "reject" || all.every((x) => x.status === "approved")) this.bg("resume", () => this.deploy.answer(run.id, run.step, "approved"));
      }
      return a;
    }
    if (decision === "reject") {
      if (a.incidentId) this.ctx.incidents.transition(a.incidentId, "DIAGNOSED", "تأیید رد شد");
      if (a.chatId) this.chat.post(a.chatId, "assistant", "رد شد؛ هیچ تغییری انجام نشد.");
      return a;
    }
    this.bg("execute", () => this.executeStandalone(a));
    return a;
  }

  /** Invoice «تأیید و پرداخت»: approves every approval listed on the invoice, then resumes. */
  async approveInvoice(chatId: string, cardId: string, actor: string): Promise<void> {
    const found = this.chat.findAsk(chatId, cardId);
    if (!found || found.card.kind !== "invoice" || found.card.state !== "pending") throw new AgentError("CONFLICT", "فاکتور فعال نیست");
    const ids = (found.card.defaultValue as string[]) ?? [];
    for (const id of ids) {
      const a = this.ctx.approvals.get(id);
      if (a?.status === "pending") {
        this.ctx.approvals.decide(id, "approve", actor, null);
        this.ctx.audit.record({ actor, kind: "approval.approve", capabilityId: a.capabilityId, resource: a.resource, risk: a.risk, approvalId: id, status: "approved", chatId, runId: a.runId });
      }
    }
    await this.answer(chatId, cardId, "approved");
  }

  private packagePath(digest: string): string | null {
    const dep = this.ctx.db.get<{ workspace_id: string | null }>("SELECT workspace_id FROM deployments WHERE source_id = ? AND workspace_id IS NOT NULL LIMIT 1", digest);
    const ws = dep?.workspace_id ? this.ctx.workspaces.get(dep.workspace_id) : null;
    const p = ws ? join(ws.deployPath, "..", `package-${digest}.tar.gz`) : null;
    return p && existsSync(p) ? p : null;
  }

  /** Executes an approval created outside a deploy run (ops chat, incident, rollback). */
  private async executeStandalone(a: ApprovalView): Promise<void> {
    const chatId = a.chatId;
    if (chatId) {
      this.chat.busy(chatId, true);
      this.chat.phase(chatId, a.capabilityId === "paas.releasesDeploy" ? "deploying" : "calling_liara");
    }
    try {
      const resolve = async (req: LiaraRequest): Promise<LiaraRequest> => {
        const json = JSON.stringify(req.body ?? null);
        const m = /\{\{source:([0-9a-f]{64})\}\}/.exec(json);
        if (!m) return req;
        const p = this.packagePath(m[1]!);
        if (!p) throw new AgentError("VALIDATION", "approved source archive is missing");
        const data = new Uint8Array(readFileSync(p));
        if (sha256(Buffer.from(data).toString("base64")) !== m[1]) throw new AgentError("UNSAFE_OPERATION", "source archive changed after approval");
        const up = await this.ctx.gateway.run<{ sourceID?: string }>({ capabilityId: "paas.sourcesDeploy", req: { pathParams: { name: a.resource }, file: { field: "file", name: "source.tar.gz", data, contentType: "application/gzip" } }, resource: a.resource, title: "آپلود سورس", reason: "rollback تأییدشده", effect: "upload" }, { actor: "user", chatId, runId: null });
        if (up.status !== "executed" || !up.data?.sourceID) throw new AgentError("DEPLOYMENT", "upload failed");
        return { ...req, body: JSON.parse(json.replace(m[0], up.data.sourceID)) };
      };
      const res = await this.ctx.gateway.executeApproved<{ releaseID?: string }>(a.id, { actor: "user", chatId, runId: null, incidentId: a.incidentId, projectName: a.projectName }, { resolve });
      this.chat.refreshApproval(a.id);
      if (a.incidentId) return await this.incidents.verifyAfter(a.incidentId, chatId);
      if (a.capabilityId === "paas.releasesDeploy" && res.data?.releaseID) {
        let state = "QUEUED";
        for (let i = 0; i < 240 && !TERMINAL_RELEASE_STATES.has(state); i++) {
          await sleep(this.ctx.cfg.mode === "demo" ? 100 : 5000);
          state = (await this.ctx.liara.releases(a.resource, 5)).releases.find((r) => r.id === res.data.releaseID)?.state ?? state;
        }
        if (state !== "READY") {
          if (chatId) this.chat.post(chatId, "assistant", `انتشار به وضعیت ${state} رسید و موفق نبود.`);
          return;
        }
      }
      if (chatId) {
        const svcAffecting = a.risk !== "L0" && a.risk !== "L1" && /^paas\.(restartApp|turnApp|changePlan|releasesDeploy|updateEnvs)$/.test(a.capabilityId);
        if (svcAffecting) {
          this.chat.phase(chatId, "verifying");
          await sleep(this.ctx.cfg.mode === "demo" ? 100 : 30_000);
          const plan = await this.kit.plans.ramOf((await this.ctx.liara.getApp(a.resource))?.planId ?? null);
          const snap = await snapshot(this.ctx.liara, this.ctx.prober, a.resource, { healthPaths: ["/"], planRamGb: plan.ramGb, planCpu: plan.cpu, nowMs: this.ctx.clock.now().getTime(), samples: 2, windowSec: 300 });
          const checks = checksFrom(snap);
          this.chat.post(chatId, "assistant", `«${a.title}» اجرا شد. ${overall(checks) === "unhealthy" ? "ولی بررسی سلامت رد شد." : "بررسی سلامت بعد از اجرا:"}`, [{ type: "verification", title: "بعد از اجرا", checks, delta: [] }]);
        } else this.chat.post(chatId, "assistant", `«${a.title}» اجرا شد.`, [text(T.approvalMeaning)]);
      }
    } catch (e) {
      const err = toAgentError(e);
      this.chat.refreshApproval(a.id);
      if (chatId) this.chat.post(chatId, "assistant", `اجرای «${a.title}» ناموفق بود: ${ERROR_FA[err.code]}`, [{ type: "code", title: "جزئیات", language: "text", code: err.message.slice(0, 500) }]);
    } finally {
      if (chatId) this.chat.done(chatId, "completed");
    }
  }
}
