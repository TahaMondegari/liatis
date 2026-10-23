import type { CheckStatus, GateReport, StepView } from "@liara-agent/shared";
import type { ProjectProfile } from "../analyzer/analyzer.js";
import type { AppConfig } from "../config.js";
import { toArgv, type Sandbox } from "../sandbox/sandbox.js";
import { faNum, iso } from "../util.js";

export interface StageResult extends StepView {
  exitCode: number | null;
  output: string;
  durationMs: number;
  failingTests: string[];
}

export interface GateRun {
  report: GateReport;
  stages: StageResult[];
  failures: StageResult[];
}

const STAGES: { key: keyof ProjectProfile["commands"] | "manifest" | "health"; label: string; required: boolean }[] = [
  { key: "manifest", label: "بررسی مانیفست و lockfile", required: true },
  { key: "install", label: "نصب وابستگی‌ها", required: true },
  { key: "lint", label: "بررسی کد (lint)", required: false },
  { key: "typecheck", label: "بررسی تایپ‌ها", required: false },
  { key: "build", label: "build", required: true },
  { key: "test", label: "تست‌ها", required: true },
  { key: "health", label: "اجرا و بررسی صفحه‌ها", required: false },
];

/**
 * Pre-deployment QualityGate (BRIEF §11). Commands come only from the
 * ProjectProfile (manifests); missing commands are NOT_APPLICABLE, never guessed.
 * Runs on a scratch copy; the original repository is never touched.
 */
export class QualityGate {
  constructor(
    private sandbox: Sandbox,
    private cfg: AppConfig["sandbox"],
  ) {}

  image(profile: ProjectProfile): string {
    return ["django", "flask", "python"].includes(profile.liaraPlatform.value) ? this.cfg.imagePython : this.cfg.imageNode;
  }

  async run(dir: string, profile: ProjectProfile, onStage: (s: StageResult) => void, opts: { previousFailingTests?: string[] } = {}): Promise<GateRun> {
    const avail = await this.sandbox.available();
    const stages: StageResult[] = [];
    let blocked = false;
    for (const st of STAGES) {
      const base: StageResult = { key: st.key, label: st.label, status: "RUNNING", detail: null, startedAt: iso(), finishedAt: null, command: null, exitCode: null, output: "", durationMs: 0, failingTests: [] };
      onStage(base);
      let r: StageResult;
      if (st.key === "manifest") {
        r = {
          ...base,
          // Drift is a warning here; `npm ci` in the install stage is the authoritative failure.
          status: profile.lockfileIssues.length ? "WARN" : "PASS",
          detail: profile.lockfileIssues.join(" ") || "مانیفست‌ها خوانا و سازگار هستن.",
        };
      } else if (!avail.ok) {
        r = { ...base, status: "NOT_AVAILABLE", detail: avail.reason };
      } else if (blocked) {
        r = { ...base, status: "SKIPPED", detail: "به‌خاطر شکست مرحله‌ی قبل اجرا نشد." };
      } else if (st.key === "health") {
        r = await this.health(dir, profile, base);
      } else {
        const cmd = profile.commands[st.key];
        if (!cmd) {
          r = { ...base, status: "NOT_APPLICABLE", detail: "دستوری برای این مرحله در مانیفست پروژه تعریف نشده." };
        } else {
          let argv: string[];
          try {
            argv = toArgv(cmd.value);
          } catch (e) {
            r = { ...base, status: "NOT_AVAILABLE", command: cmd.value, detail: `دستور «${cmd.value}» در فهرست مجاز sandbox نیست.` };
            stages.push(r);
            onStage(r);
            continue;
          }
          const res = await this.sandbox.run({ dir, image: this.image(profile), argv, network: st.key === "install" && this.cfg.installNetwork, timeoutMs: this.cfg.timeoutSeconds * 1000 });
          const failingTests = st.key === "test" ? parseFailingTests(res.output) : [];
          const status: CheckStatus = res.timedOut ? "FAIL" : res.exitCode === 0 ? "PASS" : st.required ? "FAIL" : "WARN";
          r = {
            ...base,
            command: cmd.value,
            status,
            exitCode: res.exitCode,
            output: res.output,
            durationMs: res.durationMs,
            failingTests,
            detail: res.timedOut ? "زمان اجرا تموم شد." : status === "PASS" ? null : summarize(st.key, res.output, failingTests, opts.previousFailingTests ?? []),
          };
          if (status === "FAIL" && (st.key === "install" || st.key === "build")) blocked = true;
        }
      }
      r.finishedAt = iso();
      stages.push(r);
      onStage(r);
    }
    const failures = stages.filter((s) => s.status === "FAIL");
    const testStage = stages.find((s) => s.key === "test");
    const prev = new Set(opts.previousFailingTests ?? []);
    const blocks = failureBlocks(testStage?.output ?? "");
    const preexisting = (testStage?.failingTests ?? []).filter((t) => prev.has(t) || /pre-existing/.test(blocks.get(t) ?? ""));
    const overall: CheckStatus = failures.length ? "FAIL" : stages.some((s) => s.status === "WARN" || s.status === "NOT_AVAILABLE") ? "WARN" : "PASS";
    const coverageNotes: string[] = [];
    const health = stages.find((s) => s.key === "health");
    if (health?.detail && health.status !== "PASS") coverageNotes.push(health.detail);
    if (!avail.ok) coverageNotes.push(avail.reason ?? "");
    return {
      report: {
        overall,
        stages: stages.map(({ output: _o, exitCode: _e, durationMs: _d, failingTests: _f, ...v }) => v),
        coverageNotes,
        preexistingFailures: preexisting,
        sandbox: this.sandbox.label,
      },
      stages,
      failures,
    };
  }

