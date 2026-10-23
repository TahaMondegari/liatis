"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApprovalView } from "@liara-agent/shared";
import { api } from "@/lib/api";
import { faAgo, faNum } from "@/lib/fa";
import { ApprovalCard } from "@/components/blocks/ApprovalCard";
import { Empty, ErrorNote, Ltr, Risk, Status } from "@/components/ui/primitives";
import { useShell } from "@/components/shell";

const TABS = [
  ["pending", "منتظر من"],
  ["approved", "تأییدشده"],
  ["rejected", "ردشده"],
  ["expired", "منقضی‌شده"],
  ["executed", "اجراشده"],
  ["all", "همه"],
] as const;

export default function ApprovalsPage() {
  const { subscribe, refresh } = useShell();
  const [all, setAll] = useState<ApprovalView[]>([]);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("pending");
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => api<ApprovalView[]>("/api/approvals?status=all").then(setAll).catch(setErr), []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => subscribe((e) => (e.type.startsWith("approval.") ? void load() : undefined)), [subscribe, load]);
  const shown = useMemo(() => all.filter((a) => tab === "all" || a.status === tab || (tab === "executed" && a.status === "failed")), [all, tab]);
  const current = shown.find((a) => a.id === sel) ?? shown[0] ?? null;
  const count = (s: string) => all.filter((a) => a.status === s).length;

  return (
    <main className="mx-auto max-w-[1300px] px-4 py-8">
      <h1 className="mb-5 text-2xl font-bold">صندوق تأییدها</h1>
      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} aria-pressed={tab === k} className="chip" onClick={() => setTab(k)}>
            {l}
            {k !== "all" && count(k) > 0 && <span className="badge">{faNum(count(k))}</span>}
          </button>
        ))}
      </div>
      <ErrorNote error={err} />
      {shown.length === 0 ? (
        <Empty title="چیزی اینجا نیست" sub="وقتی ایجنت برای کاری که روی سرویس اثر می‌ذاره یا هزینه داره اجازه بخواد، اینجا نمایش داده می‌شه." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]">
          <div className="flex flex-col gap-2">
            {shown.map((a) => (
              <button key={a.id} onClick={() => setSel(a.id)} className={`panel p-3.5 text-start transition-colors ${current?.id === a.id ? "border-primary bg-primary/10" : "hover:border-primary/60"}`}>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Risk level={a.risk} />
                  <span className="mr-auto text-[11px] text-faint">{faAgo(a.createdAt)}</span>
                </div>
                <b className="block text-sm">{a.title}</b>
                <span className="text-xs text-muted">
                  {a.projectName ? <Ltr>{a.projectName}</Ltr> : a.resource} · <Status s={a.status} />
                </span>
              </button>
            ))}
          </div>
          {current && (
            <div className="flex flex-col gap-3">
              <ApprovalCard
                key={current.id}
                approval={current}
                onDecided={() => {
                  void load();
                  refresh();
                }}
              />
              <div className="card p-4 text-sm">
                <p className="mb-2 text-xs text-muted">وضعیت اجرا</p>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {["pending", "approved", "executing", "executed"].map((s, i) => (
                    <span key={s} className="flex items-center gap-2">
                      {i > 0 && <span className="text-faint">←</span>}
                      <span className={current.status === s || (s === "executed" && current.status === "failed") ? "badge" : "text-faint"}>{{ pending: "منتظر تأیید", approved: "تأییدشده", executing: "در حال اجرا", executed: current.status === "failed" ? "ناموفق" : "موفق / ناموفق" }[s]}</span>
                    </span>
                  ))}
                </div>
                {current.chatId && (
                  <Link className="mt-3 inline-block text-primary-soft" href={`/chat/${current.chatId}`}>
                    رفتن به گفتگو ←
                  </Link>
                )}
                {current.incidentId && (
                  <Link className="mt-3 mr-4 inline-block text-primary-soft" href={`/incidents?id=${current.incidentId}`}>
                    رفتن به رخداد ←
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
