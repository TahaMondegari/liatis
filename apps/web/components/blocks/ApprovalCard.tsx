"use client";

import { useEffect, useState } from "react";
import type { ApprovalView } from "@liara-agent/shared";
import { post } from "@/lib/api";
import { faAgo, faElapsed, money } from "@/lib/fa";
import t from "@/messages/fa.json";
import { ErrorNote, Ltr, Modal, Risk, Status } from "../ui/primitives";
import { DiffView } from "./Blocks";

export function ApprovalCard({ approval: a0, compact = false, onDecided }: { approval: ApprovalView; compact?: boolean; onDecided?: (a: ApprovalView) => void }) {
  const [a, setA] = useState(a0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [typedOpen, setTypedOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setA(a0), [a0]);
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  const left = Date.parse(a.expiresAt) - now;
  const pending = a.status === "pending" && left > 0;
  const decide = async (decision: "approve" | "reject", typedConfirmation?: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<ApprovalView>(`/api/approvals/${a.id}/decide`, { decision, typedConfirmation: typedConfirmation ?? null });
      setA(r);
      onDecided?.(r);
      setTypedOpen(false);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const cost = a.cost ? money(a.cost) : null;
  const tone = a.risk === "L4" ? "bad" : a.risk === "L3" ? "warn" : "";
  return (
    <div className={`beam ${pending ? tone : "done"}`}>
      <div className="beam-in">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Risk level={a.risk} hint />
          {a.cost && a.risk !== "L3" && <span className="risk risk-L3">هزینه داره</span>}
          <span className="mr-auto">
            <Status s={pending ? "pending" : a.status === "pending" ? "expired" : a.status} />
          </span>
        </div>
        <h3 className="text-lg font-bold">{a.title}</h3>
        <p className="mt-1 text-sm leading-7 text-muted">{a.effect}</p>
        {!compact && a.reason && <p className="mt-2 text-[13px] text-[#cfd6ee]">دلیل ایجنت: {a.reason}</p>}
        {!compact && a.evidence.length > 0 && (
          <ul className="mt-2 list-inside list-disc text-[13px] leading-7 text-muted">
            {a.evidence.slice(0, 4).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div className="mt-4 grid gap-x-6 sm:grid-cols-2">
          {a.currentValue && (
            <div className="row-dash">
              <span>الان</span>
              <Ltr>{a.currentValue}</Ltr>
            </div>
          )}
          {a.proposedValue && (
            <div className="row-dash">
              <span>بعد از تأیید</span>
              <Ltr>{a.proposedValue}</Ltr>
            </div>
          )}
          {cost && (
            <div className="row-dash">
              <span>تغییر هزینه</span>
              <b title={cost.note ?? undefined}>{a.cost?.hourlyToman !== null && a.cost?.hourlyToman !== undefined && a.cost.hourlyToman > 0 ? "+" : ""}{cost.text}</b>
            </div>
          )}
          {a.downtime && (
            <div className="row-dash">
              <span>اثر روی سرویس</span>
              <span>{a.downtime}</span>
            </div>
          )}
          {a.reversible && (
            <div className="row-dash">
              <span>برگشت‌پذیری</span>
              <span>{a.reversible}</span>
            </div>
          )}
          <div className="row-dash">
            <span>محدوده‌ی دسترسی</span>
            <span>{a.scope}</span>
          </div>
          <div className="row-dash">
            <span>{t.approval.expires}</span>
            <span>{pending ? `${faElapsed(left)} دیگه` : faAgo(a.expiresAt)}</span>
          </div>
        </div>
        {a.diff && !compact && (
          <div className="mt-3">
            <DiffView diff={a.diff} />
          </div>
        )}
        {cost?.note && <p className="mt-2 text-xs text-faint">{cost.note}</p>}
        {a.resultSummary && <p className="mt-2 text-xs text-faint">نتیجه‌ی اجرا: {a.resultSummary}</p>}
        <p className="mt-3 text-[11px] leading-6 text-faint">{t.approval.meaning}</p>
        <ErrorNote error={err} />
        {pending && (
          <div className="mt-4 flex flex-wrap justify-end gap-3">
            <button className="btn-ghost" disabled={busy} onClick={() => decide("reject")}>
              {t.approval.reject}
            </button>
            <button className={`btn-primary ${a.risk === "L4" ? "danger" : ""}`} disabled={busy} onClick={() => (a.requiresTypedConfirmation ? setTypedOpen(true) : decide("approve"))}>
              {a.risk === "L4" ? t.approval.forever : t.approval.approve}
            </button>
          </div>
        )}
      </div>
      <Modal open={typedOpen} onClose={() => setTypedOpen(false)} title={a.title}>
        <span className="risk risk-L4 mb-3">غیرقابل‌برگشت</span>
        <p className="mb-4 text-sm leading-7 text-muted">{a.effect}</p>
        <label className="label" htmlFor={`typed-${a.id}`}>
          {t.approval.typed.replace("{name}", a.requiresTypedConfirmation ?? "")}
        </label>
        <input id={`typed-${a.id}`} className="field mono ltr" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        <ErrorNote error={err} />
        <div className="mt-5 flex justify-between gap-3">
          <button className="btn-ghost" onClick={() => setTypedOpen(false)}>
            {t.approval.cancel}
          </button>
          <button className="btn-primary danger" disabled={busy || typed !== a.requiresTypedConfirmation} onClick={() => decide("approve", typed)}>
            {t.approval.forever}
          </button>
        </div>
      </Modal>
    </div>
  );
}
