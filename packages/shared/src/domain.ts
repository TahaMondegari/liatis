import { z } from "zod";

/** Unified risk model (BRIEF §14.1). */
export const RiskLevel = z.enum(["L0", "L1", "L2", "L3", "L4"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const CapabilityStatus = z.enum(["supported", "partial", "unsupported", "unknown"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

export const CheckStatus = z.enum(["PASS", "WARN", "FAIL", "NOT_AVAILABLE", "NOT_APPLICABLE", "RUNNING", "PENDING", "SKIPPED"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

export const AppMode = z.enum(["demo", "real"]);
export type AppMode = z.infer<typeof AppMode>;

export const IncidentState = z.enum([
  "DETECTED",
  "INVESTIGATING",
  "DIAGNOSED",
  "WAITING_FOR_APPROVAL",
  "REPAIRING",
  "VERIFYING",
  "RESOLVED",
  "FAILED",
  "ESCALATED",
]);
export type IncidentState = z.infer<typeof IncidentState>;

export const Severity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type Severity = z.infer<typeof Severity>;

export const FailureCategory = z.enum([
  "CONFIG_ENV",
  "CODE_DEFECT",
  "DEPENDENCY",
  "BUILD_CONFIGURATION",
  "PORT_BINDING",
  "DATABASE_CONNECTIVITY",
  "PREEXISTING_TEST_FAILURE",
  "SANDBOX_LIMITATION",
  "LIARA_API_FAILURE",
  "UNSUPPORTED_CAPABILITY",
  "MEMORY_PRESSURE",
  "CPU_SATURATION",
  "CRASH_LOOP",
  "TLS_DNS",
  "UNKNOWN",
]);
export type FailureCategory = z.infer<typeof FailureCategory>;

/** Price information is never invented: it carries its provenance. */
export const Money = z.object({
  status: z.enum(["exact", "from_api", "estimate", "unavailable"]),
  hourlyToman: z.number().nullable(),
  monthlyToman: z.number().nullable(),
  source: z.string().nullable(),
  note: z.string().nullable(),
});
export type Money = z.infer<typeof Money>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired", "executing", "executed", "failed", "invalidated"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalView = z.object({
  id: z.string(),
  chatId: z.string().nullable(),
  runId: z.string().nullable(),
  incidentId: z.string().nullable(),
  projectName: z.string().nullable(),
  title: z.string(),
  toolLabel: z.string(),
  capabilityId: z.string(),
  resource: z.string(),
  risk: RiskLevel,
  reason: z.string(),
  evidence: z.array(z.string()),
  currentValue: z.string().nullable(),
  proposedValue: z.string().nullable(),
  diff: z.string().nullable(),
  effect: z.string(),
  downtime: z.string().nullable(),
  reversible: z.string().nullable(),
  cost: Money.nullable(),
  scope: z.string(),
  status: ApprovalStatus,
  requiresTypedConfirmation: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  resultSummary: z.string().nullable(),
});
export type ApprovalView = z.infer<typeof ApprovalView>;

export const AskOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  meta: z.string().optional(),
  recommended: z.boolean().optional(),
  disabled: z.boolean().optional(),
});
export type AskOption = z.infer<typeof AskOption>;

export const PlanOption = z.object({
  planId: z.string(),
  title: z.string(),
  cpu: z.number().nullable(),
  ramGb: z.number().nullable(),
  diskGb: z.number().nullable(),
  capacityHint: z.string().nullable(),
  price: Money,
  recommended: z.boolean(),
  available: z.boolean(),
  details: z.array(z.object({ label: z.string(), value: z.string() })),
});
export type PlanOption = z.infer<typeof PlanOption>;

export const InvoiceLine = z.object({ label: z.string(), detail: z.string().nullable(), price: Money });
export const Invoice = z.object({
  summary: z.array(z.object({ label: z.string(), value: z.string() })),
  lines: z.array(InvoiceLine),
  total: Money,
  balanceToman: z.number().nullable(),
  balanceSource: z.string().nullable(),
  notes: z.array(z.string()),
});
export type Invoice = z.infer<typeof Invoice>;

export const AskCard = z.object({
  id: z.string(),
  kind: z.enum(["choice", "slider", "select", "text", "plan", "invoice", "confirm", "source", "env", "multi"]),
  key: z.string(),
  badge: z.string().optional(),
  question: z.string(),
  description: z.string().optional(),
  recommendation: z.object({ value: z.string(), reason: z.string() }).optional(),
  options: z.array(AskOption).optional(),
  slider: z
    .object({ min: z.number(), max: z.number(), step: z.number(), unit: z.string(), marks: z.array(z.object({ value: z.number(), label: z.string() })), logScale: z.boolean().optional() })
    .optional(),
  text: z.object({ placeholder: z.string(), pattern: z.string().optional(), ltr: z.boolean().optional(), prefix: z.string().optional(), suffix: z.string().optional(), hint: z.string().optional(), secret: z.boolean().optional() }).optional(),
  envKeys: z.array(z.object({ key: z.string(), required: z.boolean(), hint: z.string().optional() })).optional(),
  plans: z.array(PlanOption).optional(),
  invoice: Invoice.optional(),
  tip: z.string().optional(),
  allowDefer: z.boolean(),
  state: z.enum(["pending", "answered", "deferred", "expired"]),
  answer: z.unknown().optional(),
  defaultValue: z.unknown().optional(),
});
export type AskCard = z.infer<typeof AskCard>;

export const StepView = z.object({
  key: z.string(),
  label: z.string(),
  status: CheckStatus,
  detail: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  command: z.string().nullable().optional(),
});
export type StepView = z.infer<typeof StepView>;

export const GateReport = z.object({
  overall: CheckStatus,
  stages: z.array(StepView),
  coverageNotes: z.array(z.string()),
  preexistingFailures: z.array(z.string()),
  sandbox: z.string(),
});
export type GateReport = z.infer<typeof GateReport>;

export const Hypothesis = z.object({
  title: z.string(),
  confidence: z.number().min(0).max(1),
  category: FailureCategory,
  evidence: z.array(z.string()),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const RootCauseReport = z.object({
  problem: z.string(),
  category: FailureCategory,
  confidence: z.number(),
  confidenceCalibrated: z.boolean(),
  symptom: z.string(),
  cause: z.string(),
  location: z.object({ file: z.string(), line: z.number().nullable(), snippet: z.string().nullable() }).nullable(),
  evidence: z.array(z.object({ source: z.string(), text: z.string(), at: z.string().nullable() })),
  alternatives: z.array(Hypothesis),
  proposedFix: z.string(),
  risks: z.array(z.string()),
  checks: z.array(z.string()),
  limitations: z.array(z.string()),
  attempts: z.array(z.object({ n: z.number(), label: z.string(), status: z.enum(["failed", "running", "succeeded", "pending"]) })),
  maxAttempts: z.number(),
});
export type RootCauseReport = z.infer<typeof RootCauseReport>;

export const MetricPoint = z.object({ t: z.number(), v: z.number() });
export const MetricSeries = z.object({ key: z.string(), label: z.string(), unit: z.string(), points: z.array(MetricPoint), source: z.string() });
export type MetricSeries = z.infer<typeof MetricSeries>;

export const VerificationCheck = z.object({
  key: z.string(),
  label: z.string(),
  status: CheckStatus,
  value: z.string().nullable(),
  baseline: z.string().nullable(),
  threshold: z.string().nullable(),
  evidence: z.string().nullable(),
  at: z.string(),
});
export type VerificationCheck = z.infer<typeof VerificationCheck>;

export const DeltaRow = z.object({ label: z.string(), before: z.string().nullable(), after: z.string().nullable(), improved: z.boolean().nullable() });
export type DeltaRow = z.infer<typeof DeltaRow>;

/** Rich chat content. Each assistant message carries an ordered list of blocks. */
export const Block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("ask"), card: AskCard }),
  z.object({ type: z.literal("approval"), approval: ApprovalView }),
  z.object({
    type: z.literal("timeline"),
    title: z.string(),
    subtitle: z.string().optional(),
    risk: RiskLevel.optional(),
    steps: z.array(StepView),
    logs: z.array(z.object({ level: z.enum(["info", "warn", "error", "cmd", "ok"]), text: z.string() })),
  }),
  z.object({ type: z.literal("gate"), report: GateReport }),
  z.object({ type: z.literal("root_cause"), report: RootCauseReport }),
  z.object({
    type: z.literal("patch"),
    patchId: z.string(),
    files: z.array(z.object({ path: z.string(), diff: z.string() })),
    testsPassed: z.string().nullable(),
    summary: z.string(),
    status: z.enum(["proposed", "applied", "rejected", "exported"]),
  }),
  z.object({
    type: z.literal("limitation"),
    title: z.string(),
    reason: z.string(),
    capabilityId: z.string().nullable(),
    steps: z.array(z.string()),
    link: z.object({ label: z.string(), href: z.string() }).nullable(),
  }),
  z.object({
    type: z.literal("incident"),
    incidentId: z.string(),
    title: z.string(),
    severity: Severity,
    state: IncidentState,
    metrics: z.array(z.object({ label: z.string(), value: z.string(), tone: z.enum(["ok", "warn", "bad"]) })),
    hypotheses: z.array(Hypothesis),
    signature: z.string().nullable(),
  }),
  z.object({ type: z.literal("verification"), title: z.string(), checks: z.array(VerificationCheck), delta: z.array(DeltaRow) }),
  z.object({ type: z.literal("success"), title: z.string(), url: z.string().nullable(), facts: z.array(z.object({ label: z.string(), value: z.string() })), next: z.array(z.string()) }),
  z.object({ type: z.literal("report"), title: z.string(), sections: z.array(z.object({ heading: z.string(), items: z.array(z.string()) })) }),
  z.object({ type: z.literal("table"), title: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.string())), ltrColumns: z.array(z.number()).optional() }),
  z.object({ type: z.literal("metrics"), title: z.string(), series: z.array(MetricSeries) }),
  z.object({ type: z.literal("code"), title: z.string(), language: z.string(), code: z.string() }),
]);
export type Block = z.infer<typeof Block>;

