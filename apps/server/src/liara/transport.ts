import type { GeneratedOperation } from "./operations.generated.js";

export interface LiaraRequest {
  pathParams?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** multipart upload (only for operations whose spec declares multipart/form-data) */
  file?: { field: string; name: string; data: Uint8Array; contentType: string };
}

export interface LiaraResponse<T = unknown> {
  status: number;
  data: T;
  requestId: string;
  durationMs: number;
  attempts: number;
}

/** Real HTTP and the Mock Liara API implement the same contract. */
export interface LiaraTransport {
  readonly kind: "http" | "mock";
  send<T = unknown>(op: GeneratedOperation, req: LiaraRequest, signal?: AbortSignal): Promise<LiaraResponse<T>>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._~@:+=,-]+$/;

/** Builds a path from the spec template. Values are validated and encoded; no raw URLs are accepted. */
export function buildPath(op: GeneratedOperation, params: Record<string, string | number> = {}): string {
  return op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const raw = params[name];
    if (raw === undefined || raw === null || raw === "") throw new Error(`missing path parameter "${name}" for ${op.id}`);
    const v = String(raw);
    const decl = op.pathParams.find((p) => p.name === name);
    if (decl?.enum && !decl.enum.includes(v)) throw new Error(`invalid value for ${name}; expected one of ${decl.enum.join(", ")}`);
    if (v.length > 512) throw new Error(`path parameter ${name} too long`);
    // Object storage keys and file paths may contain "/", but never traversal.
    const allowSlash = /object|prefix|path/i.test(name);
    const segments = allowSlash ? v.split("/") : [v];
    for (const s of segments) {
      if (s === ".." || s === ".") throw new Error(`path traversal rejected in ${name}`);
      if (!allowSlash && !SAFE_SEGMENT.test(s)) throw new Error(`invalid characters in ${name}`);
    }
    return segments.map(encodeURIComponent).join("/");
  });
}

/** Only query parameters declared in the spec are forwarded. */
export function buildQuery(op: GeneratedOperation, query: LiaraRequest["query"] = {}): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    const decl = op.queryParams.find((q) => q.name === k);
    if (!decl) throw new Error(`query parameter "${k}" is not declared for ${op.id}`);
    if (decl.enum && !decl.enum.includes(String(v))) throw new Error(`invalid value for ${k}`);
    usp.set(k, String(v));
  }
  for (const q of op.queryParams) if (q.required && !usp.has(q.name)) throw new Error(`missing required query parameter "${q.name}" for ${op.id}`);
  const s = usp.toString();
  return s ? `?${s}` : "";
}
