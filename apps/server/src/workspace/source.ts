import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import * as tar from "tar";
import type { Db } from "../db/db.js";
import { AgentError } from "../errors.js";
import { walk } from "../analyzer/analyzer.js";
import { iso, newId, sha256 } from "../util.js";

const pexec = promisify(execFile);

export interface Workspace {
  id: string;
  kind: "git" | "zip" | "sample";
  origin: string;
  /** pristine copy — never modified after intake */
  originalPath: string;
  /** deployment copy — the only place approved patches are applied */
  deployPath: string;
}

const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_FILES = 20_000;
const MAX_SOURCE_UPLOAD = 256 * 1024 * 1024;

const DEFAULT_IGNORE = ["node_modules", ".git", ".next", ".nuxt", "dist", "coverage", ".turbo", ".cache", "__pycache__", ".venv", "venv", ".env", ".env.local", ".env.production", ".env.development", ".DS_Store", ".idea", ".vscode", "*.log"];

export class WorkspaceManager {
  constructor(
    private db: Db,
    private rootDir: string,
  ) {
    mkdirSync(rootDir, { recursive: true });
  }

  private create(kind: Workspace["kind"], origin: string, chatId: string | null): Workspace {
    const id = newId("ws");
    const base = join(this.rootDir, id);
    const ws: Workspace = { id, kind, origin, originalPath: join(base, "original"), deployPath: join(base, "deploy") };
    mkdirSync(ws.originalPath, { recursive: true });
    this.db.run("INSERT INTO workspaces(id, chat_id, kind, origin, path, original_path, created_at) VALUES(?,?,?,?,?,?,?)", id, chatId, kind, origin, ws.deployPath, ws.originalPath, iso());
    return ws;
  }

  get(id: string): Workspace | null {
    const r = this.db.get<{ id: string; kind: Workspace["kind"]; origin: string; path: string; original_path: string }>("SELECT * FROM workspaces WHERE id = ?", id);
    return r ? { id: r.id, kind: r.kind, origin: r.origin, deployPath: r.path, originalPath: r.original_path } : null;
  }

  private finalize(ws: Workspace): Workspace {
    cpSync(ws.originalPath, ws.deployPath, { recursive: true, verbatimSymlinks: true, filter: (src) => !src.includes(`${sep}.git${sep}`) && !src.endsWith(`${sep}.git`) });
    return ws;
  }

