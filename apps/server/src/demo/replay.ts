/**
 * Deterministic demo replay (`npm run demo:replay`). Runs three scenarios
 * end-to-end against the Mock Liara API with a fake clock and prints a
 * Persian transcript. No network access; no real Liara requests.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block } from "@liara-agent/shared";
import { loadConfig } from "../config.js";
import { createContext } from "../context.js";
import { Agent } from "../agent/agent.js";
import { DemoWorld } from "./world.js";
import { MockTransport } from "../liara/mockTransport.js";
import { Patrol } from "../monitor/patrol.js";
import { savePatrolSettings } from "../agent/deployFlow.js";
import { FakeClock } from "../util.js";

const dir = mkdtempSync(join(tmpdir(), "liara-demo-"));
const cfg = loadConfig({ DEMO_MODE: "true", DATABASE_PATH: join(dir, "agent.sqlite") });
const clock = new FakeClock(Date.parse("2026-10-23T09:00:00Z"));
const world = new DemoWorld(clock);
const transport = new MockTransport(world);
const ctx = createContext(cfg, { clock, transport });
const agent = new Agent(ctx);
const patrol = new Patrol(agent);

const show = (b: Block): string => {
  switch (b.type) {
    case "text":
      return b.text;
    case "ask":
      return `  [کارت] ${b.card.question}`;
    case "approval":
      return `  [تأیید ${b.approval.risk}] ${b.approval.title} — ${b.approval.status}`;
    case "gate":
      return `  [آزمایش] ${b.report.overall}: ${b.report.stages.map((s) => `${s.label}=${s.status}`).join("، ")}`;
    case "root_cause":
      return `  [علت] ${b.report.problem} (${Math.round(b.report.confidence * 100)}٪) ${b.report.location ? `${b.report.location.file}:${b.report.location.line}` : ""}`;
    case "patch":
      return `  [پچ] ${b.files.map((f) => f.path).join(", ")} — ${b.status}`;
    case "success":
      return `  [موفق] ${b.title} ${b.url ?? ""}`;
    case "verification":
      return `  [بررسی] ${b.checks.map((c) => `${c.label}=${c.status}`).join("، ")}${b.delta.length ? ` | ${b.delta.map((d) => `${d.label}: ${d.before}→${d.after}`).join("، ")}` : ""}`;
    case "incident":
      return `  [رخداد] ${b.title} · ${b.severity} · ${b.state}`;
    case "limitation":
      return `  [محدودیت] ${b.title}`;
    default:
      return `  [${b.type}]`;
  }
};

function dump(chatId: string, from: number): number {
  const msgs = agent.chat.messages(chatId);
  for (const m of msgs.slice(from)) {
    const who = m.role === "user" ? "👤" : "🤖";
    if (m.text) console.log(`${who} ${m.text}`);
    for (const b of m.blocks) console.log(show(b));
  }
  return msgs.length;
}

function pendingCard(chatId: string) {
  for (const m of agent.chat.messages(chatId).reverse()) for (const b of m.blocks) if (b.type === "ask" && b.card.state === "pending") return b.card;
  return null;
}

async function scenarioDeploy(): Promise<void> {
  console.log("\n══════ سناریو ۱: مخزن ← تحلیل ← آزمایش ← پچ ← تأیید ← دپلوی ← بررسی ══════");
  const chat = agent.chat.create();
  let seen = 0;
  await agent.userMessage(chat.id, "پروژه فروشگاهی منو روی لیارا دیپلوی کن. حدود ۵۰۰۰ کاربر همزمان داره");
  await agent.idle();
  const answers: Record<string, unknown> = { source: { kind: "sample" }, platform: "next", stage: "demo", users: 5000, appName: "shop-demo", database: "new", network: { choice: "no" }, patch: "apply", acceptIssues: "accept", patrol: "on" };
  for (let i = 0; i < 20; i++) {
    seen = dump(chat.id, seen);
    const card = pendingCard(chat.id);
    if (!card) break;
    if (card.kind === "invoice") {
      console.log("👤 [تأیید و پرداخت]");
      await agent.approveInvoice(chat.id, card.id, "demo-user");
    } else {
      const v = card.key === "plan" ? card.defaultValue : answers[card.key];
      console.log(`👤 → ${JSON.stringify(v)}`);
      await agent.answer(chat.id, card.id, v);
    }
    await agent.idle();
  }
  dump(chat.id, seen);
  console.log(`عملیات‌های Mock لیارا: ${world.mutations.join(" → ")}`);
}

async function scenarioIncident(): Promise<void> {
  console.log("\n══════ سناریو ۲: پایش ← رخداد OOM ← پیشنهاد ← تأیید ← بررسی قبل/بعد ══════");
  world.setScenario("shop-front-prod", "oom");
  savePatrolSettings(agent.kit, "shop-front-prod", { enabled: true });
  const run = await patrol.runProject("shop-front-prod", "schedule", "slot-oom");
  console.log(`پایش: ${run?.status} · فراخوانی مدل: ${run?.llmCalls}`);
  const inc = ctx.incidents.list({ project: "shop-front-prod" })[0]!;
  console.log(`رخداد ${inc.code}: ${inc.title} · ${inc.state} · علت احتمالی: ${inc.probableCause}`);
  const apr = ctx.approvals.get(inc.approvalId!)!;
  console.log(`پیشنهاد (${apr.risk}): ${apr.title} · هزینه: ${apr.cost?.hourlyToman ?? "نامشخص"} تومان/ساعت`);
  await agent.decide(apr.id, "approve", null, "demo-user");
  await agent.idle();
  const after = ctx.incidents.get(inc.id)!;
  console.log(`بعد از اقدام: ${after.state} · پلن فعلی: ${world.apps.get("shop-front-prod")!.planID}`);
  clock.advance(3 * 3600_000);
  const again = await patrol.runProject("shop-front-prod", "schedule", "slot-after");
  console.log(`پایش بعدی: ${again?.status} · فراخوانی مدل: ${again?.llmCalls}`);
}

async function scenarioGuards(): Promise<void> {
  console.log("\n══════ سناریو ۳: عملیات مخرب (L4) و قابلیت پشتیبانی‌نشده ══════");
  const del = await ctx.gateway.run({ capabilityId: "dbaas.deleteDatabase", req: { pathParams: { id: "db0001" } }, resource: "shop-db", title: "حذف دیتابیس shop-db", reason: "درخواست کاربر", effect: "همه‌ی داده‌ها پاک می‌شن" }, { actor: "agent", chatId: null, runId: null });
  if (del.status === "approval_required") {
    console.log(`حذف دیتابیس → نیاز به تأیید ${del.approval.risk} با تایپ «${del.approval.requiresTypedConfirmation}»`);
    try {
      ctx.approvals.decide(del.approval.id, "approve", "demo-user", "wrong-name");
    } catch (e) {
      console.log(`تأیید با نام اشتباه رد شد: ${(e as Error).message}`);
    }
  }
  const img = await ctx.gateway.run({ capabilityId: "paas.deployImage", req: {}, resource: "x", title: "deploy image", reason: "", effect: "" }, { actor: "agent", chatId: null, runId: null });
  console.log(`دپلوی Docker Image → ${img.status}${img.status === "denied" ? ` (${img.reason})` : ""}`);
  const healthy = await patrol.runProject("blog-wp", "manual", "x");
  console.log(`پایش سالم blog-wp: ${healthy?.status} · فراخوانی مدل: ${healthy?.llmCalls}`);
}

await scenarioDeploy();
await scenarioIncident();
await scenarioGuards();
const nonGet = transport.calls.filter((c) => c.method !== "GET").length;
console.log(`\n✔ پایان دمو · ${transport.calls.length} درخواست به Mock لیارا (${nonGet} تغییر) · ۰ درخواست واقعی`);
ctx.db.close();
