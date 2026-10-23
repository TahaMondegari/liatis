import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { redactString } from "../security/redact.js";
import { safeEnv } from "../workspace/source.js";

const pexec = promisify(execFile);

export interface RunSpec {
  dir: string;
  image: string;
  argv: string[];
  network: boolean;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ProbeResult {
  started: boolean;
  checks: { path: string; status: number | null; latencyMs: number | null; error: string | null }[];
  logs: string;
}

export interface Sandbox {
  readonly kind: "docker" | "simulated" | "disabled";
  readonly label: string;
  available(): Promise<{ ok: boolean; reason: string | null }>;
  run(spec: RunSpec): Promise<RunResult>;
  startAndProbe(spec: RunSpec & { port: number; paths: string[] }): Promise<ProbeResult>;
}

const MAX_OUTPUT = 200 * 1024;

/**
 * Allow-list of command shapes. A command string is accepted only if it is
 * one of these exact forms (derived from manifests); it is then split into
 * argv — there is never a shell.
 */
const COMMAND_ALLOWLIST: RegExp[] = [
  /^npm (ci|install|test|start)$/,
  /^npm run [\w:.-]{1,40}$/,
  /^(pnpm|yarn|bun) install --frozen-lockfile$/,
  /^(pnpm|yarn|bun)( run)? [\w:.-]{1,40}$/,
  /^npx tsc --noEmit$/,
  /^pip install -r requirements\.txt$/,
  /^python manage\.py test$/,
  /^pytest -q$/,
  /^composer install --no-interaction$/,
];

export function toArgv(command: string): string[] {
  const c = command.trim();
  if (!COMMAND_ALLOWLIST.some((re) => re.test(c))) throw new Error(`command not allowed in sandbox: ${c}`);
  const argv = c.split(/\s+/);
  // pnpm / yarn are provided by corepack inside the node image.
  if (argv[0] === "pnpm" || argv[0] === "yarn") return ["corepack", ...argv];
  return argv;
}

function capture(buf: string, chunk: Buffer): string {
  if (buf.length >= MAX_OUTPUT) return buf;
  return (buf + chunk.toString("utf8")).slice(0, MAX_OUTPUT);
}

/** Docker-backed sandbox: non-root, capped CPU/RAM/PIDs, no capabilities, no network unless installing. */
export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  readonly label = "کانتینر Docker ایزوله";
  constructor(private opts: { cpu: string; memory: string }) {}

