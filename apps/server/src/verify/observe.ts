import type { CheckStatus, DeltaRow, VerificationCheck } from "@liara-agent/shared";
import type { LiaraServices } from "../liara/services.js";
import { condenseLogs } from "../rca/rca.js";
import { faNum, iso } from "../util.js";
import type { Prober } from "./prober.js";

/** Default thresholds — configurable defaults, not universal truths (BRIEF §18.3). */
export const THRESHOLDS = {
  memoryWarnPct: 85,
  memoryCritPct: 90,
  cpuWarnPct: 85,
  latencyWarnMs: 1000,
  latencyRegressionFactor: 2,
  errorRateWarnPct: 5,
  restartsCrashLoop: 3,
  tlsWarnDays: 7,
};

export interface Snapshot {
  at: string;
  app: string;
  appUrl: string;
  release: { id: string | null; state: string | null; createdAt: string | null };
  applets: { name: string | null; state: string | null; reason: string | null }[];
  restarts: number;
  oomEvents: number;
  memoryPct: number | null;
  memoryBytes: number | null;
  cpuCores: number | null;
  cpuPct: number | null;
  planRamGb: number | null;
  planCpu: number | null;
  probes: { path: string; status: number | null; latencyMs: number | null; error: string | null }[];
  p50: number | null;
  p95: number | null;
  errorRatePct: number | null;
  logGroups: ReturnType<typeof condenseLogs>;
  tls: { host: string; daysLeft: number | null; error: string | null }[];
  dns: { host: string; ok: boolean; error: string | null }[];
  unavailable: string[];
}

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/**
 * Collects sanitized evidence for one app from L0 Liara reads + synthetic HTTP checks.
 * Whatever is not observable is listed in `unavailable` instead of being guessed.
 */
export async function snapshot(svc: LiaraServices, prober: Prober, app: string, opts: { healthPaths: string[]; planRamGb: number | null; planCpu: number | null; samples?: number; windowSec?: number; nowMs: number }): Promise<Snapshot> {
  const unavailable: string[] = [];
  const nowSec = Math.floor(opts.nowMs / 1000);
  const windowSec = opts.windowSec ?? 1800;
  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      unavailable.push(label);
      return fallback;
    }
  };
  const appUrl = `https://${app}.liara.run`;
  const [releases, applets, events, mem, cpu, logs, domains] = await Promise.all([
    safe("releases", () => svc.releases(app, 5), { current: null, releases: [] }),
    safe("applets", () => svc.applets(app), []),
    safe("events", () => svc.events(app), []),
    safe("memory", () => svc.metric(app, "memory", nowSec - windowSec), null),
    safe("cpu", () => svc.metric(app, "cpu", nowSec - windowSec), null),
    safe("logs", () => svc.logs(app, nowSec - windowSec), []),
    safe("domains", () => svc.domains(app), []),
  ]);
  const cur = releases.releases.find((r) => r.id === releases.current) ?? releases.releases[0] ?? null;
  const memLast = mem?.points.at(-1)?.v ?? null;
  const cpuLast = cpu?.points.at(-1)?.v ?? null;
  const memoryPct = memLast !== null && opts.planRamGb ? Math.round((memLast / (opts.planRamGb * 1024 ** 3)) * 100) : null;
  if (memLast !== null && memoryPct === null) unavailable.push("memory% (plan RAM unknown)");
  const cpuPct = cpuLast !== null && opts.planCpu ? Math.round((cpuLast / opts.planCpu) * 100) : null;
  const restartEvents = events.filter((e) => /restart|oom|kill|crash/i.test(`${e.type} ${e.detail}`));
  const oomEvents = events.filter((e) => /OOM|137/i.test(e.detail)).length + logs.filter((l) => /OOMKilled|exit code 137|heap out of memory/i.test(l.message)).length;

  const samples = opts.samples ?? 3;
  const probes: Snapshot["probes"] = [];
  for (const path of opts.healthPaths.slice(0, 4)) {
    for (let i = 0; i < samples; i++) {
      const r = await prober.http(appUrl + path);
      probes.push({ path, status: r.status, latencyMs: r.latencyMs, error: r.error });
    }
  }
  const lat = probes.map((p) => p.latencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const errs = probes.filter((p) => p.status === null || p.status >= 500).length;
  const hosts = [...new Set(domains.map((d) => d.name))].slice(0, 5);
  const tls = await Promise.all(hosts.map(async (h) => ({ host: h, ...(await prober.tlsDaysLeft(h)) })));
  const dns = await Promise.all([`${app}.liara.run`, ...hosts].map(async (h) => {
    const r = await prober.dns(h);
    return { host: h, ok: r.ok, error: r.error };
  }));
  return {
    at: new Date(opts.nowMs).toISOString(),
    app,
    appUrl,
    release: { id: cur?.id ?? null, state: cur?.state ?? null, createdAt: cur?.createdAt ?? null },
    applets,
    restarts: restartEvents.length,
    oomEvents,
    memoryPct,
    memoryBytes: memLast,
    cpuCores: cpuLast,
    cpuPct,
    planRamGb: opts.planRamGb,
    planCpu: opts.planCpu,
    probes,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    errorRatePct: probes.length ? Math.round((errs / probes.length) * 1000) / 10 : null,
    logGroups: condenseLogs(logs),
    tls,
    dns,
    unavailable,
  };
}

