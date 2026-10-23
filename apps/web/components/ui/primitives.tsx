"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { RISK_HINT_FA, RISK_LABEL_FA, type RiskLevel } from "@liara-agent/shared";

export function Risk({ level, hint = false }: { level: RiskLevel; hint?: boolean }) {
  return (
    <span className={`risk risk-${level}`} title={RISK_HINT_FA[level]}>
      <span aria-hidden className="mono text-[10px] opacity-70">
        {level}
      </span>
      {RISK_LABEL_FA[level]}
      {hint && <span className="opacity-70">· {RISK_HINT_FA[level]}</span>}
    </span>
  );
}

const STATUS_FA: Record<string, string> = {
  PASS: "موفق",
  WARN: "هشدار",
  FAIL: "رد",
  NOT_AVAILABLE: "در دسترس نیست",
  NOT_APPLICABLE: "لازم نیست",
  RUNNING: "در حال اجرا",
  PENDING: "در انتظار",
  SKIPPED: "اجرا نشد",
  pending: "منتظر تأیید",
  approved: "تأییدشده",
  rejected: "ردشده",
  expired: "منقضی‌شده",
  executing: "در حال اجرا",
  executed: "اجراشده",
  failed: "ناموفق",
  invalidated: "باطل‌شده",
  healthy: "سالم",
  warning: "هشدار",
  failing: "ناموفق",
  unhealthy: "ناسالم",
  unknown: "نامشخص",
  stopped: "خاموش",
  error: "خطا",
  running: "در حال اجرا",
};

export function Status({ s, children }: { s: string; children?: ReactNode }) {
  const icon = /PASS|healthy|executed|approved|RESOLVED/.test(s) ? "✓" : /FAIL|failing|unhealthy|rejected|failed|error/.test(s) ? "✕" : /WARN|warning|pending/.test(s) ? "!" : /RUNNING|executing|running/.test(s) ? "◐" : "○";
  return (
    <span className={`st-${s} inline-flex items-center gap-1 text-[13px] whitespace-nowrap`}>
      <span aria-hidden>{icon}</span>
      {children ?? STATUS_FA[s] ?? s}
    </span>
  );
}

export function Dots() {
  return (
    <span aria-hidden className="inline-flex gap-1">
      {[0, 1, 2].map((i) => (
        <span key={i} className="inline-block h-1.5 w-1.5 rounded-full bg-primary" style={{ animation: `dots 1.4s ${i * 0.18}s infinite` }} />
      ))}
    </span>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose} className="card m-auto max-w-[92vw] p-0 text-ink backdrop:bg-black/70" style={{ width: wide ? "min(92vw, 820px)" : "min(92vw, 520px)" }} aria-label={title}>
      {open && (
        <div className="p-6" dir="rtl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold">{title}</h2>
            <button className="btn-ghost btn-sm" onClick={onClose} aria-label="بستن">
              ×
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** Sparkles (Aceternity-style) — only on successful deployment. */
export function Sparkles() {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {Array.from({ length: 18 }).map((_, i) => (
        <span key={i} className="spark" style={{ top: `${(i * 37) % 100}%`, left: `${(i * 53) % 100}%`, animationDelay: `${(i % 6) * 0.35}s`, ["--dx" as string]: `${((i % 5) - 2) * 14}px`, ["--dy" as string]: `${-10 - (i % 4) * 8}px` }} />
      ))}
    </span>
  );
}

export function Empty({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="relative h-14 w-14" style={{ perspective: 700 }}>
        <div className="absolute inset-0 rounded-xl border border-primary-soft/60 bg-primary/15" style={{ transform: "rotateX(-24deg) rotateY(35deg)" }} />
      </div>
      <h3 className="font-bold">{title}</h3>
      {sub && <p className="max-w-md text-sm leading-7 text-muted">{sub}</p>}
      {children}
    </div>
  );
}

export function Section({ title, actions, children, className = "" }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-5 ${className}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Ltr({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <bdi className={`mono ltr ${className}`}>{children}</bdi>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as { message?: string; detail?: string | null };
  return (
    <div role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-[#fecdd3]">
      {e.message ?? "خطا"}
      {e.detail && <div className="mono ltr mt-1 text-xs opacity-80">{e.detail}</div>}
    </div>
  );
}
