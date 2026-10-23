import { z } from "zod";
import { ApprovalView, ChatMessage, IncidentView, NotificationView, PatrolRunView, CheckStatus } from "./domain.js";

/**
 * SSE event catalogue. Defined once here and consumed by both server
 * (validation before emit) and web (typed reducer), so they cannot drift.
 */
export const EventPayloads = {
  "agent.started": z.object({ label: z.string() }),
  "run.phase": z.object({ phase: z.string(), label: z.string(), startedAt: z.string() }),
  "message.created": z.object({ message: ChatMessage }),
  "message.updated": z.object({ message: ChatMessage }),
  "message.delta": z.object({ messageId: z.string(), delta: z.string() }),
  "step.started": z.object({ key: z.string(), label: z.string() }),
  "step.progress": z.object({ key: z.string(), label: z.string(), percent: z.number().nullable() }),
  "step.done": z.object({ key: z.string(), status: CheckStatus, durationMs: z.number().nullable() }),
  "log.line": z.object({ stream: z.string(), level: z.enum(["info", "warn", "error", "cmd", "ok"]), text: z.string() }),
  "tool.started": z.object({ toolCallId: z.string(), label: z.string(), risk: z.string() }),
  "tool.completed": z.object({ toolCallId: z.string(), ok: z.boolean(), summary: z.string() }),
  "approval.request": z.object({ approval: ApprovalView }),
  "approval.received": z.object({ approval: ApprovalView }),
  "incident.updated": z.object({ incident: IncidentView }),
  "patrol.run": z.object({ run: PatrolRunView }),
  notification: z.object({ notification: NotificationView }),
  "limitation.notice": z.object({ capabilityId: z.string().nullable(), title: z.string(), reason: z.string() }),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
  done: z.object({ status: z.enum(["completed", "waiting_for_user", "waiting_for_approval", "failed", "cancelled"]) }),
} as const;

export type EventType = keyof typeof EventPayloads;
export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

export interface EventEnvelope<T extends EventType = EventType> {
  /** Monotonic per-server sequence; used as SSE id for replay (Last-Event-ID). */
  seq: number;
  id: string;
  ts: string;
  type: T;
  chatId: string | null;
  runId: string | null;
  payload: EventPayload<T>;
}

export type AnyEvent = { [K in EventType]: EventEnvelope<K> }[EventType];

export const EVENT_TYPES = Object.keys(EventPayloads) as EventType[];
