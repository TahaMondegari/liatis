/** Normalized error hierarchy (BRIEF §21.3). `code` is stable; messages are developer-facing. */
export type ErrorCode =
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "VALIDATION"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "LIARA_API"
  | "UNSUPPORTED_OPERATION"
  | "APPROVAL_REQUIRED"
  | "UNSAFE_OPERATION"
  | "DEPLOYMENT"
  | "BUILD"
  | "RUNTIME"
  | "VERIFICATION"
  | "SANDBOX_EXECUTION"
  | "MODEL_UNAVAILABLE"
  | "BUDGET_EXCEEDED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL";

export class AgentError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly details: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; status?: number | null; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = `${code}Error`;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status ?? null;
    this.details = opts.details ?? {};
  }
}

export const isAgentError = (e: unknown): e is AgentError => e instanceof AgentError;

export function toAgentError(e: unknown): AgentError {
  if (isAgentError(e)) return e;
  if (e instanceof Error) {
    if (e.name === "AbortError" || e.name === "TimeoutError") return new AgentError("TIMEOUT", e.message, { retryable: true, cause: e });
    return new AgentError("INTERNAL", e.message, { cause: e });
  }
  return new AgentError("INTERNAL", String(e));
}

/** Persian user-facing message for each normalized error code. */
export const ERROR_FA: Record<ErrorCode, string> = {
  AUTHENTICATION: "توکن دسترسی لیارا نامعتبره یا منقضی شده.",
  AUTHORIZATION: "این توکن اجازه‌ی انجام این کار رو نداره.",
  VALIDATION: "ورودی این عملیات معتبر نیست.",
  RATE_LIMIT: "تعداد درخواست‌ها زیاد شده؛ کمی بعد دوباره تلاش می‌کنم.",
  TIMEOUT: "پاسخ سرویس طول کشید و زمانش تموم شد.",
  LIARA_API: "API لیارا خطا برگردوند.",
  UNSUPPORTED_OPERATION: "این کار از طریق API لیارا ممکن نیست.",
  APPROVAL_REQUIRED: "این عملیات به تأیید تو نیاز داره.",
  UNSAFE_OPERATION: "این عملیات به دلایل ایمنی مسدود شد.",
  DEPLOYMENT: "دپلوی با خطا مواجه شد.",
  BUILD: "build با خطا مواجه شد.",
  RUNTIME: "برنامه در حال اجرا با خطا مواجه شد.",
  VERIFICATION: "بررسی سلامت بعد از عملیات رد شد.",
  SANDBOX_EXECUTION: "اجرای آزمایشی در محیط ایزوله ممکن نشد.",
  MODEL_UNAVAILABLE: "هیچ مدل هوش مصنوعی مجازی در دسترس نیست.",
  BUDGET_EXCEEDED: "سقف هزینه‌ی هوش مصنوعی پر شده.",
  NOT_FOUND: "منبع پیدا نشد.",
  CONFLICT: "این منبع قبلاً وجود داره یا در حال تغییره.",
  INTERNAL: "یک خطای داخلی رخ داد.",
};
