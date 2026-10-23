import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createContext, type CtxOverrides } from "../src/context.js";
import { Agent } from "../src/agent/agent.js";
import { DemoWorld } from "../src/demo/world.js";
import { MockTransport } from "../src/liara/mockTransport.js";
import { FakeClock } from "../src/util.js";

export function demoEnv(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "liara-agent-test-"));
  return loadConfig({ DEMO_MODE: "true", DATABASE_PATH: join(dir, "agent.sqlite"), SANDBOX_DRIVER: "docker", APPROVAL_TTL_MINUTES: "10", ...extra });
}

export function demoAgent(extra: Record<string, string> = {}, o: CtxOverrides = {}) {
  const cfg = demoEnv(extra);
  const clock = new FakeClock(Date.now());
  const world = new DemoWorld(clock);
  const transport = new MockTransport(world);
  const ctx = createContext(cfg, { clock, transport, ...o });
  const agent = new Agent(ctx);
  return { cfg, ctx, agent, world, transport, clock };
}

/** Minimal OpenAI-compatible fake for the LLM gateway. */
export function fakeLlmFetch(handler: (body: Record<string, unknown>, url: string) => { status?: number; json?: unknown; sse?: string[] }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const r = handler(body, url);
    if (r.sse) {
      const text = r.sse.map((d) => `data: ${d}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
