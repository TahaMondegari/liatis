import { EventEmitter } from "node:events";
import { EventPayloads, type AnyEvent, type EventPayload, type EventType } from "@liara-agent/shared";
import type { Db } from "../db/db.js";
import { redact } from "../security/redact.js";
import { newId, iso } from "../util.js";

type Listener = (e: AnyEvent) => void;

/**
 * Persisted event bus. Every event is redacted, validated against the shared
 * zod schema, stored (for SSE replay via Last-Event-ID) and fanned out.
 */
export class EventBus {
  private emitter = new EventEmitter();
  constructor(private db: Db) {
    this.emitter.setMaxListeners(500);
  }

  emit<T extends EventType>(type: T, payload: EventPayload<T>, ctx: { chatId?: string | null; runId?: string | null } = {}): AnyEvent {
    const clean = redact(payload);
    const parsed = EventPayloads[type].safeParse(clean);
    if (!parsed.success) {
      // Schema drift is a programming error; surface it loudly in dev and tests.
      throw new Error(`invalid ${type} payload: ${parsed.error.message}`);
    }
    const id = newId("ev");
    const ts = iso();
    const chatId = ctx.chatId ?? null;
    const runId = ctx.runId ?? null;
    // message.delta is high-frequency and reconstructable from message.updated; don't persist.
    let seq = 0;
    if (type !== "message.delta") {
      seq = this.db.run("INSERT INTO events(id, ts, type, chat_id, run_id, payload_json) VALUES(?,?,?,?,?,?)", id, ts, type, chatId, runId, JSON.stringify(parsed.data)).lastInsertRowid;
    }
    const ev = { seq, id, ts, type, chatId, runId, payload: parsed.data } as AnyEvent;
    this.emitter.emit("event", ev);
    return ev;
  }

  subscribe(fn: Listener): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }

  /** Replay persisted events after a cursor (SSE reconnect). */
  replay(afterSeq: number, chatId: string | null, limit = 500): AnyEvent[] {
    const rows = chatId
      ? this.db.all<{ seq: number; id: string; ts: string; type: string; chat_id: string | null; run_id: string | null; payload_json: string }>(
          "SELECT * FROM events WHERE seq > ? AND (chat_id = ? OR chat_id IS NULL) ORDER BY seq LIMIT ?",
          afterSeq,
          chatId,
          limit,
        )
      : this.db.all<{ seq: number; id: string; ts: string; type: string; chat_id: string | null; run_id: string | null; payload_json: string }>(
          "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
          afterSeq,
          limit,
        );
    return rows.map((r) => ({ seq: r.seq, id: r.id, ts: r.ts, type: r.type, chatId: r.chat_id, runId: r.run_id, payload: JSON.parse(r.payload_json) }) as AnyEvent);
  }
}
