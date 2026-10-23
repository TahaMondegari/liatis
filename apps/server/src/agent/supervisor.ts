import { z } from "zod";

export type Intent =
  | "deploy"
  | "redeploy_latest"
  | "deploy_failure"
  | "diagnose"
  | "logs"
  | "rollback"
  | "domain"
  | "database"
  | "plan"
  | "list_projects"
  | "restart"
  | "auto_fix_policy"
  | "help"
  | "general";

const RULES: [Intent, RegExp][] = [
  ["deploy_failure", /چرا.*(دیپلوی|دپلوی|deploy|build).*(نمی|نشد|خطا|fail)|(دیپلوی|دپلوی|build).*(شکست|fail|نمی‌شه|نمیشه)/i],
  ["rollback", /rollback|رول‌?بک|برگرد(ون)?.*(نسخه|انتشار)|نسخه‌ی? قبل/i],
  ["redeploy_latest", /(آخرین|جدیدترین) (نسخه|تغییرات).*(دیپلوی|دپلوی|deploy)|redeploy|دوباره (دیپلوی|دپلوی)/i],
  ["deploy", /(دیپلوی|دپلوی|deploy|منتشر|راه‌اندازی|بالا بیار).*/i],
  ["diagnose", /کند|۵۰۰|\b500\b|5xx|ارور|خطا|\bRAM\b|رم|حافظه|\bCPU\b|پردازنده|سالم|سلامت|down|قطع|مشکل/i],
  ["logs", /لاگ|log/i],
  ["domain", /دامنه|domain|\b[a-z0-9-]+\.(ir|com|net|org|io|dev|app)\b/i],
  ["database", /دیتابیس|database|postgres|mysql|mongo|redis/i],
  ["plan", /پلن|هزینه|قیمت|موجودی|کیف پول|invoice|billing/i],
  ["restart", /ری‌?استارت|restart/i],
  ["auto_fix_policy", /کم‌?خطره.*خودت|خودت.*حل(ش)? کن/i],
  ["list_projects", /(پروژه|برنامه)(‌|\s)?(ها|های من)|list (apps|projects)/i],
  ["help", /^(سلام|کمک|help|چی کار (می‌?)?تونی)/i],
];

/** Deterministic Persian intent rules — no model call needed for common requests. */
export function classifyIntent(text: string): { intent: Intent; confident: boolean } {
  for (const [intent, re] of RULES) if (re.test(text)) return { intent, confident: true };
  return { intent: "general", confident: false };
}

export const IntentSchema = z.object({
  intent: z.enum(["deploy", "redeploy_latest", "deploy_failure", "diagnose", "logs", "rollback", "domain", "database", "plan", "list_projects", "restart", "auto_fix_policy", "help", "general"]),
  app: z.string().nullable(),
  domain: z.string().nullable(),
  wants_change: z.boolean(),
});

export function extractDomain(text: string): string | null {
  return /\b((?:[a-z0-9-]+\.)+(?:ir|com|net|org|io|dev|app|co|info|xyz|me))\b/i.exec(text)?.[1]?.toLowerCase() ?? null;
}

export function findAppMention(text: string, apps: string[]): string | null {
  const lower = text.toLowerCase();
  return apps.filter((a) => lower.includes(a.toLowerCase())).sort((a, b) => b.length - a.length)[0] ?? null;
}
