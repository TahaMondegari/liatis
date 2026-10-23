import { AgentError, type ErrorCode } from "../errors.js";
import { clampText, redactString } from "../security/redact.js";
import { newId, sleep } from "../util.js";
import type { GeneratedOperation } from "./operations.generated.js";
import { buildPath, buildQuery, type LiaraRequest, type LiaraResponse, type LiaraTransport } from "./transport.js";

const ALLOWED_HOSTS = new Set([
  "api.liara.ir",
  "dns-service.liara.ir",
  "storage-service.liara.ir",
  "mail-service.liara.ir",
  "iaas-api.liara.ir",
  "ai.liara.ir",
]);

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface HttpTransportOptions {
  token: string;
  aiApiKey: string | null;
  fileBrowserUrl: string | null;
  dbInspectorUrl: string | null;
  /** Team accounts: Liara scopes every request to the team via `?teamID=` (not declared per-operation in the specs). */
  teamId?: string | null;
  maxRetries?: number;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  onTelemetry?: (t: { opId: string; status: number; durationMs: number; attempts: number; requestId: string; error?: string }) => void;
}

/**
 * Typed HTTP transport for the official Liara APIs.
 * - strict host allowlist (no arbitrary URL forwarding; SSRF guard)
 * - credentials injected here only
 * - bounded retries with exponential backoff + jitter, idempotent operations only
 * - Retry-After honoured on 429
 * - normalized errors, response size cap, redacted telemetry
 */
export class HttpTransport implements LiaraTransport {
  readonly kind = "http" as const;
  private fetchImpl: typeof fetch;
  constructor(private opts: HttpTransportOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    for (const extra of [opts.fileBrowserUrl, opts.dbInspectorUrl]) {
      if (extra) {
        const u = new URL(extra);
        if (u.protocol !== "https:" || !u.hostname.endsWith(".liara.ir")) throw new Error("per-resource Liara hosts must be https://*.liara.ir");
        ALLOWED_HOSTS.add(u.hostname);
      }
    }
  }

  private baseUrl(op: GeneratedOperation): string {
    if (op.baseUrl === "env:LIARA_FILEBROWSER_URL") {
      if (!this.opts.fileBrowserUrl) throw new AgentError("UNSUPPORTED_OPERATION", "File Browser host is not configured (LIARA_FILEBROWSER_URL)");
      return this.opts.fileBrowserUrl;
    }
    if (op.baseUrl === "env:LIARA_DB_INSPECTOR_URL") {
      if (!this.opts.dbInspectorUrl) throw new AgentError("UNSUPPORTED_OPERATION", "Database Inspector host is not configured (LIARA_DB_INSPECTOR_URL)");
      return this.opts.dbInspectorUrl;
    }
    return op.baseUrl;
  }

  async send<T>(op: GeneratedOperation, req: LiaraRequest, signal?: AbortSignal): Promise<LiaraResponse<T>> {
    const url = new URL(this.baseUrl(op).replace(/\/$/, "") + buildPath(op, req.pathParams) + buildQuery(op, req.query));
    // teamID comes from operator configuration only, never from model arguments.
    if (this.opts.teamId && op.auth === "liara_token") url.searchParams.set("teamID", this.opts.teamId);
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
      throw new AgentError("UNSAFE_OPERATION", `host ${url.hostname} is not on the Liara allowlist`);
    }
    const requestId = newId("lr");
    const headers: Record<string, string> = { Accept: "application/json", "X-Request-ID": requestId, "User-Agent": "liara-deploy-agent/0.1" };
    if (op.auth === "liara_token") headers.Authorization = `Bearer ${this.opts.token}`;
    else if (op.auth === "ai_api_key") {
      if (!this.opts.aiApiKey) throw new AgentError("AUTHENTICATION", "AI_API_KEY is not configured");
      headers.Authorization = `Bearer ${this.opts.aiApiKey}`;
    }

    let body: FormData | string | undefined;
    if (req.file) {
      if (op.body?.contentType !== "multipart/form-data") throw new AgentError("VALIDATION", `${op.id} does not accept file uploads`);
      const fd = new FormData();
      fd.append(req.file.field, new Blob([req.file.data as Uint8Array<ArrayBuffer>], { type: req.file.contentType }), req.file.name);
      body = fd;
    } else if (req.body !== undefined) {
      if (!op.body || op.body.contentType !== "application/json") throw new AgentError("VALIDATION", `${op.id} does not accept a JSON body`);
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    } else if (op.body?.required) {
      throw new AgentError("VALIDATION", `${op.id} requires a request body`);
    }

    const idempotent = op.method === "GET" || op.method === "PUT";
    const maxAttempts = idempotent ? (this.opts.maxRetries ?? 3) + 1 : 1;
    const timeoutMs = req.file ? (this.opts.uploadTimeoutMs ?? 300_000) : (this.opts.timeoutMs ?? 30_000);
    const started = Date.now();
    let attempt = 0;
    let lastErr: AgentError | null = null;

    while (attempt < maxAttempts) {
      attempt++;
      const timeout = AbortSignal.timeout(timeoutMs);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const res = await this.fetchImpl(url, { method: op.method, headers, body, signal: sig, redirect: "error" });
        const text = await readCapped(res, MAX_RESPONSE_BYTES);
        const data = parseBody(text);
        if (res.ok) {
          const r = { status: res.status, data: data as T, requestId, durationMs: Date.now() - started, attempts: attempt };
          this.opts.onTelemetry?.({ opId: op.id, status: res.status, durationMs: r.durationMs, attempts: attempt, requestId });
          return r;
        }
        lastErr = normalizeHttpError(op, res.status, data);
        if (!(idempotent && RETRYABLE_STATUS.has(res.status)) || attempt >= maxAttempts) break;
        await sleep(backoff(attempt, res.headers.get("retry-after")), signal);
      } catch (e) {
        if (e instanceof AgentError) {
          lastErr = e;
          break;
        }
        const aborted = signal?.aborted;
        lastErr = new AgentError(timeout.aborted ? "TIMEOUT" : "LIARA_API", `${op.id}: ${(e as Error).message}`, { retryable: !aborted, cause: e });
        if (aborted || !idempotent || attempt >= maxAttempts) break;
        await sleep(backoff(attempt, null), signal);
      }
    }
    const err = lastErr ?? new AgentError("LIARA_API", `${op.id} failed`);
    this.opts.onTelemetry?.({ opId: op.id, status: err.status ?? 0, durationMs: Date.now() - started, attempts: attempt, requestId, error: err.code });
    throw err;
  }
}

function backoff(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 30_000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 30_000);
  }
  const base = 400 * 2 ** (attempt - 1);
  return Math.min(base + Math.random() * base, 8_000);
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new AgentError("LIARA_API", `response exceeded ${max} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeHttpError(op: GeneratedOperation, status: number, data: unknown): AgentError {
  const msg = typeof data === "object" && data && "message" in data ? String((data as { message: unknown }).message) : typeof data === "string" ? data : "";
  const code: ErrorCode =
    status === 401 ? "AUTHENTICATION" : status === 403 ? "AUTHORIZATION" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 429 ? "RATE_LIMIT" : status === 400 || status === 422 ? "VALIDATION" : "LIARA_API";
  return new AgentError(code, `${op.id} → HTTP ${status}${msg ? `: ${clampText(redactString(msg), 300)}` : ""}`, {
    status,
    retryable: RETRYABLE_STATUS.has(status),
    details: { liaraMessage: msg ? clampText(redactString(msg), 500) : null },
  });
}
