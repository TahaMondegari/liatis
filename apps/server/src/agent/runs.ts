import type { Ctx } from "../context.js";
import { json } from "../db/db.js";
import { newId } from "../util.js";

export type RunKind = "deploy" | "ops" | "incident" | "repair";
export type RunStatus = "running" | "waiting_user" | "waiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";

export interface Run<S> {
  id: string;
  chatId: string | null;
  kind: RunKind;
  status: RunStatus;
  step: string;
  state: S;
}

/** Durable workflow checkpoints: every step transition is persisted before side effects continue. */
export class RunStore {
  constructor(private ctx: Ctx) {}

  create<S>(kind: RunKind, chatId: string | null, step: string, state: S): Run<S> {
    const id = newId("run");
    const now = this.ctx.clock.now().toISOString();
    this.ctx.db.run("INSERT INTO runs(id, chat_id, kind, status, step, state_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)", id, chatId, kind, "running", step, JSON.stringify(state), now, now);
    return { id, chatId, kind, status: "running", step, state };
  }

  get<S>(id: string): Run<S> | null {
    const r = this.ctx.db.get<Record<string, unknown>>("SELECT * FROM runs WHERE id = ?", id);
    return r ? { id: String(r.id), chatId: (r.chat_id as string) ?? null, kind: r.kind as RunKind, status: r.status as RunStatus, step: String(r.step), state: json<S>(r.state_json, {} as S) } : null;
  }

  save<S>(run: Run<S>): void {
    this.ctx.db.run("UPDATE runs SET status = ?, step = ?, state_json = ?, updated_at = ? WHERE id = ?", run.status, run.step, JSON.stringify(run.state), this.ctx.clock.now().toISOString(), run.id);
  }

  fail<S>(run: Run<S>, error: string): void {
    run.status = "failed";
    this.ctx.db.run("UPDATE runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", error.slice(0, 2000), this.ctx.clock.now().toISOString(), run.id);
  }

  activeForChat<S>(chatId: string, kind?: RunKind): Run<S> | null {
    const r = this.ctx.db.get<{ id: string }>(
      "SELECT id FROM runs WHERE chat_id = ? AND status IN ('running','waiting_user','waiting_approval') AND (? IS NULL OR kind = ?) ORDER BY created_at DESC LIMIT 1",
      chatId,
      kind ?? null,
      kind ?? null,
    );
    return r ? this.get<S>(r.id) : null;
  }

  /** On boot: runs that were mid-step when the process died. */
  interrupted(): Run<unknown>[] {
    return this.ctx.db.all<{ id: string }>("SELECT id FROM runs WHERE status = 'running'").map((r) => this.get(r.id)!);
  }
}