  /** Clone a public HTTPS repository (shallow). Private/loopback hosts are rejected (SSRF guard). */
  async fromGit(url: string, chatId: string | null, branch?: string): Promise<Workspace> {
    const u = await validateRepoUrl(url);
    const ws = this.create("git", u.toString(), chatId);
    const args = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "clone", "--depth", "1", "--single-branch", "--no-tags"];
    if (branch) {
      if (!/^[\w./-]{1,100}$/.test(branch)) throw new AgentError("VALIDATION", "invalid branch name");
      args.push("--branch", branch);
    }
    args.push("--", u.toString(), ws.originalPath);
    try {
      await pexec("git", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { ...safeEnv(), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" } });
    } catch (e) {
      throw new AgentError("VALIDATION", `git clone failed: ${(e as Error).message.split("\n").slice(-2).join(" ")}`);
    }
    rmSync(join(ws.originalPath, ".git"), { recursive: true, force: true });
    return this.finalize(ws);
  }

  /** Extract an uploaded ZIP with zip-slip, size and file-count protection. */
  fromZip(data: Uint8Array, name: string, chatId: string | null): Workspace {
    if (data.byteLength > MAX_ZIP_BYTES) throw new AgentError("VALIDATION", "zip is too large");
    let total = 0;
    let count = 0;
    const entries = unzipSync(data, {
      filter: (f) => {
        count++;
        total += f.originalSize;
        if (count > MAX_ZIP_FILES) throw new AgentError("VALIDATION", "zip contains too many files");
        if (total > MAX_ZIP_BYTES * 3) throw new AgentError("VALIDATION", "zip expands beyond the allowed size (possible zip bomb)");
        return !f.name.endsWith("/") && !/(^|\/)(node_modules|\.git)\//.test(f.name);
      },
    });
    const ws = this.create("zip", name, chatId);
    const names = Object.keys(entries);
    // Strip a single top-level folder (common for GitHub zips).
    const top = names.length && names.every((n) => n.split("/")[0] === names[0]!.split("/")[0] && n.includes("/")) ? `${names[0]!.split("/")[0]}/` : "";
    for (const [n, content] of Object.entries(entries)) {
      const rel = n.slice(top.length);
      const target = safeJoin(ws.originalPath, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return this.finalize(ws);
  }

  fromDirectory(dir: string, origin: string, chatId: string | null): Workspace {
    const ws = this.create("sample", origin, chatId);
    cpSync(dir, ws.originalPath, { recursive: true, filter: (src) => !/node_modules|\.git$/.test(src) });
    return this.finalize(ws);
  }

  /** Fresh scratch copy of the deploy copy (for sandbox runs / patch trials). */
  scratchCopy(ws: Workspace, label: string): string {
    const p = join(this.rootDir, ws.id, `scratch-${label}-${Date.now()}`);
    cpSync(ws.deployPath, p, { recursive: true, filter: (src) => !src.includes(`${sep}node_modules`) });
    return p;
  }

  /** Content hash of a tree (used to prove the original stays untouched). */
  treeHash(path: string): string {
    const { files } = walk(path);
    return sha256(files.sort().map((f) => `${f}:${sha256(readFileSync(join(path, f)).toString("base64"))}`).join("\n"));
  }

  /** Builds the .tar.gz uploaded to POST /v2/projects/{name}/sources. .env files are never included. */
  async packageForLiara(ws: Workspace): Promise<{ data: Uint8Array; bytes: number; files: number; ignored: string[] }> {
    const ignore = [...DEFAULT_IGNORE, ...readIgnore(join(ws.deployPath, ".liaraignore")), ...readIgnore(join(ws.deployPath, ".gitignore"))];
    const matchers = ignore.map(globToRegex);
    const { files } = walk(ws.deployPath);
    const included = files.filter((f) => !matchers.some((re) => re.test(f) || f.split("/").some((seg) => re.test(seg))));
    const out = join(this.rootDir, ws.id, `source-${Date.now()}.tar.gz`);
    await tar.create({ gzip: true, file: out, cwd: ws.deployPath, portable: true, noMtime: true }, included);
    const data = new Uint8Array(readFileSync(out));
    rmSync(out, { force: true });
    if (data.byteLength > MAX_SOURCE_UPLOAD) throw new AgentError("VALIDATION", "source archive exceeds the 256MB upload limit");
    return { data, bytes: data.byteLength, files: included.length, ignored: ignore };
  }
}

function readIgnore(p: string): string[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((l) => l.replace(/^\//, "").replace(/\/$/, ""));
}

function globToRegex(g: string): RegExp {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}(/.*)?$`);
}

export function safeJoin(root: string, rel: string): string {
  const cleaned = normalize(rel).replace(/^([/\\])+/, "");
  if (cleaned.startsWith("..") || /^[a-zA-Z]:/.test(cleaned)) throw new AgentError("UNSAFE_OPERATION", `path traversal rejected: ${rel}`);
  const full = resolve(root, cleaned);
  if (!full.startsWith(resolve(root) + sep) && full !== resolve(root)) throw new AgentError("UNSAFE_OPERATION", `path escapes workspace: ${rel}`);
  return full;
}

/** Child processes get an allow-listed environment — never the Liara/AI tokens. */
export function safeEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "LANG", "ComSpec", "PATHEXT"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

export async function validateRepoUrl(url: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new AgentError("VALIDATION", "آدرس مخزن معتبر نیست");
  }
  if (u.protocol !== "https:") throw new AgentError("VALIDATION", "فقط آدرس‌های https پشتیبانی می‌شن");
  if (u.username || u.password) throw new AgentError("VALIDATION", "credentials in repository URLs are not accepted");
  const host = u.hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new AgentError("UNSAFE_OPERATION", "private host rejected");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new AgentError("VALIDATION", "host does not resolve");
  for (const a of addrs) if (isPrivateIp(a.address)) throw new AgentError("UNSAFE_OPERATION", "repository host resolves to a private address");
  return u;
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith("::ffff:127.") || ip === "::";
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Keeps the original tree read-only on POSIX (best effort; Windows ACLs are not changed). */
export function lockOriginal(path: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, 0o555);
  } catch {
    /* best effort */
  }
}
