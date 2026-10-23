"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnyEvent, ChatMessage, ChatSummary, ProjectSummary } from "@liara-agent/shared";
import { api, post } from "@/lib/api";
import { faElapsed, faNum } from "@/lib/fa";
import t from "@/messages/fa.json";
import { BlockView } from "./blocks/Blocks";
import { useShell } from "./shell";
import { Dots, ErrorNote } from "./ui/primitives";

interface Phase {
  label: string;
  startedAt: number;
}

export function ChatScreen({ chatId }: { chatId: string | null }) {
  const router = useRouter();
  const { subscribe, meta, conn } = useShell();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now());
  const endRef = useRef<HTMLDivElement>(null);

  const loadChats = useCallback(() => api<ChatSummary[]>("/api/chats").then(setChats).catch(() => undefined), []);
  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    setMessages([]);
    setPhase(null);
    setBusy(false);
    if (!chatId) return;
    api<{ chat: ChatSummary; messages: ChatMessage[] }>(`/api/chats/${chatId}`)
      .then((r) => {
        setMessages(r.messages);
        setBusy(r.chat.busy);
      })
      .catch((e) => setErr(e));
  }, [chatId]);

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(
    () =>
      subscribe((e: AnyEvent) => {
        if (e.chatId && e.chatId !== chatId) {
          if (e.type === "message.created" || e.type === "done") void loadChats();
          return;
        }
        switch (e.type) {
          case "message.created":
          case "message.updated": {
            const m = e.payload.message;
            if (m.chatId !== chatId) return;
            setMessages((prev) => {
              const i = prev.findIndex((x) => x.id === m.id);
              if (i < 0) return [...prev, m];
              const next = prev.slice();
              next[i] = m;
              return next;
            });
            break;
          }
          case "message.delta":
            setMessages((prev) => prev.map((m) => (m.id === e.payload.messageId ? { ...m, text: m.text + e.payload.delta } : m)));
            break;
          case "run.phase":
            if (!e.chatId) return;
            setBusy(true);
            setPhase({ label: e.payload.label, startedAt: Date.parse(e.payload.startedAt) });
            break;
          case "agent.started":
            setBusy(true);
            break;
          case "done":
            if (!e.chatId) return;
            setBusy(false);
            setPhase(e.payload.status === "waiting_for_approval" ? { label: "در انتظار تأیید شما", startedAt: Date.now() } : e.payload.status === "waiting_for_user" ? { label: "منتظر انتخاب شما", startedAt: Date.now() } : null);
            void loadChats();
            break;
          case "error":
            setErr({ message: e.payload.message });
            setBusy(false);
            break;
        }
      }),
    [subscribe, chatId, loadChats],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, phase?.label]);

  const send = async (msg: string) => {
    const body = msg.trim();
    if (!body || busy) return;
    setErr(null);
    setBusy(true);
    setPhase({ label: "در حال تحلیل درخواست", startedAt: Date.now() });
    try {
      let id = chatId;
      if (!id) {
        const c = await post<ChatSummary>("/api/chats");
        id = c.id;
        router.replace(`/chat/${id}`);
      }
      setText("");
      await post(`/api/chats/${id}/messages`, { text: body });
    } catch (e) {
      setErr(e);
      setBusy(false);
      setPhase(null);
    }
  };

  return (
    <div className="mx-auto grid max-w-[1500px] lg:grid-cols-[290px_minmax(0,1fr)]">
      <Sidebar chats={chats} chatId={chatId} pending={meta?.pendingApprovals ?? 0} />
      <main className="flex min-h-[calc(100dvh-56px)] flex-col gap-5 px-4 py-6 md:px-10">
        <div className="mx-auto flex w-full max-w-[900px] flex-1 flex-col gap-5">
          {!chatId && messages.length === 0 && <Welcome onPick={(s) => void send(s)} demo={meta?.mode === "demo"} />}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="fade-up max-w-[600px] self-start rounded-2xl border border-[#232940] bg-raised px-4 py-3 text-sm leading-8">
                <div>{m.text}</div>
              </div>
            ) : (
              <div key={m.id} className="flex items-start gap-3">
                <div aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary font-bold text-[#06101f]">
                  L
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  {m.text && <p className="whitespace-pre-wrap text-sm leading-8 text-[#cfd6ee]">{m.text}</p>}
                  {m.blocks.map((b, i) => (
                    <BlockView key={`${m.id}-${i}-${b.type}`} block={b} chatId={m.chatId} />
                  ))}
                </div>
              </div>
            ),
          )}
          {(busy || phase) && (
            <div className="flex items-center gap-3 text-sm text-muted" role="status" aria-live="polite">
              <div aria-hidden className="pulse-dot flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-primary/50 bg-primary/15 font-bold text-primary-soft">
                L
              </div>
              {busy && <Dots />}
              <span>{conn === "reconnecting" ? t.conn.reconnecting : (phase?.label ?? "در حال فکر کردن")}</span>
              {phase && busy && <span className="text-xs text-faint">· {faElapsed(now - phase.startedAt)}</span>}
            </div>
          )}
          <ErrorNote error={err} />
          <div ref={endRef} />
        </div>
        <form
          className="card sticky bottom-4 mx-auto w-full max-w-[900px] border-[#3a5fc4] p-3.5 shadow-[0_0_30px_#5b8cff22]"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <textarea
            aria-label="پیام به ایجنت"
            placeholder={t.chat.placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(text);
              }
            }}
            rows={2}
            className="w-full resize-none bg-transparent text-[15px] text-ink outline-none"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted">{busy ? t.chat.busy : t.chat.hint}</span>
            <button className="btn-primary !h-10" disabled={busy || !text.trim()}>
              {t.chat.send}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function Welcome({ onPick, demo }: { onPick: (s: string) => void; demo: boolean }) {
  return (
    <div className="fade-up mt-6 flex flex-col items-center gap-4 text-center">
      <div className="relative h-16 w-16" style={{ perspective: 700 }}>
        <div className="absolute inset-0 rounded-2xl border border-primary-soft/60 bg-primary/20" style={{ transform: "rotateX(-24deg) rotateY(35deg)", animation: "float 8s ease-in-out infinite" }} />
      </div>
      <h1 className="text-2xl font-bold">{t.chat.empty_title}</h1>
      <p className="max-w-lg text-sm leading-8 text-muted">{t.chat.empty_sub}</p>
      {demo && <p className="badge !border-warning/50 !bg-warning/15 !text-[#fcd34d]">حالت دمو: هیچ درخواستی به لیارای واقعی ارسال نمی‌شه</p>}
      <div className="mt-2 flex max-w-2xl flex-wrap justify-center gap-2">
        {t.chat.examples.map((ex) => (
          <button key={ex} className="chip hover:border-primary" onClick={() => onPick(ex)}>
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

function Sidebar({ chats, chatId, pending }: { chats: ChatSummary[]; chatId: string | null; pending: number }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [acct, setAcct] = useState<{ balance: number | null; hourlyToman: number | null; runwayDays: number | null; activeServices: number; unknownPriced: number } | null>(null);
  useEffect(() => {
    api<ProjectSummary[]>("/api/projects").then(setProjects).catch(() => undefined);
    api<typeof acct>("/api/account").then(setAcct).catch(() => undefined);
  }, []);
  const dot = (h: string) => (h === "healthy" ? "bg-success" : h === "warning" ? "bg-warning" : h === "failing" ? "bg-danger" : "bg-faint");
  return (
    <aside className="hidden flex-col gap-1 border-l border-[#1a1e2e] bg-[#090b12e6] px-4 py-5 lg:flex" aria-label="چت‌ها و پروژه‌ها">
      <Link href="/chat" className="btn-ghost flex items-center justify-center border-primary bg-primary/10 text-white">
        {t.chat.new}
      </Link>
      <Link href="/approvals" className="nav-link mt-2 justify-between">
        <span>{t.nav.approvals}</span>
        {pending > 0 && <span className="badge !border-danger/60 !bg-danger/20 !text-[#fda4af]">{faNum(pending)}</span>}
      </Link>
      <p className="mx-3 mb-2 mt-5 text-xs text-faint">{t.chat.previous}</p>
      <div className="flex max-h-[34vh] flex-col gap-0.5 overflow-auto">
        {chats.map((c) => (
          <Link key={c.id} href={`/chat/${c.id}`} aria-current={c.id === chatId ? "page" : undefined} className="nav-link">
            <span className="truncate">{c.title}</span>
            {c.busy && <span className="pulse-dot mr-auto h-2 w-2 shrink-0 rounded-full bg-primary" />}
          </Link>
        ))}
        {chats.length === 0 && <p className="px-3 text-xs text-faint">هنوز چتی نداری.</p>}
      </div>
      <p className="mx-3 mb-2 mt-5 text-xs text-faint">{t.chat.deployed}</p>
      {projects.slice(0, 8).map((p) => (
        <Link key={p.name} href={`/projects/${p.name}`} className="nav-link">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot(p.health)}`} />
          <span className="mono ltr truncate text-[13px]">{p.name}</span>
          {p.environment && <span className="text-[11px] text-faint">· {p.environment === "production" ? "پروداکشن" : p.environment === "demo" ? "دمو" : "تست"}</span>}
        </Link>
      ))}
      <div className="flex-1" />
      <div className="card mt-4 p-3.5">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11" style={{ perspective: 700 }}>
            <div className="coin">ت</div>
          </div>
          <div>
            <div className="text-xs text-muted">{t.wallet.title}</div>
            <div className="text-lg font-bold">
              {acct?.balance !== null && acct?.balance !== undefined ? faNum(acct.balance) : "—"} <span className="text-xs font-normal text-muted">تومان</span>
            </div>
          </div>
        </div>
        {acct?.hourlyToman ? (
          <div className="mt-2">
            <div className="row-dash !py-1.5 text-[13px]">
              <span>{t.wallet.hourly}</span>
              <b>−{faNum(Math.round(acct.hourlyToman))}</b>
            </div>
            <div className="row-dash !py-1.5 text-[13px]">
              <span>{t.wallet.daily}</span>
              <b>−{faNum(Math.round(acct.hourlyToman * 24))}</b>
            </div>
            <div className="row-dash !py-1.5 text-[13px]">
              <span>{t.wallet.monthly}</span>
              <b>−{faNum(Math.round(acct.hourlyToman * 730))}</b>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-faint">
              بر پایه {faNum(acct.activeServices)} برنامه‌ی فعال{acct.runwayDays !== null ? `، موجودی حدود ${faNum(acct.runwayDays)} روز کافیه` : ""}.{acct.unknownPriced ? ` (${faNum(acct.unknownPriced)} مورد بدون قیمت)` : ""} دیتابیس و سایر سرویس‌ها حساب نشدن.
            </p>
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-faint">{t.wallet.unknown}</p>
        )}
        <a className="btn-ghost btn-sm mt-3 flex w-full items-center justify-center" href="https://console.liara.ir/billing" target="_blank" rel="noreferrer noopener">
          {t.wallet.topup}
        </a>
      </div>
    </aside>
  );
}