  async available() {
    try {
      await pexec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 8000, env: safeEnv() });
      return { ok: true, reason: null };
    } catch {
      return { ok: false, reason: "Docker روی این سرور در دسترس نیست؛ دستورات پروژه اجرا نمی‌شن." };
    }
  }

  private baseArgs(spec: RunSpec, name: string): string[] {
    const args = [
      "run",
      "--name",
      name,
      "--network",
      spec.network ? "bridge" : "none",
      "--cpus",
      this.opts.cpu,
      "--memory",
      this.opts.memory,
      "--pids-limit",
      "512",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "1000:1000",
      "-e",
      "HOME=/tmp",
      "-e",
      "CI=true",
      "-e",
      "npm_config_cache=/tmp/.npm",
      "-v",
      `${spec.dir}:/work`,
      "-w",
      "/work",
    ];
    for (const [k, v] of Object.entries(spec.env ?? {})) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) throw new Error(`invalid env key ${k}`);
      args.push("-e", `${k}=${v}`);
    }
    return args;
  }

  run(spec: RunSpec): Promise<RunResult> {
    const name = `liara-agent-sb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const args = [...this.baseArgs(spec, name), "--rm", spec.image, ...spec.argv];
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn("docker", args, { env: safeEnv(), windowsHide: true });
      let out = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        spawn("docker", ["rm", "-f", name], { env: safeEnv() });
        child.kill("SIGKILL");
      }, spec.timeoutMs);
      child.stdout.on("data", (c: Buffer) => (out = capture(out, c)));
      child.stderr.on("data", (c: Buffer) => (out = capture(out, c)));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: timedOut ? null : code, output: redactString(out), durationMs: Date.now() - started, timedOut });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ exitCode: null, output: `sandbox error: ${e.message}`, durationMs: Date.now() - started, timedOut: false });
      });
    });
  }

  async startAndProbe(spec: RunSpec & { port: number; paths: string[] }): Promise<ProbeResult> {
    const name = `liara-agent-sb-start-${Date.now()}`;
    const args = [...this.baseArgs({ ...spec, network: true }, name), "-d", "-e", `PORT=${spec.port}`, "-p", `127.0.0.1::${spec.port}`, spec.image, ...spec.argv];
    try {
      await pexec("docker", args, { timeout: 30_000, env: safeEnv() });
      const { stdout } = await pexec("docker", ["port", name, String(spec.port)], { timeout: 10_000, env: safeEnv() });
      const hostPort = /:(\d+)\s*$/m.exec(stdout)?.[1];
      const checks: ProbeResult["checks"] = [];
      const deadline = Date.now() + Math.min(spec.timeoutMs, 60_000);
      let up = false;
      while (!up && Date.now() < deadline) {
        try {
          await fetch(`http://127.0.0.1:${hostPort}/`, { signal: AbortSignal.timeout(2000) });
          up = true;
        } catch {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      for (const p of spec.paths) {
        const t0 = Date.now();
        try {
          const r = await fetch(`http://127.0.0.1:${hostPort}${p}`, { signal: AbortSignal.timeout(5000), redirect: "manual" });
          checks.push({ path: p, status: r.status, latencyMs: Date.now() - t0, error: null });
        } catch (e) {
          checks.push({ path: p, status: null, latencyMs: null, error: (e as Error).message });
        }
      }
      const { stdout: logs } = await pexec("docker", ["logs", "--tail", "200", name], { timeout: 10_000, env: safeEnv() }).catch(() => ({ stdout: "" }));
      return { started: up, checks, logs: redactString(logs).slice(0, MAX_OUTPUT) };
    } catch (e) {
      return { started: false, checks: [], logs: redactString((e as Error).message) };
    } finally {
      await pexec("docker", ["rm", "-f", name], { timeout: 15_000, env: safeEnv() }).catch(() => undefined);
    }
  }
}

export class DisabledSandbox implements Sandbox {
  readonly kind = "disabled" as const;
  readonly label = "غیرفعال";
  async available() {
    return { ok: false, reason: "اجرای دستورات پروژه غیرفعال است (SANDBOX_DRIVER=disabled)." };
  }
  async run(): Promise<RunResult> {
    return { exitCode: null, output: "sandbox disabled", durationMs: 0, timedOut: false };
  }
  async startAndProbe(): Promise<ProbeResult> {
    return { started: false, checks: [], logs: "sandbox disabled" };
  }
}

/**
 * DEMO ONLY. Deterministic simulation that derives results from static checks of
 * the copied files (missing relative imports, lockfile drift, simple type errors,
 * string-concatenation sums under test). Nothing is executed. Every result is
 * labelled as simulated in the UI.
 */
export class SimulatedSandbox implements Sandbox {
  readonly kind = "simulated" as const;
  readonly label = "شبیه‌سازی دمو (بدون اجرای واقعی)";
  async available() {
    return { ok: true, reason: null };
  }

