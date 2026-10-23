"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ApprovalView, IncidentView } from "@liara-agent/shared";
import { api, post } from "@/lib/api";
import { faAgo, faDateTime, faElapsed, faNum } from "@/lib/fa";
import { ApprovalCard } from "@/components/blocks/ApprovalCard";
import { Empty, ErrorNote, Ltr, Status } from "@/components/ui/primitives";
import { useShell } from "@/components/shell";

const SEV_FA = { LOW: "پایین", MEDIUM: "متوسط", HIGH: "بالا", CRITICAL: "بحرانی" } as const;
const STATE_FA: Record<string, string> = { DETECTED: "جدید", INVESTIGATING: "در حال بررسی", DIAGNOSED: "علت پیدا شد", WAITING_FOR_APPROVAL: "منتظر تأیید", REPAIRING: "در حال اصلاح", VERIFYING: "بررسی مجدد", RESOLVED: "حل‌شده", FAILED: "ناموفق", ESCALATED: "ارجاع‌شده" };

function Incidents() {
  const sp = useSearchParams();
  const { subscribe } = useShell();
  const [list, setList] = useState<IncidentView[]>([]);
  const [selId, setSelId] = useState<string | null>(sp.get("id"));
  const [detail, setDetail] = useState<{ incident: IncidentView; approval: ApprovalView | null } | null>(null);
  const [sev, setSev] = useState("all");
  const [openOnly, setOpenOnly] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => api<IncidentView[]>("/api/incidents").then(setList).catch(setErr), []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => subscribe((e) => (e.type === "incident.updated" || e.type === "approval.received" ? void load() : undefined)), [subscribe, load]);
  useEffect(() => {
    const id = selId ?? list[0]?.id;
    if (!id) return;
    api<{ incident: IncidentView; approval: ApprovalView | null }>(`/api/incidents/${id}`).then(setDetail).catch(setErr);
  }, [selId, list]);
  const shown = useMemo(() => list.filter((i) => (sev === "all" || i.severity === sev) && (!openOnly || !["RESOLVED", "FAILED"].includes(i.state))), [list, sev, openOnly]);
  const open = list.filter((i) => !["RESOLVED", "FAILED"].includes(i.state)).length;
  const inc = detail?.incident;

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">رخدادها</h1>
        <span className="text-sm text-muted">
          {faNum(list.length)} رخداد · {faNum(open)} مورد باز
        </span>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className="field !h-9 !w-40 !text-sm" value={sev} onChange={(e) => setSev(e.target.value)} aria-label="شدت">
          <option value="all">همه‌ی شدت‌ها</option>
          {Object.entries(SEV_FA).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button className="chip" aria-pressed={openOnly} onClick={() => setOpenOnly(!openOnly)}>
          فقط رخدادهای باز
        </button>
      </div>
      <ErrorNote error={err} />
      {list.length === 0 ? (
        <Empty title="رخدادی ثبت نشده" sub="پایش هر چند ساعت سلامت پروژه‌ها رو چک می‌کنه و فقط وقتی مشکلی پیدا بشه رخداد می‌سازه." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="card overflow-x-auto p-2">
            <table className="tbl">
              <thead>
                <tr>
                  <th>شناسه</th>
                  <th>عنوان</th>
                  <th>شدت</th>
                  <th>سرویس</th>
                  <th>شروع</th>
                  <th>مدت</th>
                  <th>وضعیت</th>
                  <th>علت احتمالی</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id} className={`cursor-pointer ${inc?.id === i.id ? "sel" : ""}`} onClick={() => setSelId(i.id)}>
                    <td>{i.code}</td>
                    <td>
                      {i.title} {i.occurrences > 1 && <span className="badge">×{faNum(i.occurrences)} تکرار</span>}
                    </td>
                    <td>
                      <Status s={i.severity}>{SEV_FA[i.severity]}</Status>
                    </td>
                    <td>
                      <Ltr className="text-xs">{i.projectName}</Ltr>
                    </td>
                    <td>{faAgo(i.startedAt)}</td>
                    <td>{faElapsed((i.resolvedAt ? Date.parse(i.resolvedAt) : Date.now()) - Date.parse(i.startedAt))}</td>
                    <td>
                      <Status s={i.state}>{STATE_FA[i.state]}</Status>
                    </td>
                    <td className="text-muted">{i.probableCause ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {inc && (
            <div className="flex flex-col gap-4">
              <div className="card p-5">
                <h2 className="text-lg font-bold">
                  {inc.code} · {inc.title}
                </h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="btn-ghost btn-sm" disabled={inc.acknowledged} onClick={() => post(`/api/incidents/${inc.id}/ack`).then(load)}>
                    {inc.acknowledged ? "✓ دیده شد" : "Acknowledge"}
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => post(`/api/incidents/${inc.id}/recheck`).then(load)}>
                    بررسی مجدد
                  </button>
                </div>
                <ol className="trace mt-5">
                  {inc.timeline.map((t, i) => (
                    <li key={i} className="trace-step" data-s={t.kind === "resolved" ? "PASS" : t.kind === "escalated" || t.kind === "failed" ? "FAIL" : i === inc.timeline.length - 1 ? "RUNNING" : "PASS"}>
                      <div className="flex justify-between text-sm">
                        <span>{t.label}</span>
                        <span className="text-xs text-faint">{faDateTime(t.at)}</span>
                      </div>
                    </li>
                  ))}
                </ol>
                {[
                  ["اثر روی کاربر", inc.impact ?? "نامشخص"],
                  ["علت احتمالی", inc.probableCause ? `${inc.probableCause}${inc.confidence !== null ? ` (${faNum(Math.round(inc.confidence * 100))}٪)` : ""}` : "—"],
                  ["تکرار", faNum(inc.occurrences)],
                  ["اثرانگشت", inc.fingerprint.slice(0, 12)],
                ].map(([k, v]) => (
                  <div key={k} className="row-dash">
                    <span>{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
                {inc.hypotheses.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-xs text-muted">فرضیه‌ها</p>
                    {inc.hypotheses.map((h) => (
                      <div key={h.title} className="row-dash text-[13px]">
                        <span>{h.title}</span>
                        <span>{faNum(Math.round(h.confidence * 100))}٪</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-4">
                  {inc.notes.map((n, i) => (
                    <p key={i} className="mb-1 text-xs text-muted">
                      {faDateTime(n.at)}: {n.text}
                    </p>
                  ))}
                  <div className="mt-2 flex gap-2">
                    <input className="field !h-9 !text-sm" placeholder="افزودن یادداشت" value={note} onChange={(e) => setNote(e.target.value)} />
                    <button className="btn-ghost btn-sm" disabled={!note} onClick={() => post(`/api/incidents/${inc.id}/notes`, { text: note }).then(() => { setNote(""); void load(); })}>
                      ثبت
                    </button>
                  </div>
                </div>
              </div>
              {detail?.approval && <ApprovalCard approval={detail.approval} onDecided={() => void load()} />}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

export default function IncidentsPage() {
  return (
    <Suspense>
      <Incidents />
    </Suspense>
  );
}
