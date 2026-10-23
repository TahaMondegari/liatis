"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { AnyEvent, NotificationView } from "@liara-agent/shared";
import { api, post, setToken } from "@/lib/api";
import { faAgo, faNum } from "@/lib/fa";
import { useEvents, type ConnState } from "@/lib/useEvents";
import t from "@/messages/fa.json";
import { Modal } from "./ui/primitives";

export interface Meta {
  mode: "demo" | "real";
  liaraTransport: "http" | "mock";
  ai: { configured: boolean; workspaceId: string | null; todayToman: number; dailyBudgetToman: number };
  sandbox: { kind: string; label: string; available: boolean; reason: string | null };
  pendingApprovals: number;
  unreadNotifications: number;
  openIncidents: number;
  maxRepairAttempts: number;
  monitorIntervalHours: number;
}

type Listener = (e: AnyEvent) => void;
const ShellCtx = createContext<{ meta: Meta | null; conn: ConnState; refresh: () => void; subscribe: (fn: Listener) => () => void }>({ meta: null, conn: "connecting", refresh: () => {}, subscribe: () => () => {} });
export const useShell = () => useContext(ShellCtx);

const NAV: { href: string; label: string; badge?: keyof Meta }[] = [
  { href: "/chat", label: t.nav.chat },
  { href: "/projects", label: t.nav.projects },
  { href: "/incidents", label: t.nav.incidents, badge: "openIncidents" },
  { href: "/approvals", label: t.nav.approvals, badge: "pendingApprovals" },
  { href: "/activity", label: t.nav.activity },
  { href: "/capabilities", label: t.nav.capabilities },
  { href: "/ai", label: t.nav.ai },
];

export function Shell({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [listeners] = useState(() => new Set<Listener>());
  const [needAuth, setNeedAuth] = useState(false);
  const [tok, setTok] = useState("");
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState<NotificationView[]>([]);
  const path = usePathname();

  const refresh = useCallback(() => {
    api<Meta>("/api/meta").then(setMeta).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const onAuth = () => setNeedAuth(true);
    window.addEventListener("liara-auth-required", onAuth);
    const iv = setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("liara-auth-required", onAuth);
      clearInterval(iv);
    };
  }, [refresh]);

  const conn = useEvents(null, (e) => {
    if (["approval.request", "approval.received", "incident.updated", "notification", "done"].includes(e.type)) refresh();
    if (e.type === "notification") setNotifs((n) => [e.payload.notification, ...n].slice(0, 50));
    for (const l of listeners) l(e);
  });
  const subscribe = useCallback(
    (fn: Listener) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    [listeners],
  );

  const openNotifs = async () => {
    setNotifOpen(true);
    const r = await api<{ items: NotificationView[] }>("/api/notifications").catch(() => null);
    if (r) setNotifs(r.items);
    await post("/api/notifications/read", { id: "all" }).catch(() => undefined);
    refresh();
  };

  return (
    <ShellCtx.Provider value={{ meta, conn, refresh, subscribe }}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2">
        پرش به محتوا
      </a>
      <header className="sticky top-0 z-30 border-b border-[#1a1e2e] bg-[#090b12e6] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-3 px-4">
          <Link href="/chat" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary font-bold text-[#06101f]">L</span>
            <span className="hidden leading-tight sm:block">
              <b className="block text-sm">{t.app.name}</b>
              <span className="text-[11px] text-muted">{t.app.brand}</span>
            </span>
          </Link>
          <nav aria-label="ناوبری اصلی" className="flex flex-1 items-center gap-1 overflow-x-auto">
            {NAV.map((n) => {
              const active = path === n.href || path.startsWith(`${n.href}/`);
              const count = n.badge && meta ? (meta[n.badge] as number) : 0;
              return (
                <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className="nav-link shrink-0 !h-9 text-[13px]">
                  {n.label}
                  {count > 0 && <span className="badge !border-danger/60 !bg-danger/20 !text-[#fda4af]">{faNum(count)}</span>}
                </Link>
              );
            })}
          </nav>
          {meta && (
            <span className={`badge shrink-0 ${meta.mode === "demo" ? "!border-warning/60 !bg-warning/15 !text-[#fcd34d]" : "!border-success/60 !bg-success/15 !text-[#6ee7b7]"}`} title={meta.mode === "demo" ? "همه‌ی داده‌ها نمونه‌ان و هیچ درخواستی به لیارا ارسال نمی‌شه" : "متصل به API واقعی لیارا"}>
              {meta.mode === "demo" ? "DEMO · داده نمونه" : "REAL"}
            </span>
          )}
          <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-muted md:flex" aria-live="polite">
            <span className={`h-2 w-2 rounded-full ${conn === "open" ? "bg-success" : conn === "reconnecting" ? "bg-warning pulse-dot" : "bg-faint"}`} />
            {t.conn[conn]}
          </span>
          <button className="btn-ghost btn-sm relative shrink-0" onClick={openNotifs} aria-label="مرکز اعلان‌ها">
            🔔
            {(meta?.unreadNotifications ?? 0) > 0 && <span className="absolute -top-1 -left-1 h-4 min-w-4 rounded-full bg-danger px-1 text-[10px] leading-4 text-white">{faNum(meta!.unreadNotifications)}</span>}
          </button>
        </div>
      </header>
      <div id="main">{children}</div>

      <Modal open={notifOpen} onClose={() => setNotifOpen(false)} title="اعلان‌ها">
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-auto">
          {notifs.length === 0 && <p className="text-sm text-muted">اعلانی نیست. اگه همه‌چیز سالم باشه، مزاحمت نمی‌شم.</p>}
          {notifs.map((n) => (
            <Link key={n.id} href={n.href ?? "#"} onClick={() => setNotifOpen(false)} className="panel block p-3">
              <div className="flex items-center justify-between gap-2">
                <b className={`text-sm st-${n.severity === "critical" ? "FAIL" : n.severity === "warning" ? "WARN" : n.severity === "success" ? "PASS" : "unknown"}`}>{n.title}</b>
                <span className="text-[11px] text-faint">{faAgo(n.createdAt)}</span>
              </div>
              <p className="mt-1 text-xs leading-6 text-muted">{n.body}</p>
            </Link>
          ))}
        </div>
      </Modal>

      <Modal open={needAuth} onClose={() => setNeedAuth(false)} title={t.auth.title}>
        <p className="mb-3 text-sm text-muted">{t.auth.sub}</p>
        <input className="field mono ltr" type="password" value={tok} onChange={(e) => setTok(e.target.value)} aria-label="APP_AUTH_TOKEN" />
        <button
          className="btn-primary mt-4 w-full"
          onClick={() => {
            setToken(tok);
            setNeedAuth(false);
            location.reload();
          }}
        >
          {t.auth.save}
        </button>
      </Modal>
    </ShellCtx.Provider>
  );
}
