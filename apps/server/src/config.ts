import { z } from "zod";
import { resolve } from "node:path";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().finite());
const str = () =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? v.trim() : null));

const EnvSchema = z.object({
  DEMO_MODE: bool(true),
  LIARA_API_TOKEN: str(),
  LIARA_TEAM_ID: str(),
  LIARA_FILEBROWSER_URL: str(),
  LIARA_DB_INSPECTOR_URL: str(),
  AI_API_BASE_URL: str(),
  AI_API_KEY: str(),
  AI_WORKSPACE_ID: str(),
  AI_DAILY_BUDGET_TOMAN: num(0),
  AI_RUN_BUDGET_TOMAN: num(0),
  AI_DAILY_BUDGET_USD: num(0),
  PORT: num(8787),
  WEB_ORIGIN: z.string().optional().default("http://localhost:3000,http://localhost:3100"),
  DATABASE_PATH: z.string().optional().default("./data/agent.sqlite"),
  LOG_LEVEL: z.string().optional().default("info"),
  APP_AUTH_TOKEN: str(),
  MONITOR_INTERVAL_HOURS: num(3),
  MAX_AUTO_REPAIR_ATTEMPTS: num(3),
  APPROVAL_TTL_MINUTES: num(10),
  SANDBOX_DRIVER: z.enum(["docker", "disabled"]).optional().default("docker"),
  SANDBOX_IMAGE_NODE: z.string().optional().default("node:22-bookworm-slim"),
  SANDBOX_IMAGE_PYTHON: z.string().optional().default("python:3.12-slim"),
  SANDBOX_CPU: z.string().optional().default("1"),
  SANDBOX_MEMORY: z.string().optional().default("1g"),
  SANDBOX_TIMEOUT_SECONDS: num(600),
  SANDBOX_INSTALL_NETWORK: bool(true),
  TELEGRAM_BOT_TOKEN: str(),
  TELEGRAM_CHAT_ID: str(),
  NOTIFY_MAIL_SERVER_ID: str(),
  NOTIFY_MAIL_FROM: str(),
  NOTIFY_MAIL_TO: str(),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.parse(env);
  // Hard repair cap (BRIEF §12.1): default 3, operator may raise to at most 5.
  const maxRepair = Math.min(Math.max(1, Math.trunc(parsed.MAX_AUTO_REPAIR_ATTEMPTS)), 5);
  const mode = parsed.DEMO_MODE ? ("demo" as const) : ("real" as const);
  if (mode === "real" && !parsed.LIARA_API_TOKEN) {
    throw new Error("DEMO_MODE=false requires LIARA_API_TOKEN. Set it in .env or enable DEMO_MODE.");
  }
  return {
    mode,
    liara: {
      token: parsed.LIARA_API_TOKEN,
      teamId: parsed.LIARA_TEAM_ID,
      fileBrowserUrl: parsed.LIARA_FILEBROWSER_URL,
      dbInspectorUrl: parsed.LIARA_DB_INSPECTOR_URL,
    },
    ai: {
      baseUrl: parsed.AI_API_BASE_URL,
      apiKey: parsed.AI_API_KEY,
      workspaceId: parsed.AI_WORKSPACE_ID ?? workspaceFromBaseUrl(parsed.AI_API_BASE_URL),
      dailyBudgetToman: parsed.AI_DAILY_BUDGET_TOMAN,
      runBudgetToman: parsed.AI_RUN_BUDGET_TOMAN,
      dailyBudgetUsd: parsed.AI_DAILY_BUDGET_USD,
    },
    port: parsed.PORT,
    webOrigins: parsed.WEB_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
    webOrigin: parsed.WEB_ORIGIN.split(",")[0]!.trim(),
    databasePath: resolve(parsed.DATABASE_PATH),
    logLevel: parsed.LOG_LEVEL,
    authToken: parsed.APP_AUTH_TOKEN,
    monitorIntervalHours: parsed.MONITOR_INTERVAL_HOURS,
    maxRepairAttempts: maxRepair,
    approvalTtlMinutes: parsed.APPROVAL_TTL_MINUTES,
    sandbox: {
      driver: parsed.SANDBOX_DRIVER,
      imageNode: parsed.SANDBOX_IMAGE_NODE,
      imagePython: parsed.SANDBOX_IMAGE_PYTHON,
      cpu: parsed.SANDBOX_CPU,
      memory: parsed.SANDBOX_MEMORY,
      timeoutSeconds: parsed.SANDBOX_TIMEOUT_SECONDS,
      installNetwork: parsed.SANDBOX_INSTALL_NETWORK,
    },
    telegram: { token: parsed.TELEGRAM_BOT_TOKEN, chatId: parsed.TELEGRAM_CHAT_ID },
    notifyMail: { serverId: parsed.NOTIFY_MAIL_SERVER_ID, from: parsed.NOTIFY_MAIL_FROM, to: parsed.NOTIFY_MAIL_TO },
  };
}

function workspaceFromBaseUrl(url: string | null): string | null {
  if (!url) return null;
  const m = /\/api\/([^/]+)\/v1\/?$/.exec(url);
  return m?.[1] ?? null;
}
