import type { NotificationView } from "@liara-agent/shared";
import type { Db } from "../db/db.js";
import type { EventBus } from "../events/bus.js";
import type { ToolGateway } from "../tools/gateway.js";
import { redactString } from "../security/redact.js";
import { type Clock, newId } from "../util.js";

export interface NotifyChannels {
  telegram: { token: string | null; chatId: string | null };
  /** Liara Mail (mail.sendMail) — requires a mail server the user owns. */
  mail: { serverId: string | null; from: string | null; to: string | null };
  publicUrl: string;
}

/**
 * Notification center: in-app inbox (DB + SSE), optional Telegram, optional
 * email through the official Liara Mail API. External messages are short and
 * carry only a deep link; actions always require login + approval in the app.
 */
export class Notifier {
  constructor(
    private db: Db,
    private bus: EventBus,
    private clock: Clock,
    private channels: NotifyChannels,
    private gateway: () => ToolGateway | null,
  ) {}

  push(n: Omit<NotificationView, "id" | "read" | "createdAt">, opts: { dedupeKey?: string; external?: boolean } = {}): NotificationView | null {
    const v: NotificationView = { ...n, id: newId("ntf"), read: false, createdAt: this.clock.now().toISOString() };
    try {
      this.db.run("INSERT INTO notifications(id, kind, title, body, severity, href, read, created_at, dedupe_key) VALUES(?,?,?,?,?,?,?,?,?)", v.id, v.kind, v.title, v.body, v.severity, v.href, 0, v.createdAt, opts.dedupeKey ?? null);
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) return null; // already notified
      throw e;
    }
    this.bus.emit("notification", { notification: v });
    if (opts.external) void this.external(v);
    return v;
  }

  private async external(v: NotificationView): Promise<void> {
    const text = `ایجنت لیارا\n${v.title}\n${v.href ? `${this.channels.publicUrl}${v.href}` : ""}`;
    const tg = this.channels.telegram;
    if (tg.token && tg.chatId) {
      await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: tg.chatId, text: redactString(text), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
    const m = this.channels.mail;
    const gw = this.gateway();
    if (m.serverId && m.from && m.to && gw) {
      // Standing authorization (policy) allows this single recipient within a daily cap.
      await gw
        .run(
          {
            capabilityId: "mail.sendMail",
            req: { pathParams: { mailServerID: m.serverId }, body: { from: m.from, to: m.to, subject: v.title.slice(0, 120), text: redactString(text) } },
            resource: m.to,
            title: "ارسال اعلان ایمیلی",
            reason: "اعلان پایش",
            effect: "یک ایمیل اطلاع‌رسانی ارسال می‌شه",
          },
          { actor: "patrol", chatId: null, runId: null },
        )
        .catch(() => undefined);
    }
  }

  list(limit = 50): NotificationView[] {
    return this.db
      .all<Record<string, unknown>>("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?", limit)
      .map((r) => ({ id: String(r.id), kind: r.kind as NotificationView["kind"], title: String(r.title), body: String(r.body), severity: r.severity as NotificationView["severity"], href: (r.href as string) ?? null, read: Boolean(r.read), createdAt: String(r.created_at) }));
  }

  markRead(id: string | "all"): void {
    if (id === "all") this.db.run("UPDATE notifications SET read = 1");
    else this.db.run("UPDATE notifications SET read = 1 WHERE id = ?", id);
  }

  unread(): number {
    return Number(this.db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE read = 0")?.n ?? 0);
  }
}