  private async health(dir: string, profile: ProjectProfile, base: StageResult): Promise<StageResult> {
    const start = profile.commands.start;
    if (!start) return { ...base, status: "NOT_APPLICABLE", detail: "دستور start تعریف نشده." };
    let argv: string[];
    try {
      argv = toArgv(start.value);
    } catch {
      return { ...base, status: "NOT_AVAILABLE", detail: `دستور «${start.value}» در فهرست مجاز نیست.` };
    }
    const paths = [...new Set([...profile.healthPaths, ...profile.routes.filter((r) => r.startsWith("/") && !r.includes("[")).slice(0, 4)])];
    const probe = await this.sandbox.startAndProbe({ dir, image: this.image(profile), argv, network: false, timeoutMs: 60_000, port: Number(profile.port.value) || 3000, paths });
    const bad = probe.checks.filter((c) => c.status === null || c.status >= 500);
    const untested = probe.checks.filter((c) => c.error && /database/.test(c.error));
    return {
      ...base,
      command: `${start.value} · GET ${paths.join(" ")}`,
      status: !probe.started ? "FAIL" : bad.length > untested.length ? "FAIL" : untested.length ? "WARN" : "PASS",
      output: probe.logs,
      detail: untested.length ? `پوشش ناقص: ${untested.map((u) => u.path).join("، ")} به دیتابیس واقعی نیاز داره و تست نشد.` : bad.length ? `${bad.map((b) => `${b.path} → ${b.status ?? b.error}`).join("، ")}` : null,
    };
  }
}

/** Failure text per failing test (the lines following its × marker). */
export function failureBlocks(output: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  for (const line of output.split("\n")) {
    const m = /^\s*(?:×|✕|✗|FAIL|not ok \d+ -)\s+(.+)$/.exec(line);
    if (m) {
      cur = m[1]!.trim();
      out.set(cur, "");
    } else if (/^\s*(?:✓|√|ok \d+)/.test(line)) cur = null;
    else if (cur) out.set(cur, `${out.get(cur)}\n${line}`);
  }
  return out;
}

export function parseFailingTests(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/^\s*(?:×|✕|✗|FAIL|not ok \d+ -)\s+(.+)$/gm)) out.add(m[1]!.trim());
  return [...out].slice(0, 50);
}

function summarize(key: string, output: string, failing: string[], previous: string[]): string {
  if (key === "test" && failing.length) {
    const fresh = failing.filter((f) => !previous.includes(f));
    return `${faNum(failing.length)} تست رد شد: ${failing.slice(0, 3).map((f) => `«${f}»`).join("، ")}${fresh.length !== failing.length ? " (برخی از قبل خراب بودن)" : ""}`;
  }
  const firstErr = output.split("\n").find((l) => /error|ERR!|Error:|Module not found|failed/i.test(l));
  return firstErr ? firstErr.trim().slice(0, 240) : "با خطا تموم شد.";
}
