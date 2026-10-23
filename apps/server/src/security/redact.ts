/**
 * Secret redaction applied to every tool result, SSE payload, audit record,
 * model input and log line before it leaves the process boundary.
 */
const SECRET_KEY_RE = /(pass(word)?|secret|token|api[-_]?key|authorization|private[-_]?key|credential|root_password|accessKey|secretKey|dsn|connection[-_]?string|DATABASE_URL|_KEY$|_SECRET$|_TOKEN$)/i;

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]"],
  [/\b(sk|pk|rk|ghp|gho|github_pat|glpat|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED_KEY]"],
  [/\b([a-z][a-z0-9+.-]*):\/\/([^:/\s@]+):([^@\s/]+)@/gi, "$1://$2:[REDACTED]@"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/((?:password|passwd|pwd|secret|token|api_key|apikey)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[REDACTED]"],
];

const extraSecrets = new Set<string>();

/** Register exact secret values (e.g. env tokens) so they are scrubbed anywhere. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) extraSecrets.add(value);
}

export function redactString(input: string): string {
  let out = input;
  for (const s of extraSecrets) {
    if (out.includes(s)) out = out.split(s).join("[REDACTED]");
  }
  for (const [re, rep] of VALUE_PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 20) return value;
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && v !== null && v !== undefined && typeof v !== "boolean" && typeof v !== "object") {
        out[k] = "[REDACTED]";
      } else if (k === "envs" && Array.isArray(v)) {
        // Liara app envs: keep names, drop values.
        out[k] = v.map((e) => (e && typeof e === "object" ? { ...(e as object), value: "[REDACTED]" } : e));
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out as T;
  }
  return value;
}

/** Truncate large payloads (response size limit) while keeping them valid JSON-ish. */
export function clampText(s: string, max = 8000): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}
