// Standalone patrol worker: `npm run patrol`. Safe alongside the API process — per-project DB leases.
import { loadConfig } from "../config.js";
import { createContext } from "../context.js";
import { Agent } from "../agent/agent.js";
import { Patrol } from "./patrol.js";

const ctx = createContext(loadConfig());
const patrol = new Patrol(new Agent(ctx));
patrol.start(60_000);
console.log(`[patrol] worker ${patrol.owner} started (${ctx.cfg.mode} mode, every ${ctx.cfg.monitorIntervalHours}h ±5m)`);
const stop = () => {
  patrol.stop();
  ctx.db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
