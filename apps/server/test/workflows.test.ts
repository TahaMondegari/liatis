import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject } from "../src/analyzer/analyzer.js";
import { classify, errorSignature, condenseLogs } from "../src/rca/rca.js";
import { REPO_ROOT } from "../src/context.js";
import { Patrol } from "../src/monitor/patrol.js";
import { savePatrolSettings, type DeployState } from "../src/agent/deployFlow.js";
import { LlmGateway } from "../src/ai/gateway.js";
import { loadModelsConfig, ModelRegistry } from "../src/ai/models.js";
import { Db } from "../src/db/db.js";
import { FakeClock } from "../src/util.js";
import { z } from "zod";
import { demoAgent, fakeLlmFetch } from "./helpers.js";

const SAMPLE = join(REPO_ROOT, "samples", "shop-next");

describe("project analyzer", () => {
  it("detects Next.js, commands, env, database and routes with evidence", () => {
    const p = analyzeProject(SAMPLE);
    expect(p.liaraPlatform.value).toBe("next");
    expect(p.commands.build?.value).toBe("npm run build");
    expect(p.commands.test?.value).toBe("npm test");
    expect(p.commands.install?.value).toBe("npm ci");
    expect(p.envVars.find((e) => e.key === "DATABASE_URL")?.required).toBe(true);
    expect(p.database?.value).toBe("postgres");
    expect(p.routes).toContain("/api/health");
    expect(p.lockfileIssues).toEqual([]);
  });
});

