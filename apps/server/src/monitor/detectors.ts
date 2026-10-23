import type { FailureCategory, Hypothesis, Severity } from "@liara-agent/shared";
import { faNum } from "../util.js";
import { THRESHOLDS, type Snapshot } from "../verify/observe.js";

export interface Anomaly {
  kind: "oom" | "cpu" | "http_5xx" | "latency" | "crash_loop" | "db_conn" | "tls" | "dns" | "release_regression" | "release_failed" | "app_errors";
  severity: Severity;
  title: string;
  category: FailureCategory;
  signature: string;
  evidence: string[];
  metrics: { label: string; value: string; tone: "ok" | "warn" | "bad" }[];
  hypotheses: Hypothesis[];
}

export interface Baseline {
  p95: number | null;
  memoryPct: number | null;
  cpuPct: number | null;
  errorRatePct: number | null;
}

/**
 * Deterministic detectors (BRIEF §19). Pure functions of evidence — zero model
 * calls — so a healthy patrol costs nothing.
 */
export function detect(s: Snapshot, base: Baseline, opts: { releaseWindowMs?: number; nowMs: number }): Anomaly[] {
  const out: Anomaly[] = [];
  const metrics = (): Anomaly["metrics"] => [
    { label: "پردازنده", value: s.cpuPct === null ? "نامشخص" : `${faNum(s.cpuPct)}٪`, tone: s.cpuPct !== null && s.cpuPct >= THRESHOLDS.cpuWarnPct ? "bad" : "ok" },
    { label: "حافظه", value: s.memoryPct === null ? "نامشخص" : `${faNum(s.memoryPct)}٪`, tone: s.memoryPct !== null && s.memoryPct >= THRESHOLDS.memoryCritPct ? "bad" : s.memoryPct !== null && s.memoryPct >= THRESHOLDS.memoryWarnPct ? "warn" : "ok" },
    { label: "تأخیر p95", value: s.p95 === null ? "نامشخص" : `${faNum(s.p95)}ms`, tone: s.p95 !== null && s.p95 > THRESHOLDS.latencyWarnMs ? "warn" : "ok" },
    { label: "نرخ خطا", value: s.errorRatePct === null ? "نامشخص" : `${faNum(s.errorRatePct)}٪`, tone: s.errorRatePct !== null && s.errorRatePct >= THRESHOLDS.errorRateWarnPct ? "bad" : "ok" },
  ];
  const errLogs = s.logGroups.filter((g) => g.level === "error");
  const logHas = (re: RegExp) => errLogs.filter((g) => re.test(g.sample));
  const newRelease = s.release.createdAt !== null && opts.nowMs - Date.parse(s.release.createdAt) < (opts.releaseWindowMs ?? 2 * 3600_000);

  // Out-of-memory / memory pressure
  if (s.oomEvents > 0 || (s.memoryPct !== null && s.memoryPct >= THRESHOLDS.memoryCritPct)) {
    out.push({
      kind: "oom",
      severity: s.oomEvents >= 3 ? "HIGH" : "MEDIUM",
      title: s.oomEvents ? `برنامه ${faNum(s.oomEvents)} بار به‌خاطر کمبود حافظه بسته شد` : "حافظه از حد هشدار رد شد",
      category: "MEMORY_PRESSURE",
      signature: "oom",
      evidence: [s.memoryPct !== null ? `مصرف حافظه ${faNum(s.memoryPct)}٪ از ${s.planRamGb ?? "?"}GB` : "", ...logHas(/OOM|137|heap/i).map((g) => `${g.sample.slice(0, 120)} ×${g.count}`)].filter(Boolean),
      metrics: metrics(),
      hypotheses: [
        { title: "حافظه تقریباً پر شده", confidence: s.oomEvents ? 0.78 : 0.55, category: "MEMORY_PRESSURE", evidence: [`${s.oomEvents} رویداد OOM`] },
        { title: "نشت حافظه بعد از انتشار جدید", confidence: newRelease ? 0.2 : 0.08, category: "CODE_DEFECT", evidence: newRelease ? ["انتشار جدید در ۲ ساعت اخیر"] : [] },
        { title: "افزایش ناگهانی ترافیک", confidence: 0.07, category: "UNKNOWN", evidence: [] },
      ],
    });
  }
  // CPU saturation
  if (s.cpuPct !== null && s.cpuPct >= THRESHOLDS.cpuWarnPct && !out.some((a) => a.kind === "oom")) {
    out.push({ kind: "cpu", severity: "MEDIUM", title: "پردازنده اشباع شده", category: "CPU_SATURATION", signature: "cpu", evidence: [`پردازنده ${faNum(s.cpuPct)}٪`], metrics: metrics(), hypotheses: [{ title: "پلن برای بار فعلی کوچیکه", confidence: 0.6, category: "CPU_SATURATION", evidence: [] }] });
  }
  // Crash loop
  const crashing = s.applets.some((a) => /crash|backoff/i.test(a.state ?? ""));
  if ((crashing || s.restarts >= THRESHOLDS.restartsCrashLoop) && !out.some((a) => a.kind === "oom")) {
    out.push({
      kind: "crash_loop",
      severity: "HIGH",
      title: "ری‌استارت‌های پشت‌سرهم",
      category: logHas(/EADDRINUSE|port/i).length ? "PORT_BINDING" : "CRASH_LOOP",
      signature: `crash:${errLogs[0]?.signature ?? "none"}`,
      evidence: [`${faNum(s.restarts)} ری‌استارت`, ...s.applets.map((a) => `${a.name}: ${a.state}`), ...errLogs.slice(0, 2).map((g) => g.sample.slice(0, 120))],
      metrics: metrics(),
      hypotheses: [{ title: logHas(/EADDRINUSE/i).length ? "تداخل پورت" : "خطای زمان راه‌اندازی", confidence: 0.6, category: logHas(/EADDRINUSE/i).length ? "PORT_BINDING" : "CRASH_LOOP", evidence: errLogs.slice(0, 1).map((g) => g.sample.slice(0, 120)) }],
    });
  }
  // Database connectivity
  const db = logHas(/ECONNREFUSED [\d.]+:(5432|3306|27017|6379)|could not connect|P1001/i);
  if (db.length) {
    out.push({ kind: "db_conn", severity: "HIGH", title: "اتصال به دیتابیس قطع شده", category: "DATABASE_CONNECTIVITY", signature: `db:${db[0]!.signature}`, evidence: db.map((g) => `${g.sample.slice(0, 140)} ×${g.count}`), metrics: metrics(), hypotheses: [{ title: "دیتابیس خاموش یا در دسترس نیست", confidence: 0.6, category: "DATABASE_CONNECTIVITY", evidence: [] }, { title: "DATABASE_URL اشتباهه", confidence: 0.3, category: "CONFIG_ENV", evidence: [] }] });
  }
  // HTTP 5xx
  if (s.errorRatePct !== null && s.errorRatePct >= THRESHOLDS.errorRateWarnPct && !out.some((a) => ["oom", "db_conn", "crash_loop"].includes(a.kind))) {
    const regression = newRelease && (base.errorRatePct ?? 0) < THRESHOLDS.errorRateWarnPct;
    out.push({
      kind: regression ? "release_regression" : "http_5xx",
      severity: s.errorRatePct >= 50 ? "CRITICAL" : "HIGH",
      title: regression ? "بعد از انتشار جدید خطای ۵۰۰ زیاد شده" : "خطای ۵۰۰ در پاسخ‌ها",
      category: regression ? "CODE_DEFECT" : "CODE_DEFECT",
      signature: `5xx:${errLogs[0]?.signature ?? "none"}`,
      evidence: [`نرخ خطا ${faNum(s.errorRatePct)}٪`, ...s.probes.filter((p) => (p.status ?? 500) >= 500).slice(0, 3).map((p) => `${p.path} → ${p.status ?? p.error}`), ...errLogs.slice(0, 2).map((g) => g.sample.slice(0, 160))],
      metrics: metrics(),
      hypotheses: [{ title: regression ? "باگ در انتشار جدید" : "خطای کد در مسیر درخواست", confidence: regression ? 0.7 : 0.5, category: "CODE_DEFECT", evidence: errLogs.slice(0, 1).map((g) => g.sample.slice(0, 120)) }],
    });
  }
  // Latency regression
  if (s.p95 !== null && (s.p95 > THRESHOLDS.latencyWarnMs * 2 || (base.p95 !== null && s.p95 > base.p95 * THRESHOLDS.latencyRegressionFactor && s.p95 > THRESHOLDS.latencyWarnMs)) && !out.some((a) => a.kind === "oom")) {
    const slow = logHas(/slow query/i);
    out.push({ kind: "latency", severity: "MEDIUM", title: "سایت کند شده", category: slow.length ? "DATABASE_CONNECTIVITY" : "UNKNOWN", signature: "latency", evidence: [`p95 ${faNum(s.p95)}ms${base.p95 ? ` (معمول ${faNum(Math.round(base.p95))}ms)` : ""}`, ...slow.map((g) => g.sample.slice(0, 120))], metrics: metrics(), hypotheses: [{ title: slow.length ? "کوئری کند دیتابیس" : "کمبود منابع یا وابستگی کند", confidence: slow.length ? 0.55 : 0.3, category: slow.length ? "DATABASE_CONNECTIVITY" : "UNKNOWN", evidence: [] }] });
  }
  // Failed release
  if (s.release.state && ["FAILED", "TIMEOUT"].includes(s.release.state)) {
    out.push({ kind: "release_failed", severity: "HIGH", title: "آخرین انتشار ناموفق بود", category: "BUILD_CONFIGURATION", signature: `release:${s.release.id}`, evidence: [`release ${s.release.id} → ${s.release.state}`], metrics: metrics(), hypotheses: [] });
  }
  // TLS / DNS
  for (const t of s.tls) if (t.daysLeft !== null && t.daysLeft < THRESHOLDS.tlsWarnDays) out.push({ kind: "tls", severity: t.daysLeft < 2 ? "HIGH" : "MEDIUM", title: `گواهی SSL ${t.host} تا ${faNum(t.daysLeft)} روز دیگه تموم می‌شه`, category: "TLS_DNS", signature: `tls:${t.host}`, evidence: [`${t.daysLeft} روز`], metrics: [], hypotheses: [] });
  for (const d of s.dns.filter((x) => !x.ok)) out.push({ kind: "dns", severity: "HIGH", title: `دامنه‌ی ${d.host} resolve نمی‌شه`, category: "TLS_DNS", signature: `dns:${d.host}`, evidence: [d.error ?? "resolve failed"], metrics: [], hypotheses: [] });
  // New application errors with no other anomaly
  if (!out.length && errLogs.length && errLogs.reduce((a, g) => a + g.count, 0) >= 5) {
    out.push({ kind: "app_errors", severity: "LOW", title: "ارورهای جدید در لاگ برنامه", category: "CODE_DEFECT", signature: `logs:${errLogs[0]!.signature}`, evidence: errLogs.slice(0, 3).map((g) => `${g.sample.slice(0, 140)} ×${g.count}`), metrics: metrics(), hypotheses: [] });
  }
  return out;
}

export const SEVERITY_FA: Record<Severity, string> = { LOW: "پایین", MEDIUM: "متوسط", HIGH: "بالا", CRITICAL: "بحرانی" };