export function checksFrom(s: Snapshot, baseline: { p95: number | null } = { p95: null }): VerificationCheck[] {
  const at = iso();
  const c = (key: string, label: string, status: CheckStatus, value: string | null, threshold: string | null, evidence: string | null, base: string | null = null): VerificationCheck => ({ key, label, status, value, baseline: base, threshold, evidence, at });
  const out: VerificationCheck[] = [];
  out.push(
    c(
      "release",
      "وضعیت انتشار",
      s.release.state === null ? "NOT_AVAILABLE" : s.release.state === "READY" ? "PASS" : ["FAILED", "CANCELED", "TIMEOUT"].includes(s.release.state) ? "FAIL" : "WARN",
      s.release.state,
      "READY",
      s.release.id ? `release ${s.release.id}` : null,
    ),
  );
  const crash = s.applets.some((a) => /crash|backoff|error/i.test(a.state ?? ""));
  out.push(c("applets", "وضعیت و ری‌استارت‌ها", s.applets.length === 0 ? "NOT_AVAILABLE" : crash || s.restarts >= THRESHOLDS.restartsCrashLoop ? "FAIL" : s.restarts > 0 ? "WARN" : "PASS", `${faNum(s.restarts)} ری‌استارت`, `< ${faNum(THRESHOLDS.restartsCrashLoop)}`, s.applets.map((a) => `${a.name}:${a.state}${a.reason ? `(${a.reason})` : ""}`).join(", ") || null));
  const bad = s.probes.filter((p) => p.status === null || p.status >= 500);
  out.push(c("http", "باز شدن صفحه‌ها", s.probes.length === 0 ? "NOT_AVAILABLE" : bad.length === 0 ? "PASS" : bad.length === s.probes.length ? "FAIL" : "WARN", s.probes.length ? `${faNum(s.probes.length - bad.length)}/${faNum(s.probes.length)} موفق` : null, "بدون 5xx", bad.slice(0, 3).map((b) => `${b.path} → ${b.status ?? b.error}`).join("; ") || null));
  out.push(
    c(
      "latency",
      "تأخیر (p95)",
      s.p95 === null ? "NOT_AVAILABLE" : s.p95 > THRESHOLDS.latencyWarnMs || (baseline.p95 !== null && s.p95 > baseline.p95 * THRESHOLDS.latencyRegressionFactor) ? "WARN" : "PASS",
      s.p95 === null ? null : `${faNum(s.p95)}ms`,
      `${faNum(THRESHOLDS.latencyWarnMs)}ms`,
      `${s.probes.length} نمونه‌ی synthetic`,
      baseline.p95 === null ? null : `${faNum(Math.round(baseline.p95))}ms`,
    ),
  );
  out.push(c("memory", "حافظه", s.memoryPct === null ? "NOT_AVAILABLE" : s.memoryPct >= THRESHOLDS.memoryCritPct ? "FAIL" : s.memoryPct >= THRESHOLDS.memoryWarnPct ? "WARN" : "PASS", s.memoryPct === null ? null : `${faNum(s.memoryPct)}٪`, `${faNum(THRESHOLDS.memoryCritPct)}٪`, s.oomEvents ? `${s.oomEvents} رویداد OOM` : "paas.getAppMemoryReports"));
  out.push(c("cpu", "پردازنده", s.cpuPct === null ? "NOT_AVAILABLE" : s.cpuPct >= THRESHOLDS.cpuWarnPct ? "WARN" : "PASS", s.cpuPct === null ? null : `${faNum(s.cpuPct)}٪`, `${faNum(THRESHOLDS.cpuWarnPct)}٪`, "paas.getAppCpuReports"));
  const errGroups = s.logGroups.filter((g) => g.level === "error");
  out.push(c("logs", "ارورهای جدید لاگ", s.unavailable.includes("logs") ? "NOT_AVAILABLE" : errGroups.length ? "WARN" : "PASS", `${faNum(errGroups.reduce((a, g) => a + g.count, 0))} خطا در ${faNum(errGroups.length)} الگو`, "۰", errGroups[0]?.sample.slice(0, 160) ?? null));
  for (const t of s.tls) out.push(c(`tls:${t.host}`, `گواهی SSL ${t.host}`, t.daysLeft === null ? "WARN" : t.daysLeft < THRESHOLDS.tlsWarnDays ? "FAIL" : "PASS", t.daysLeft === null ? (t.error ?? null) : `${faNum(t.daysLeft)} روز`, `${faNum(THRESHOLDS.tlsWarnDays)} روز`, t.error));
  for (const d of s.dns.filter((x) => !x.ok)) out.push(c(`dns:${d.host}`, `DNS ${d.host}`, "FAIL", d.error, "resolve", d.error));
  return out;
}