describe("root-cause classification", () => {
  it("classifies common failures deterministically with stable signatures", () => {
    expect(classify("Error: DATABASE_URL is not defined\n at connect (src/db.ts:12:9)").category).toBe("CONFIG_ENV");
    expect(classify("Error: connect ECONNREFUSED 10.0.0.5:5432").category).toBe("DATABASE_CONNECTIVITY");
    expect(classify("Container restarted (exit code 137) OOMKilled").category).toBe("MEMORY_PRESSURE");
    expect(classify("Module not found: Can't resolve './missing'").category).toBe("DEPENDENCY");
    const c = classify("AssertionError: expected '01200' to equal 1200\n at total (src/cart.ts:26:31)");
    expect(c.frames[0]).toMatchObject({ file: "src/cart.ts", line: 26 });
    expect(errorSignature("Error: connect ECONNREFUSED 10.0.0.5:5432 after 1840ms")).toBe(errorSignature("Error: connect ECONNREFUSED 10.0.0.9:5432 after 22ms"));
    const groups = condenseLogs([{ datetime: "a", message: "Error: x 1" }, { datetime: "b", message: "Error: x 2" }, { datetime: "c", message: "GET / 200" }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(2);
  });
});

describe("LLM gateway", () => {
  const mk = (handler: Parameters<typeof fakeLlmFetch>[0], budget = 0) => {
    const db = new Db(":memory:");
    const reg = new ModelRegistry(loadModelsConfig(), db);
    return { db, gw: new LlmGateway(reg, db, new FakeClock(), { baseUrl: "https://ai.example/api/ws/v1", apiKey: "k_123456", dailyBudgetToman: budget, runBudgetToman: 0, fetchImpl: fakeLlmFetch(handler) }) };
  };

  it("routes by role, falls back after failures, records usage and Toman cost", async () => {
    const seen: string[] = [];
    const { gw, db } = mk((body) => {
      seen.push(String(body.model));
      if (body.model === "openai/gpt-6-sol") return { status: 503, json: { error: "down" } };
      return { json: { choices: [{ message: { content: '{"answer":"ok"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_cost_toman: 12.5 } } };
    });
    const r = await gw.chat({ role: "root_cause_analysis", schema: z.object({ answer: z.string() }), messages: [{ role: "user", content: "x" }] });
    expect(r.model).toBe("gpt-6.1-sol");
    expect(r.parsed.answer).toBe("ok");
    expect(seen.filter((m) => m === "openai/gpt-6-sol").length).toBe(3);
    expect(gw.spentTodayToman()).toBe(12.5);
    expect(Number(db.get<{ n: number }>("SELECT COUNT(*) n FROM model_calls WHERE ok = 0")!.n)).toBe(3);
  });

  it("never uses a model outside the allow-list and never astra for classification", () => {
    const { gw } = mk(() => ({ json: {} }));
    expect(gw.chain("simple_classification")).not.toContain("gpt-6-astra");
    for (const role of ["coding", "escalation", "embeddings"] as const) for (const m of gw.chain(role)) expect(m).toMatch(/^(gpt-|text-embedding-)/);
  });

  it("streams deltas and assembles tool calls", async () => {
    const { gw } = mk(() => ({
      sse: [
        JSON.stringify({ choices: [{ delta: { content: "سلام" } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "liara_app", arguments: '{"action":' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"list"}' } }] } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_cost_toman: 1 } }),
      ],
    }));
    const deltas: string[] = [];
    const r = await gw.chat({ role: "operations_chat", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "liara_app", description: "", parameters: {} } }], onDelta: (d) => deltas.push(d) });
    expect(deltas.join("")).toBe("سلام");
    expect(r.toolCalls[0]!.function).toEqual({ name: "liara_app", arguments: '{"action":"list"}' });
  });

  it("enforces the daily budget", async () => {
    const { gw } = mk(() => ({ json: { choices: [{ message: { content: "x" } }], usage: { total_cost_toman: 100 } } }), 50);
    await gw.chat({ role: "daily_digest", messages: [{ role: "user", content: "x" }] });
    await expect(gw.chat({ role: "daily_digest", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});

describe("patrol + incidents", () => {
  it("healthy patrol makes zero LLM calls and each slot runs once", async () => {
    const { ctx, agent } = demoAgent();
    const patrol = new Patrol(agent);
    savePatrolSettings(agent.kit, "shop-front-prod", { enabled: true });
    const r = await patrol.runProject("shop-front-prod", "schedule", "slot-1");
    expect(r!.status).toBe("healthy");
    expect(r!.llmCalls).toBe(0);
    expect(await patrol.runProject("shop-front-prod", "schedule", "slot-1")).toBeNull();
    expect(ctx.incidents.list()).toHaveLength(0);
  });

  it("OOM creates one deduplicated incident with an approval-gated plan upgrade, then verify-delta resolves it", async () => {
    const { ctx, agent, world, transport } = demoAgent();
    world.setScenario("shop-front-prod", "oom");
    const patrol = new Patrol(agent);
    savePatrolSettings(agent.kit, "shop-front-prod", { enabled: true });
    const r1 = await patrol.runProject("shop-front-prod", "schedule", "s1");
    expect(r1!.status).toBe("unhealthy");
    await patrol.runProject("shop-front-prod", "schedule", "s2");
    const incs = ctx.incidents.list();
    expect(incs).toHaveLength(1);
    expect(incs[0]!.occurrences).toBe(2);
    expect(incs[0]!.state).toBe("WAITING_FOR_APPROVAL");
    const apr = ctx.approvals.get(incs[0]!.approvalId!)!;
    expect(apr.capabilityId).toBe("paas.changePlan");
    expect(apr.risk).toBe("L3");
    expect(transport.calls.some((c) => c.opId === "paas.changePlan")).toBe(false);
    await agent.decide(apr.id, "approve", null, "user");
    await agent.idle();
    expect(world.apps.get("shop-front-prod")!.planID).toBe("demo-uranus");
    expect(ctx.incidents.get(incs[0]!.id)!.state).toBe("RESOLVED");
  });

  it("only one worker holds the per-project lease", async () => {
    const { agent, ctx, clock } = demoAgent();
    savePatrolSettings(agent.kit, "blog-wp", { enabled: true });
    ctx.db.run("UPDATE patrol_settings SET next_run_at = ? WHERE project_name = 'blog-wp'", new Date(clock.now().getTime() - 1000).toISOString());
    const [a, b] = [new Patrol(agent), new Patrol(agent)];
    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    expect(ra + rb).toBe(1);
  });
});

describe("end-to-end deploy (demo mode, mock Liara)", () => {
  it("analyzes, gates, patches the deploy copy only, asks approval, deploys, verifies", async () => {
    const { ctx, agent, transport } = demoAgent();
    const chat = agent.chat.create();
    await agent.userMessage(chat.id, "این پروژه Next.js رو روی لیارا دپلوی کن. حدود ۵۰۰۰ کاربر همزمان داره");
    await agent.idle();
    const nextCard = () => {
      for (const m of agent.chat.messages(chat.id).reverse()) for (const b of m.blocks) if (b.type === "ask" && b.card.state === "pending") return b.card;
      return null;
    };
    const answer = async (v: unknown) => {
      const c = nextCard();
      if (!c) throw new Error("no pending card");
      await agent.answer(chat.id, c.id, v);
      await agent.idle();
      return c;
    };
    expect(nextCard()?.key).toBe("source");
    await answer({ kind: "sample" });
    expect(nextCard()?.key).toBe("platform");
    await answer("next");
    await answer("demo");
    expect(nextCard()?.key).toBe("users");
    await answer(5000);
    await answer("shop-new");
    expect(nextCard()?.key).toBe("database");
    await answer("new");
    await answer({ choice: "no" });
    expect(nextCard()?.key).toBe("plan");
    const planCard = nextCard()!;
    expect(planCard.plans!.find((p) => p.recommended)!.price.status).toBe("from_api");
    const run = agent.runs.activeForChat<DeployState>(chat.id)!;
    const ws = ctx.workspaces.get(run.state.workspaceId!)!;
    const originalBefore = ctx.workspaces.treeHash(ws.originalPath);
    await answer(planCard.defaultValue);
    // gate failed on the cart test → RCA → rule-based patch proposal
    const blocks = agent.chat.messages(chat.id).flatMap((m) => m.blocks);
    expect(blocks.some((b) => b.type === "gate" && b.report.overall === "FAIL")).toBe(true);
    expect(blocks.some((b) => b.type === "root_cause" && b.report.location?.file === "src/cart.ts")).toBe(true);
    const patch = blocks.find((b) => b.type === "patch");
    expect(patch && patch.type === "patch" && patch.files[0]!.diff).toContain("Number(i.price)");
    expect(nextCard()?.key).toBe("patch");
    await answer("apply");
    expect(ctx.workspaces.treeHash(ws.originalPath)).toBe(originalBefore);
    // remaining failure is pre-existing → user must accept the risk explicitly
    expect(nextCard()?.key).toBe("acceptIssues");
    await answer("accept");
    const invoice = nextCard()!;
    expect(invoice.kind).toBe("invoice");
    expect(transport.world.mutations).toEqual([]);
    await agent.approveInvoice(chat.id, invoice.id, "user");
    await agent.idle();
    const ops = transport.world.mutations;
    expect(ops).toEqual(expect.arrayContaining(["paas.createApp", "dbaas.createDatabase", "paas.updateEnvs", "paas.sourcesDeploy", "paas.releasesDeploy"]));
    expect(ops.indexOf("paas.createApp")).toBeLessThan(ops.indexOf("paas.releasesDeploy"));
    const all = agent.chat.messages(chat.id).flatMap((m) => m.blocks);
    expect(all.some((b) => b.type === "success" && b.url === "https://shop-new.liara.run")).toBe(true);
    expect(nextCard()?.key).toBe("patrol");
    // secrets never in messages, events or audit
    const dump = JSON.stringify([agent.chat.messages(chat.id), ctx.db.all("SELECT * FROM events"), ctx.db.all("SELECT * FROM audit"), ctx.db.all("SELECT args_json FROM approvals")]);
    expect(dump).not.toContain("demo-root-password");
    await answer("on");
    expect(agent.runs.get(run.id)!.status).toBe("completed");
  }, 30_000);

  it("unsupported source (docker image) shows a limitation card and mutates nothing", async () => {
    const { agent, transport } = demoAgent();
    const chat = agent.chat.create();
    await agent.userMessage(chat.id, "دیپلوی کن");
    await agent.idle();
    const card = agent.chat.messages(chat.id).flatMap((m) => m.blocks).find((b) => b.type === "ask")!;
    if (card.type !== "ask") throw new Error();
    await agent.answer(chat.id, card.card.id, { kind: "image" });
    await agent.idle();
    expect(agent.chat.messages(chat.id).flatMap((m) => m.blocks).some((b) => b.type === "limitation" && b.capabilityId === "paas.deployImage")).toBe(true);
    expect(transport.world.mutations).toEqual([]);
  });

  it("diagnosis request on a healthy app answers without an incident", async () => {
    const { agent, ctx } = demoAgent();
    const chat = agent.chat.create();
    await agent.userMessage(chat.id, "ببین blog-wp سالمه یا نه");
    await agent.idle();
    expect(ctx.incidents.list()).toHaveLength(0);
    expect(agent.chat.messages(chat.id).at(-1)!.text).toContain("مشکلی پیدا نکردم");
  });
});
