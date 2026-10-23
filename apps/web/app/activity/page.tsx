"use client";

import { Fragment, useEffect, useState } from "react";
import type { AuditEntry } from "@liara-agent/shared";
import { api } from "@/lib/api";
import { faDateTime, faNum } from "@/lib/fa";
import { ErrorNote, Ltr, Risk } from "@/components/ui/primitives";

const KIND_FA: Record<string, string> = {
  "tool.read": "خواندن",
  "tool.mutation": "تغییر",
  "approval.requested": "درخواست تأیید",
  "approval.approve": "تأیید",
  "approval.reject": "رد",
  "policy.deny": "مسدود توسط سیاست",
  "patch.decision": "تصمیم پچ",
  "gate.override": "ادامه با مشکل",
  "patrol.settings": "تنظیم پایش",
  "demo.scenario": "سناریوی دمو",
};

export default function ActivityPage() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [kind, setKind] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api<AuditEntry[]>(`/api/audit?limit=300${kind ? `&kind=${kind}` : ""}`).then(setRows).catch(setErr);
  }, [kind]);
  return (
    <main className="mx-auto max-w-[1300px] px-4 py-8">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">فعالیت و ممیزی</h1>
        <span className="text-sm text-muted">ثبت فقط‌افزودنی همه‌ی تغییرها، تأییدها و تصمیم‌های سیاست · بدون مقدار رازها</span>
        <select className="field !h-9 !w-48 !text-sm mr-auto" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="نوع">
          <option value="">همه</option>
          {Object.entries(KIND_FA).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <ErrorNote error={err} />
      <div className="card overflow-x-auto p-2">
        <table className="tbl">
          <thead>
            <tr>
              <th>زمان</th>
              <th>نوع</th>
              <th>عامل</th>
              <th>قابلیت</th>
              <th>منبع</th>
              <th>ریسک</th>
              <th>نتیجه</th>
              <th>مدت</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <td className="whitespace-nowrap">{faDateTime(r.at)}</td>
                  <td>{KIND_FA[r.kind] ?? r.kind}</td>
                  <td>{{ user: "کاربر", agent: "ایجنت", patrol: "پایش", system: "سیستم" }[r.actor] ?? r.actor}</td>
                  <td>{r.capabilityId ? <Ltr className="text-xs">{r.capabilityId}</Ltr> : "—"}</td>
                  <td>{r.resource ? <Ltr className="text-xs">{r.resource}</Ltr> : "—"}</td>
                  <td>{r.risk ? <Risk level={r.risk} /> : "—"}</td>
                  <td className={r.status === "ok" || r.status === "approved" ? "st-PASS" : r.status === "error" || r.status === "denied" ? "st-FAIL" : ""}>
                    {r.status}
                    {r.errorCode ? ` (${r.errorCode})` : ""}
                  </td>
                  <td>{r.durationMs !== null ? `${faNum(r.durationMs)}ms` : "—"}</td>
                </tr>
                {open === r.id && (
                  <tr>
                    <td colSpan={8}>
                      <pre className="log mono ltr whitespace-pre-wrap">{JSON.stringify({ args: r.args, approvalId: r.approvalId, chatId: r.chatId, runId: r.runId, mode: r.mode }, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
