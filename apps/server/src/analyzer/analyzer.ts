import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Project Analyzer (BRIEF §9). Static, read-only inspection — never executes
 * repository code. Repository content is treated as untrusted data.
 */
export interface Evidence {
  value: string;
  evidence: string;
}

export interface ProjectProfile {
  root: string;
  languages: string[];
  frameworks: Evidence[];
  /** Liara platform id used by createApp/releasesDeploy (Liara CLI conventions; user can change). */
  liaraPlatform: Evidence & { confidence: number };
  packageManager: Evidence | null;
  runtimeVersion: Evidence | null;
  commands: { install: Evidence | null; lint: Evidence | null; typecheck: Evidence | null; build: Evidence | null; test: Evidence | null; start: Evidence | null };
  port: Evidence & { hardcoded: boolean };
  envVars: { key: string; required: boolean; source: string }[];
  database: Evidence | null;
  storageNeeded: Evidence | null;
  docker: { dockerfile: boolean; compose: boolean };
  monorepo: Evidence | null;
  healthPaths: string[];
  workers: Evidence[];
  routes: string[];
  ssr: boolean | null;
  lockfileIssues: string[];
  unknowns: string[];
  fileCount: number;
  sizeBytes: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "vendor", "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache", "target", "bin", "obj"]);
const MAX_FILES = 20_000;
const MAX_READ = 256 * 1024;

function read(root: string, p: string): string | null {
  const f = join(root, p);
  try {
    const st = statSync(f);
    if (!st.isFile() || st.size > MAX_READ) return null;
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
}

function readJson<T>(root: string, p: string): T | null {
  const s = read(root, p);
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function walk(root: string, limit = MAX_FILES): { files: string[]; size: number } {
  const files: string[] = [];
  let size = 0;
  const stack = [root];
  while (stack.length && files.length < limit) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow symlinks out of the workspace
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        files.push(relative(root, full).split(sep).join("/"));
        try {
          size += statSync(full).size;
        } catch {
          /* ignore */
        }
        if (files.length >= limit) break;
      }
    }
  }
  return { files, size };
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  workspaces?: unknown;
  packageManager?: string;
  main?: string;
}

const has = (pkg: PackageJson | null, dep: string) => Boolean(pkg?.dependencies?.[dep] ?? pkg?.devDependencies?.[dep]);

