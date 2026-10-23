import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { Agent } from "./agent/agent.js";
import { Patrol } from "./monitor/patrol.js";
import { registerRoutes } from "./routes.js";
import { redactString } from "./security/redact.js";

const cfg = loadConfig();
const ctx = createContext(cfg);
const agent = new Agent(ctx);
agent.recover();
const patrol = new Patrol(agent);

const app = Fastify({
  logger: {
    level: cfg.logLevel,
    // Structured logs; request bodies are never logged and messages are redacted.
    hooks: { logMethod(args, method) { method.apply(this, args.map((a) => (typeof a === "string" ? redactString(a) : a)) as Parameters<typeof method>); } },
  },
  bodyLimit: 2 * 1024 * 1024,
  genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
});
await app.register(cors, { origin: cfg.webOrigins, credentials: true });
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });
registerRoutes(app, agent, patrol);

void ctx.models.refreshCatalog();
// In-process patrol by default; run `npm run patrol` for a separate worker (DB leases prevent double runs).
if (process.env.PATROL_IN_PROCESS !== "false") patrol.start(60_000);

await app.listen({ port: cfg.port, host: process.env.HOST ?? "127.0.0.1" });
app.log.info(`liara-deploy-agent listening on :${cfg.port} (${cfg.mode.toUpperCase()} MODE, liara transport=${ctx.transport.kind}, sandbox=${ctx.sandbox.kind}, ai=${ctx.llm.configured ? "configured" : "not configured"})`);

const shutdown = async () => {
  patrol.stop();
  await app.close();
  ctx.db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
