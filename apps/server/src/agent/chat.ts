import type { AskCard, Block, ChatMessage, ChatSummary } from "@liara-agent/shared";
import type { Ctx } from "../context.js";
import { json } from "../db/db.js";
import { redact } from "../security/redact.js";
import { PHASE_FA, type Phase } from "../i18n/fa.js";
import { newId, truncate } from "../util.js";

/** Persistence + SSE fan-out for chats and their rich messages. */
export class ChatService {
  constructor(private ctx: Ctx) {}

  create(title = "چت جدید", projectName: string | null = null): ChatSummary {
    const id = newId("chat");
    const now = this.ctx.clock.now().toISOString();
    this.ctx.db.run("INSERT INTO chats(id, title, project_name, created_at, updated_at, busy) VALUES(?,?,?,?,?,0)", id, title, projectName, now, now);
    return this.summary(id)!;
  }

  summary(id: string): ChatSummary | null {
    const r = this.ctx.db.get<Record<string, unknown>>("SELECT * FROM chats WHERE id = ?", id);
    return r ? { id: String(r.id), title: String(r.title), projectName: (r.project_name as string) ?? null, createdAt: String(r.created_at), updatedAt: String(r.updated_at), busy: Boolean(r.busy) } : null;
  }

  list(): ChatSummary[] {
    return this.ctx.db.all<Record<string, unknown>>("SELECT * FROM chats ORDER BY updated_at DESC LIMIT 200").map((r) => ({ id: String(r.id), title: String(r.title), projectName: (r.project_name as string) ?? null, createdAt: String(r.created_at), updatedAt: String(r.updated_at), busy: Boolean(r.busy) }));
  }

  remove(id: string): void {
    this.ctx.db.run("DELETE FROM chats WHERE id = ?", id);
  }

  setProject(chatId: string, project: string): void {
    this.ctx.db.run("UPDATE chats SET project_name = ? WHERE id = ?", project, chatId);
  }

  rename(chatId: string, title: string): void {
    this.ctx.db.run("UPDATE chats SET title = ? WHERE id = ?", truncate(title, 60), chatId);
  }

  messages(chatId: string): ChatMessage[] {
    return this.ctx.db
      .all<Record<string, unknown>>("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at, rowid", chatId)
      .map((r) => ({ id: String(r.id), chatId, role: r.role as ChatMessage["role"], text: String(r.text), blocks: json<Block[]>(r.blocks_json, []), createdAt: String(r.created_at), updatedAt: String(r.updated_at) }));
  }

  message(id: string): ChatMessage | null {
    const r = this.ctx.db.get<Record<string, unknown>>("SELECT * FROM messages WHERE id = ?", id);
    return r ? { id: String(r.id), chatId: String(r.chat_id), role: r.role as ChatMessage["role"], text: String(r.text), blocks: json<Block[]>(r.blocks_json, []), createdAt: String(r.created_at), updatedAt: String(r.updated_at) } : null;
  }

  post(chatId: string, role: ChatMessage["role"], text: string, blocks: Block[] = []): ChatMessage {
    const now = this.ctx.clock.now().toISOString();
    const m: ChatMessage = redact({ id: newId("msg"), chatId, role, text, blocks, createdAt: now, updatedAt: now });
    this.ctx.db.run("INSERT INTO messages(id, chat_id, role, text, blocks_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?)", m.id, chatId, role, m.text, JSON.stringify(m.blocks), now, now);
    this.ctx.db.run("UPDATE chats SET updated_at = ? WHERE id = ?", now, chatId);
    this.ctx.bus.emit("message.created", { message: m }, { chatId });
    return m;
  }

  update(m: ChatMessage, patch: { text?: string; blocks?: Block[] }): ChatMessage {
    const next: ChatMessage = redact({ ...m, ...patch, updatedAt: this.ctx.clock.now().toISOString() });
    this.ctx.db.run("UPDATE messages SET text = ?, blocks_json = ?, updated_at = ? WHERE id = ?", next.text, JSON.stringify(next.blocks), next.updatedAt, m.id);
    this.ctx.bus.emit("message.updated", { message: next }, { chatId: m.chatId });
    return next;
  }

  /** Replace one block (matched by predicate) inside a message, keeping order. */
  patchBlock(messageId: string, match: (b: Block) => boolean, replace: (b: Block) => Block): ChatMessage | null {
    const m = this.message(messageId);
    if (!m) return null;
    return this.update(m, { blocks: m.blocks.map((b) => (match(b) ? replace(b) : b)) });
  }

  /** Locate the message holding an ask card. */
  findAsk(chatId: string, cardId: string): { message: ChatMessage; card: AskCard } | null {
    for (const m of this.messages(chatId).reverse()) {
      for (const b of m.blocks) if (b.type === "ask" && b.card.id === cardId) return { message: m, card: b.card };
    }
    return null;
  }

  /** Every approval card is mirrored into the chat; this refreshes it after a decision. */
  refreshApproval(approvalId: string): void {
    const a = this.ctx.approvals.get(approvalId);
    if (!a?.chatId) return;
    for (const m of this.messages(a.chatId)) {
      if (m.blocks.some((b) => b.type === "approval" && b.approval.id === approvalId)) {
        this.update(m, { blocks: m.blocks.map((b) => (b.type === "approval" && b.approval.id === approvalId ? { type: "approval", approval: a } : b)) });
      }
    }
  }

  busy(chatId: string, on: boolean): void {
    this.ctx.db.run("UPDATE chats SET busy = ? WHERE id = ?", on ? 1 : 0, chatId);
  }

  phase(chatId: string, phase: Phase, runId: string | null = null, label?: string): void {
    this.ctx.bus.emit("run.phase", { phase, label: label ?? PHASE_FA[phase], startedAt: this.ctx.clock.now().toISOString() }, { chatId, runId });
  }

  done(chatId: string, status: "completed" | "waiting_for_user" | "waiting_for_approval" | "failed" | "cancelled", runId: string | null = null): void {
    this.busy(chatId, false);
    this.ctx.bus.emit("done", { status }, { chatId, runId });
  }
}