  async run(spec: RunSpec): Promise<RunResult> {
    const cmd = spec.argv.join(" ");
    const started = Date.now();
    const files = listFiles(spec.dir);
    const read = (f: string) => readFileSync(join(spec.dir, f), "utf8");
    const res = (exitCode: number, output: string): RunResult => ({ exitCode, output, durationMs: Date.now() - started + 40, timedOut: false });

    if (/\b(ci|install)\b/.test(cmd)) {
      const pkg = existsSync(join(spec.dir, "package.json")) ? JSON.parse(read("package.json")) : {};
      const lock = existsSync(join(spec.dir, "package-lock.json")) ? JSON.parse(read("package-lock.json")) : null;
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      if (lock) {
        const locked = new Set(Object.keys(lock.packages ?? {}).map((k: string) => k.replace(/^node_modules\//, "")));
        const missing = deps.filter((d) => !locked.has(d));
        if (missing.length) return res(1, `npm ERR! \`npm ci\` can only install packages when your package.json and package-lock.json are in sync.\nnpm ERR! Missing: ${missing[0]} from lock file`);
      }
      return res(0, `added ${deps.length * 37} packages in 38s`);
    }
    if (/tsc --noEmit|typecheck/.test(cmd)) {
      for (const f of files.filter((x) => /\.tsx?$/.test(x))) {
        const lines = read(f).split("\n");
        const i = lines.findIndex((l) => /:\s*number\s*=\s*["']/.test(l));
        if (i >= 0) return res(2, `${f}(${i + 1},7): error TS2322: Type 'string' is not assignable to type 'number'.`);
      }
      return res(0, "");
    }
    if (/\blint\b/.test(cmd)) return res(0, "✔ No ESLint warnings or errors");
    if (/\bbuild\b/.test(cmd)) {
      for (const f of files.filter((x) => /\.(m?[jt]sx?)$/.test(x) && !/\.test\./.test(x))) {
        for (const m of read(f).matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
          const base = join(spec.dir, f, "..", m[1]!);
          if (![".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js", ""].some((ext) => existsSync(base + ext) && statSync(base + ext).isFile())) {
            return res(1, `Failed to compile.\n./${f}\nModule not found: Can't resolve '${m[1]}'`);
          }
        }
      }
      return res(0, "✓ Compiled successfully\n✓ Generating static pages (12/12)");
    }
    if (/\btest\b/.test(cmd)) {
      const tests = files.filter((x) => /\.(test|spec)\.[jt]sx?$/.test(x));
      const results: string[] = [];
      let failed = 0;
      for (const t of tests) {
        const src = read(t);
        const its = [...src.matchAll(/\bit\(\s*["'`]([^"'`]+)["'`]/g)];
        for (const [idx, m] of its.entries()) {
          const name = m[1]!;
          const body = src.slice(m.index!, its[idx + 1]?.index ?? src.length);
          const failMarker = /@sample-preexisting-failure/.test(src.slice(Math.max(0, m.index! - 120), m.index!));
          let fail = failMarker;
          let detail = failMarker ? "    AssertionError: expected false to be true (pre-existing)" : "";
          if (!fail && /total\(/.test(body)) {
            const impl = files.find((x) => /cart\.[jt]s$/.test(x) && !/test/.test(x));
            if (impl && /\+=\s*\w+\.price\b/.test(read(impl)) && !/Number\(\s*\w+\.price\s*\)/.test(read(impl))) {
              fail = true;
              const lines = read(impl).split("\n");
              const ln = lines.findIndex((l) => /\+=\s*\w+\.price\b/.test(l));
              const col = (lines[ln] ?? "").indexOf("+=") + 1;
              detail = `    AssertionError: expected '01200' to equal 1200\n     at ${t}:7:25\n     at total (${impl}:${ln + 1}:${col})`;
            }
          }
          if (fail) failed++;
          results.push(`${fail ? "×" : "✓"} ${name}${fail ? `\n${detail}` : ""}`);
        }
      }
      const passed = results.length - failed;
      return res(failed ? 1 : 0, `${results.join("\n")}\n\nTests: ${failed} failed, ${passed} passed, ${results.length} total`);
    }
    return res(0, "");
  }

  async startAndProbe(spec: RunSpec & { port: number; paths: string[] }): Promise<ProbeResult> {
    const needsDb = listFiles(spec.dir).some((f) => /orders/.test(f));
    return {
      started: true,
      checks: spec.paths.map((p) => ({ path: p, status: needsDb && /orders/.test(p) ? null : 200, latencyMs: needsDb && /orders/.test(p) ? null : 40 + p.length * 3, error: needsDb && /orders/.test(p) ? "needs a real database (not available in sandbox)" : null })),
      logs: `> next start -p ${spec.port}\n  ▲ Next.js ready on http://0.0.0.0:${spec.port}`,
    };
  }
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  }
  return out;
}