export function overall(checks: VerificationCheck[]): "healthy" | "warning" | "unhealthy" {
  if (checks.some((c) => c.status === "FAIL")) return "unhealthy";
  if (checks.some((c) => c.status === "WARN")) return "warning";
  return "healthy";
}

/** Before/after comparison for verify-delta (BRIEF §16.1). */
export function delta(before: Snapshot, after: Snapshot): DeltaRow[] {
  const ms = (v: number | null) => (v === null ? null : `${faNum(Math.round(v))}ms`);
  const p = (v: number | null) => (v === null ? null : `${faNum(v)}٪`);
  const better = (b: number | null, a: number | null) => (b === null || a === null ? null : a < b);
  return [
    { label: "تأخیر (p95)", before: ms(before.p95), after: ms(after.p95), improved: better(before.p95, after.p95) },
    { label: "نرخ خطا", before: p(before.errorRatePct), after: p(after.errorRatePct), improved: before.errorRatePct === after.errorRatePct && after.errorRatePct === 0 ? true : better(before.errorRatePct, after.errorRatePct) },
    { label: "حافظه", before: p(before.memoryPct), after: p(after.memoryPct), improved: better(before.memoryPct, after.memoryPct) },
    { label: "پردازنده", before: p(before.cpuPct), after: p(after.cpuPct), improved: better(before.cpuPct, after.cpuPct) },
    { label: "الگوهای خطای لاگ", before: faNum(before.logGroups.filter((g) => g.level === "error").length), after: faNum(after.logGroups.filter((g) => g.level === "error").length), improved: after.logGroups.filter((g) => g.level === "error").length <= before.logGroups.filter((g) => g.level === "error").length },
  ];
}

/** A fix counts only if measurable signals improved (or nothing measurable got worse and errors are gone). */
export function deltaVerdict(rows: DeltaRow[]): "resolved" | "partial" | "not_resolved" | "unmeasurable" {
  const measured = rows.filter((r) => r.improved !== null);
  if (!measured.length) return "unmeasurable";
  const improved = measured.filter((r) => r.improved).length;
  if (improved === measured.length) return "resolved";
  return improved > 0 ? "partial" : "not_resolved";
}