export const ChatMessage = z.object({
  id: z.string(),
  chatId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  blocks: z.array(Block),
  createdAt: z.string(),
  updatedAt: z.string(),
  streaming: z.boolean().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatSummary = z.object({
  id: z.string(),
  title: z.string(),
  projectName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  busy: z.boolean(),
});
export type ChatSummary = z.infer<typeof ChatSummary>;

export const ProjectSummary = z.object({
  name: z.string(),
  platform: z.string().nullable(),
  status: z.string().nullable(),
  planId: z.string().nullable(),
  environment: z.string().nullable(),
  health: z.enum(["healthy", "warning", "failing", "unknown", "stopped"]),
  lastDeployAt: z.string().nullable(),
  primaryDomain: z.string().nullable(),
  openIncidents: z.number(),
  hourlyPriceToman: z.number().nullable(),
  patrolEnabled: z.boolean(),
  source: z.enum(["liara", "mock"]),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const IncidentView = z.object({
  id: z.string(),
  code: z.string(),
  projectName: z.string(),
  title: z.string(),
  severity: Severity,
  state: IncidentState,
  service: z.string().nullable(),
  environment: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable(),
  occurrences: z.number(),
  probableCause: z.string().nullable(),
  confidence: z.number().nullable(),
  fingerprint: z.string(),
  hypotheses: z.array(Hypothesis),
  timeline: z.array(z.object({ at: z.string(), label: z.string(), kind: z.string() })),
  impact: z.string().nullable(),
  approvalId: z.string().nullable(),
  notes: z.array(z.object({ at: z.string(), text: z.string() })),
  acknowledged: z.boolean(),
});
export type IncidentView = z.infer<typeof IncidentView>;

export const PatrolSettings = z.object({
  projectName: z.string(),
  enabled: z.boolean(),
  intervalHours: z.number(),
  healthUrl: z.string().nullable(),
  checks: z.record(z.string(), z.boolean()),
  channels: z.object({ inApp: z.boolean(), telegram: z.boolean(), email: z.boolean() }),
  autoRestartOnCrashLoop: z.boolean(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
});
export type PatrolSettings = z.infer<typeof PatrolSettings>;

export const PatrolRunView = z.object({
  id: z.string(),
  projectName: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(["healthy", "warning", "unhealthy", "error", "running"]),
  checks: z.array(VerificationCheck),
  llmCalls: z.number(),
  incidentId: z.string().nullable(),
  trigger: z.enum(["schedule", "manual", "catch_up"]),
});
export type PatrolRunView = z.infer<typeof PatrolRunView>;

export const NotificationView = z.object({
  id: z.string(),
  kind: z.enum(["approval", "incident", "deploy", "patrol", "info"]),
  title: z.string(),
  body: z.string(),
  severity: z.enum(["info", "warning", "critical", "success"]),
  href: z.string().nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});
export type NotificationView = z.infer<typeof NotificationView>;

export const AuditEntry = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.string(),
  kind: z.string(),
  capabilityId: z.string().nullable(),
  resource: z.string().nullable(),
  risk: RiskLevel.nullable(),
  approvalId: z.string().nullable(),
  status: z.string(),
  errorCode: z.string().nullable(),
  durationMs: z.number().nullable(),
  args: z.unknown(),
  chatId: z.string().nullable(),
  runId: z.string().nullable(),
  mode: AppMode,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const CapabilityView = z.object({
  id: z.string(),
  service: z.string(),
  name: z.string(),
  labelFa: z.string(),
  status: CapabilityStatus,
  risk: RiskLevel,
  method: z.string().nullable(),
  endpoint: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  evidence: z.string(),
  notes: z.string().nullable(),
  exposedToAgent: z.boolean(),
});
export type CapabilityView = z.infer<typeof CapabilityView>;

export const ModelView = z.object({
  id: z.string(),
  providerId: z.string(),
  kind: z.enum(["chat", "embedding"]),
  available: z.enum(["verified", "listed", "unavailable", "unknown"]),
  contextLength: z.number().nullable(),
  promptPricePerToken: z.number().nullable(),
  completionPricePerToken: z.number().nullable(),
  supports: z.record(z.string(), z.enum(["supported", "unsupported", "unknown"])),
  roles: z.array(z.string()),
  lastProbe: z.object({ at: z.string(), ok: z.boolean(), latencyMs: z.number().nullable(), note: z.string().nullable() }).nullable(),
});
export type ModelView = z.infer<typeof ModelView>;