export function analyzeProject(root: string): ProjectProfile {
  const { files, size } = walk(root);
  const fileSet = new Set(files);
  const exists = (p: string) => fileSet.has(p);
  const anyMatch = (re: RegExp) => files.find((f) => re.test(f)) ?? null;
  const unknowns: string[] = [];
  const frameworks: Evidence[] = [];
  const languages = new Set<string>();
  const lockfileIssues: string[] = [];

  const pkg = readJson<PackageJson>(root, "package.json");
  const composer = readJson<{ require?: Record<string, string> }>(root, "composer.json");
  const requirements = read(root, "requirements.txt");
  const pyproject = read(root, "pyproject.toml");
  const goMod = read(root, "go.mod");
  const csproj = anyMatch(/^[^/]+\.csproj$/);

  if (pkg) languages.add(exists("tsconfig.json") || has(pkg, "typescript") ? "TypeScript" : "JavaScript");
  if (composer || anyMatch(/\.php$/)) languages.add("PHP");
  if (requirements || pyproject || anyMatch(/\.py$/)) languages.add("Python");
  if (goMod) languages.add("Go");
  if (csproj) languages.add("C#");

  // ---- frameworks & Liara platform ------------------------------------------
  let platform: Evidence & { confidence: number } = { value: "docker", evidence: "no supported framework detected", confidence: 0.2 };
  const nextCfg = anyMatch(/^next\.config\.(js|mjs|ts|cjs)$/);
  const pyDeps = `${requirements ?? ""}\n${pyproject ?? ""}`.toLowerCase();
  if (has(pkg, "next")) {
    frameworks.push({ value: "Next.js", evidence: `package.json dependency "next"${nextCfg ? ` + ${nextCfg}` : ""}${exists("app/page.tsx") || anyMatch(/^(src\/)?app\//) ? " + app/ directory" : ""}` });
    platform = { value: "next", evidence: frameworks.at(-1)!.evidence, confidence: 0.95 };
  } else if (has(pkg, "nuxt")) {
    frameworks.push({ value: "Nuxt", evidence: 'package.json dependency "nuxt"' });
    platform = { value: "node", evidence: "Nuxt runs as a Node.js server", confidence: 0.7 };
  } else if (has(pkg, "@angular/core")) {
    frameworks.push({ value: "Angular", evidence: 'dependency "@angular/core"' });
    platform = { value: "angular", evidence: frameworks.at(-1)!.evidence, confidence: 0.85 };
  } else if (has(pkg, "vue") && !has(pkg, "express")) {
    frameworks.push({ value: "Vue", evidence: 'dependency "vue"' });
    platform = { value: "vue", evidence: frameworks.at(-1)!.evidence, confidence: 0.8 };
  } else if (has(pkg, "react") && (has(pkg, "vite") || has(pkg, "react-scripts")) && !has(pkg, "express")) {
    frameworks.push({ value: "React", evidence: `dependency "react" + ${has(pkg, "vite") ? "vite" : "react-scripts"}` });
    platform = { value: "react", evidence: frameworks.at(-1)!.evidence, confidence: 0.8 };
  } else if (pkg) {
    for (const fw of ["@nestjs/core", "express", "fastify", "koa", "hono"]) if (has(pkg, fw)) frameworks.push({ value: fw === "@nestjs/core" ? "NestJS" : fw, evidence: `dependency "${fw}"` });
    platform = { value: "node", evidence: "package.json present", confidence: frameworks.length ? 0.85 : 0.6 };
  } else if (composer?.require?.["laravel/framework"] || exists("artisan")) {
    frameworks.push({ value: "Laravel", evidence: composer?.require?.["laravel/framework"] ? 'composer.json requires "laravel/framework"' : "artisan file" });
    platform = { value: "laravel", evidence: frameworks.at(-1)!.evidence, confidence: 0.9 };
  } else if (exists("wp-config.php") || exists("wp-config-sample.php") || anyMatch(/^wp-content\//)) {
    frameworks.push({ value: "WordPress", evidence: "wp-config / wp-content found" });
    platform = { value: "php", evidence: "WordPress runs on the PHP platform", confidence: 0.6 };
    unknowns.push("WordPress is offered by Liara as a one-click app; the agent deploys it as plain PHP.");
  } else if (composer || anyMatch(/^[^/]*\.php$/)) {
    frameworks.push({ value: "PHP", evidence: composer ? "composer.json" : "*.php in root" });
    platform = { value: "php", evidence: frameworks.at(-1)!.evidence, confidence: 0.7 };
  } else if (/\bdjango\b/.test(pyDeps) || exists("manage.py")) {
    frameworks.push({ value: "Django", evidence: exists("manage.py") ? "manage.py" : "django in requirements" });
    platform = { value: "django", evidence: frameworks.at(-1)!.evidence, confidence: 0.9 };
  } else if (/\bflask\b/.test(pyDeps)) {
    frameworks.push({ value: "Flask", evidence: "flask in requirements" });
    platform = { value: "flask", evidence: frameworks.at(-1)!.evidence, confidence: 0.85 };
  } else if (/\bfastapi\b/.test(pyDeps)) {
    frameworks.push({ value: "FastAPI", evidence: "fastapi in requirements" });
    platform = { value: "python", evidence: "FastAPI on the Python platform", confidence: 0.75 };
  } else if (requirements || pyproject) {
    platform = { value: "python", evidence: "Python manifest", confidence: 0.6 };
  } else if (goMod) {
    frameworks.push({ value: "Go", evidence: "go.mod" });
    platform = { value: "go", evidence: "go.mod", confidence: 0.85 };
  } else if (csproj) {
    frameworks.push({ value: ".NET", evidence: csproj });
    platform = { value: "netcore", evidence: csproj, confidence: 0.8 };
  } else if (exists("index.html")) {
    platform = { value: "static", evidence: "index.html with no server manifest", confidence: 0.7 };
  }
  const dockerfile = exists("Dockerfile");
  const compose = exists("docker-compose.yml") || exists("docker-compose.yaml") || exists("compose.yaml") || exists("compose.yml");
  if (dockerfile && platform.confidence < 0.6) platform = { value: "docker", evidence: "Dockerfile", confidence: 0.85 };
  const liaraJson = readJson<{ platform?: string; port?: number; app?: string; healthCheck?: { command?: string } }>(root, "liara.json");
  if (liaraJson?.platform) platform = { value: liaraJson.platform, evidence: "liara.json → platform", confidence: 0.99 };

  // ---- package manager & lockfiles ----------------------------------------
  let packageManager: Evidence | null = null;
  if (pkg) {
    if (exists("pnpm-lock.yaml")) packageManager = { value: "pnpm", evidence: "pnpm-lock.yaml" };
    else if (exists("yarn.lock")) packageManager = { value: "yarn", evidence: "yarn.lock" };
    else if (exists("bun.lock") || exists("bun.lockb")) packageManager = { value: "bun", evidence: "bun.lock" };
    else if (exists("package-lock.json")) packageManager = { value: "npm", evidence: "package-lock.json" };
    else {
      packageManager = { value: "npm", evidence: "package.json without lockfile (assumed npm)" };
      lockfileIssues.push("هیچ lockfileی پیدا نشد؛ نسخه‌ی وابستگی‌ها قابل تکرار نیست.");
    }
    if (pkg.packageManager) packageManager = { value: pkg.packageManager.split("@")[0]!, evidence: `package.json packageManager=${pkg.packageManager}` };
    const lock = readJson<{ packages?: Record<string, unknown>; dependencies?: Record<string, unknown> }>(root, "package-lock.json");
    if (lock) {
      const locked = new Set(Object.keys(lock.packages ?? {}).map((k) => k.replace(/^node_modules\//, "")).concat(Object.keys(lock.dependencies ?? {})));
      for (const d of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (locked.size && !locked.has(d)) lockfileIssues.push(`وابستگی «${d}» در package.json هست ولی در package-lock.json نیست.`);
      }
    }
  } else if (composer) packageManager = { value: "composer", evidence: "composer.json" };
  else if (requirements) packageManager = { value: "pip", evidence: "requirements.txt" };
  else if (pyproject) packageManager = { value: exists("uv.lock") ? "uv" : exists("poetry.lock") ? "poetry" : "pip", evidence: "pyproject.toml" };

  const runtimeVersion: Evidence | null = pkg?.engines?.node
    ? { value: `node ${pkg.engines.node}`, evidence: "package.json engines.node" }
    : exists(".nvmrc")
      ? { value: `node ${(read(root, ".nvmrc") ?? "").trim()}`, evidence: ".nvmrc" }
      : exists(".python-version")
        ? { value: `python ${(read(root, ".python-version") ?? "").trim()}`, evidence: ".python-version" }
        : null;

  // ---- commands (only from manifests; never guessed) -----------------------
  const s = pkg?.scripts ?? {};
  const pm = packageManager?.value ?? "npm";
  const runCmd = (name: string) => (pm === "npm" ? `npm run ${name}` : pm === "yarn" ? `yarn ${name}` : pm === "bun" ? `bun run ${name}` : `pnpm run ${name}`);
  const isPlaceholderTest = (cmd?: string) => !cmd || /no test specified/.test(cmd);
  const commands: ProjectProfile["commands"] = {
    install: pkg
      ? { value: pm === "npm" ? (exists("package-lock.json") ? "npm ci" : "npm install") : pm === "yarn" ? "yarn install --frozen-lockfile" : pm === "bun" ? "bun install --frozen-lockfile" : "pnpm install --frozen-lockfile", evidence: packageManager?.evidence ?? "package.json" }
      : requirements
        ? { value: "pip install -r requirements.txt", evidence: "requirements.txt" }
        : composer
          ? { value: "composer install --no-interaction", evidence: "composer.json" }
          : null,
    lint: s.lint ? { value: runCmd("lint"), evidence: `scripts.lint = ${s.lint}` } : null,
    typecheck: s.typecheck ? { value: runCmd("typecheck"), evidence: `scripts.typecheck = ${s.typecheck}` } : exists("tsconfig.json") && has(pkg, "typescript") ? { value: "npx tsc --noEmit", evidence: "tsconfig.json + typescript dependency" } : null,
    build: s.build ? { value: runCmd("build"), evidence: `scripts.build = ${s.build}` } : null,
    test: !isPlaceholderTest(s.test) ? { value: pm === "npm" ? "npm test" : runCmd("test"), evidence: `scripts.test = ${s.test}` } : exists("manage.py") ? { value: "python manage.py test", evidence: "manage.py" } : /\bpytest\b/.test(pyDeps) ? { value: "pytest -q", evidence: "pytest in requirements" } : null,
    start: s.start ? { value: pm === "npm" ? "npm start" : runCmd("start"), evidence: `scripts.start = ${s.start}` } : null,
  };
  if (pkg && !commands.build && platform.value === "next") unknowns.push("اسکریپت build در package.json تعریف نشده.");
  if (pkg && !commands.start && ["node", "next"].includes(platform.value)) unknowns.push("اسکریپت start در package.json تعریف نشده.");

  // ---- port ----------------------------------------------------------------
  let port: ProjectProfile["port"] = { value: platform.value === "next" ? "3000" : platform.value === "laravel" || platform.value === "php" ? "80" : platform.value === "django" || platform.value === "flask" || platform.value === "python" ? "8000" : "3000", evidence: "platform default (assumption)", hardcoded: false };
  if (liaraJson?.port) port = { value: String(liaraJson.port), evidence: "liara.json → port", hardcoded: false };
  const sourceFiles = files.filter((f) => /\.(m?[jt]sx?|py|php|go)$/.test(f) && !/(^|\/)(test|tests|__tests__)\//.test(f)).slice(0, 400);
  const envVars = new Map<string, { required: boolean; source: string }>();
  const routes: string[] = [];
  const workers: Evidence[] = [];
  let dbEvidence: Evidence | null = null;
  for (const f of sourceFiles) {
    const src = read(root, f);
    if (!src) continue;
    const listen = /\.listen\(\s*(\d{2,5})\b/.exec(src);
    if (listen && port.evidence.startsWith("platform default")) port = { value: listen[1]!, evidence: `${f}: .listen(${listen[1]}) (hardcoded)`, hardcoded: true };
    const envListen = /\.listen\(\s*process\.env\.PORT\s*(\|\||\?\?)\s*(\d{2,5})/.exec(src);
    if (envListen) port = { value: envListen[2]!, evidence: `${f}: process.env.PORT ${envListen[1]} ${envListen[2]}`, hardcoded: false };
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]{1,63})(\s*(\?\?|\|\|))?/g)) {
      const key = m[1]!;
      if (["NODE_ENV", "PORT"].includes(key)) continue;
      const prev = envVars.get(key);
      const required = !m[2];
      envVars.set(key, { required: (prev?.required ?? false) || required, source: prev?.source ?? f });
    }
    for (const m of src.matchAll(/os\.environ(?:\.get\(\s*|\[\s*)["']([A-Z][A-Z0-9_]{1,63})["']/g)) envVars.set(m[1]!, { required: src.includes(`os.environ["${m[1]}"]`), source: f });
    for (const m of src.matchAll(/env\(\s*['"]([A-Z][A-Z0-9_]{1,63})['"]\s*(,)?/g)) if (f.endsWith(".php")) envVars.set(m[1]!, { required: !m[2], source: f });
    for (const m of src.matchAll(/\b(?:app|router)\.(get|post|put|patch|delete)\(\s*["'`](\/[^"'`]*)/g)) routes.push(`${m[1]!.toUpperCase()} ${m[2]}`);
    if (!dbEvidence) {
      if (/\b(pg|postgres|PrismaClient|DATABASE_URL)\b/.test(src)) dbEvidence = { value: "postgres", evidence: `${f}` };
      else if (/\bmongoose|MongoClient\b/.test(src)) dbEvidence = { value: "mongodb", evidence: f };
      else if (/\bmysql2?\b/.test(src)) dbEvidence = { value: "mysql", evidence: f };
      else if (/\b(ioredis|createClient\(.*redis)/.test(src)) dbEvidence = { value: "redis", evidence: f };
    }
    if (/node-cron|cron\.schedule|bullmq|celery|setInterval\(/.test(src)) workers.push({ value: "background job", evidence: f });
  }
  // file-system routes (Next.js app router)
  for (const f of files) {
    const m = /^(?:src\/)?app\/(.*)\/?(page|route)\.(t|j)sx?$/.exec(f);
    if (m) routes.push(`/${m[1]}`.replace(/\/$/, "") || "/");
  }
  const envExample = read(root, ".env.example") ?? read(root, ".env.sample");
  if (envExample) {
    for (const line of envExample.split(/\r?\n/)) {
      const m = /^\s*([A-Z][A-Z0-9_]{1,63})\s*=/.exec(line);
      if (m && !envVars.has(m[1]!)) envVars.set(m[1]!, { required: true, source: ".env.example" });
    }
  }
  const prisma = read(root, "prisma/schema.prisma");
  if (prisma) {
    const prov = /provider\s*=\s*"(postgresql|mysql|sqlite|mongodb)"/.exec(prisma);
    if (prov) dbEvidence = { value: prov[1] === "postgresql" ? "postgres" : prov[1]!, evidence: "prisma/schema.prisma datasource" };
  }
  if (!dbEvidence) {
    if (/psycopg|asyncpg/.test(pyDeps)) dbEvidence = { value: "postgres", evidence: "requirements" };
    else if (/mysqlclient|pymysql/.test(pyDeps)) dbEvidence = { value: "mysql", evidence: "requirements" };
    else if (has(pkg, "pg")) dbEvidence = { value: "postgres", evidence: 'dependency "pg"' };
  }
  const storageNeeded = has(pkg, "@aws-sdk/client-s3") || /boto3/.test(pyDeps) || has(pkg, "multer") ? { value: "object-storage", evidence: has(pkg, "@aws-sdk/client-s3") ? "@aws-sdk/client-s3" : /boto3/.test(pyDeps) ? "boto3" : "multer (file uploads)" } : null;

  const healthPaths = ["/api/health", "/health", "/healthz", "/"].filter((p) => p === "/" || routes.some((r) => r.endsWith(p)));
  const monorepo: Evidence | null = pkg?.workspaces ? { value: "workspaces", evidence: "package.json workspaces" } : exists("pnpm-workspace.yaml") ? { value: "pnpm workspace", evidence: "pnpm-workspace.yaml" } : exists("turbo.json") ? { value: "turborepo", evidence: "turbo.json" } : null;
  if (monorepo) unknowns.push("مونوریپو تشخیص داده شد؛ مسیر برنامه‌ی قابل دپلوی باید تأیید بشه.");

  return {
    root,
    languages: [...languages],
    frameworks,
    liaraPlatform: platform,
    packageManager,
    runtimeVersion,
    commands,
    port,
    envVars: [...envVars.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.key.localeCompare(b.key)),
    database: dbEvidence,
    storageNeeded,
    docker: { dockerfile, compose },
    monorepo,
    healthPaths: healthPaths.length ? healthPaths : ["/"],
    workers,
    routes: [...new Set(routes)].slice(0, 50),
    ssr: platform.value === "next" ? true : ["react", "vue", "angular", "static"].includes(platform.value) ? false : null,
    lockfileIssues,
    unknowns,
    fileCount: files.length,
    sizeBytes: size,
  };
}

export const PLATFORM_LABEL_FA: Record<string, string> = {
  next: "Next.js",
  node: "Node.js",
  laravel: "Laravel",
  php: "PHP",
  django: "Django",
  flask: "Flask",
  netcore: ".NET",
  static: "سایت استاتیک",
  react: "React",
  angular: "Angular",
  vue: "Vue",
  docker: "Docker",
  python: "Python",
  go: "Go",
};

export function suggestAppName(profileRoot: string, pkgName?: string | null): string {
  const base = (pkgName ?? profileRoot.split(/[\\/]/).filter(Boolean).pop() ?? "app")
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return base.length >= 3 ? base : `app-${base}`;
}

export function readPackageName(root: string): string | null {
  if (!existsSync(join(root, "package.json"))) return null;
  return readJson<{ name?: string }>(root, "package.json")?.name ?? null;
}
