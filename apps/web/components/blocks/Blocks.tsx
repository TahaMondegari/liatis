"use client";

import { useMemo, useState } from "react";
import type { Block, DeltaRow, MetricSeries, VerificationCheck } from "@liara-agent/shared";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { API_URL } from "@/lib/api";
import { bytes, faNum, faTime } from "@/lib/fa";
import { Ltr, Risk, Sparkles, Status } from "../ui/primitives";
import { ApprovalCard } from "./ApprovalCard";
import { AskCardView } from "./AskCard";

export function BlockView({ block, chatId }: { block: Block; chatId: string }) {
  switch (block.type) {
    case "text":
      return <p className="text-sm leading-8 text-[#cfd6ee] whitespace-pre-wrap">{block.text}</p>;
    case "ask":
      return <AskCardView card={block.card} chatId={chatId} />;
    case "approval":
      return <ApprovalCard approval={block.approval} />;
    case "timeline":
      return <TimelineView b={block} />;
    case "gate":
      return <GateView b={block} />;
    case "root_cause":
      return <RootCauseView b={block} />;
    case "patch":
      return <PatchView b={block} />;
    case "limitation":
      return <LimitationView b={block} />;
    case "incident":
      return <IncidentBlock b={block} />;
    case "verification":
      return <VerificationView checks={block.checks} delta={block.delta} title={block.title} />;
    case "success":
      return <SuccessView b={block} />;
    case "report":
      return (
        <div className="card p-5">
          <h3 className="mb-3 font-bold">{block.title}</h3>
          {block.sections.map((s) => (
            <div key={s.heading} className="mb-3">
              <p className="mb-1 text-[13px] text-muted">{s.heading}</p>
              <ul className="list-inside list-disc text-sm leading-8">
                {s.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      );
    case "table":
      return <TableView b={block} />;
    case "metrics":
      return (
        <div className="card grid gap-4 p-5 md:grid-cols-2">
          <h3 className="font-bold md:col-span-2">{block.title}</h3>
          {block.series.map((s) => (
            <MetricChart key={s.key} s={s} />
          ))}
        </div>
      );
    case "code":
      return (
        <details className="card p-4">
          <summary className="cursor-pointer text-sm text-muted">{block.title}</summary>
          <pre className="log mono ltr mt-3 whitespace-pre-wrap">{block.code}</pre>
        </details>
      );
  }
}

const LV: Record<string, string> = { error: "lv-error", warn: "lv-warn", ok: "lv-ok", cmd: "lv-cmd", info: "" };

function TimelineView({ b }: { b: Extract<Block, { type: "timeline" }> }) {
  const [q, setQ] = useState("");
  const done = b.steps.filter((s) => ["PASS", "WARN", "FAIL", "SKIPPED", "NOT_APPLICABLE", "NOT_AVAILABLE"].includes(s.status)).length;
  const running = b.steps.some((s) => s.status === "RUNNING" || s.status === "PENDING");
  const failed = b.steps.some((s) => s.status === "FAIL");
  const logs = q ? b.logs.filter((l) => l.text.toLowerCase().includes(q.toLowerCase())) : b.logs;
  return (
    <div className={`beam ${running ? "" : failed ? "bad" : "done"}`}>
      <div className="beam-in">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-bold">{b.title}</h3>
          {b.risk && <Risk level={b.risk} />}
        </div>
        {b.subtitle && <p className="mb-4 text-xs text-muted">{b.subtitle}</p>}
        <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-[#1b2030]">
          <i className="block h-full rounded-full bg-primary shadow-[0_0_12px_#5b8cff] transition-all duration-1000" style={{ width: `${(done / Math.max(1, b.steps.length)) * 100}%`, marginInlineStart: 0 }} />
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <ol className="trace">
            <span className="trace-fill" style={{ height: `${(done / Math.max(1, b.steps.length)) * 92}%` }} />
            {b.steps.map((s) => (
              <li key={s.key} className="trace-step" data-s={s.status}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <b>{s.label}</b>
                  <Status s={s.status} />
                </div>
                {s.detail && <p className="mt-0.5 text-xs leading-6 text-muted">{s.detail}</p>}
                {s.command && s.command !== s.detail && (
                  <p className="mt-0.5 text-[11px] text-faint">
                    <Ltr>{s.command}</Ltr>
                  </p>
                )}
              </li>
            ))}
          </ol>
          {b.logs.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs text-muted">لاگ زنده</span>
                <div className="flex gap-2">
                  <input className="field !h-8 !w-36 !text-xs" placeholder="جستجو" value={q} onChange={(e) => setQ(e.target.value)} aria-label="جستجو در لاگ" />
                  <button className="btn-ghost btn-sm !h-8" onClick={() => navigator.clipboard?.writeText(b.logs.map((l) => l.text).join("\n"))}>
                    کپی
                  </button>
                </div>
              </div>
              <div className="log mono ltr max-h-64" role="log" aria-live="polite">
                {logs.map((l, i) => (
                  <div key={i} className={LV[l.level]}>
                    {l.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GateView({ b }: { b: Extract<Block, { type: "gate" }> }) {
  const r = b.report;
  return (
    <div className="card p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="font-bold">گزارش آزمایش قبل از دپلوی</h3>
        <span className="badge">فقط روی نسخه‌ی آزمایشی</span>
        <span className="mr-auto">
          <Status s={r.overall} />
        </span>
      </div>
      <p className="mb-3 text-xs text-muted">محیط اجرا: {r.sandbox}</p>
      <table className="tbl">
        <tbody>
          {r.stages.map((s) => (
            <tr key={s.key}>
              <td className="w-40 font-bold">{s.label}</td>
              <td className="w-32">
                <Status s={s.status} />
              </td>
              <td className="text-muted">
                {s.detail}
                {s.command && (
                  <div className="mt-0.5 text-[11px] text-faint">
                    <Ltr>{s.command}</Ltr>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(r.coverageNotes.length > 0 || r.preexistingFailures.length > 0) && (
        <div className="mt-3 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-[13px] leading-7 text-[#fde68a]">
          {r.coverageNotes.map((n) => (
            <div key={n}>{n}</div>
          ))}
          {r.preexistingFailures.length > 0 && <div>از قبل خراب بودن: {r.preexistingFailures.map((f) => `«${f}»`).join("، ")}</div>}
        </div>
      )}
    </div>
  );
}

function RootCauseView({ b }: { b: Extract<Block, { type: "root_cause" }> }) {
  const r = b.report;
  return (
    <div className="beam">
      <div className="beam-in">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="badge">سرچشمه‌ی مشکل</span>
          <span className="badge !border-line !bg-surface-2 !text-muted">{r.category}</span>
          <span className="text-xs text-muted">
            اطمینان {faNum(Math.round(r.confidence * 100))}٪{!r.confidenceCalibrated && " (کالیبره نشده)"}
          </span>
        </div>
        <h3 className="text-lg font-bold">{r.problem}</h3>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] leading-7">
          <span className="text-muted">علامت</span> <span>{r.symptom}</span>
          <span className="text-faint">←</span>
          <span className="text-muted">علت</span> <span>{r.cause}</span>
          {r.location && (
            <>
              <span className="text-faint">←</span>
              <span className="text-muted">منبع</span>
              <Ltr>
                {r.location.file}
                {r.location.line ? `:${r.location.line}` : ""}
              </Ltr>
            </>
          )}
        </div>
        {r.location?.snippet && (
          <pre className="log mono ltr mt-3">
            {r.location.snippet.split("\n").map((l, i) => (
              <span key={i} className={`block ${r.location?.line && l.startsWith(`${r.location.line} `) ? "lv-error" : ""}`}>
                {l}
              </span>
            ))}
          </pre>
        )}
        {r.evidence.length > 0 && (
          <div className="mt-3 text-[13px] leading-7">
            {r.evidence.map((e, i) => (
              <div key={i}>
                <span className="text-muted">شاهد ({e.source}):</span> <Ltr className="text-xs">{e.text}</Ltr>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-sm">
          <span className="text-muted">پیشنهاد:</span> {r.proposedFix}
        </p>
        {r.alternatives.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-xs text-muted">فرضیه‌های دیگه</p>
            {r.alternatives.map((h) => (
              <HypBar key={h.title} title={h.title} c={h.confidence} />
            ))}
          </div>
        )}
        {r.attempts.length > 0 && (
          <div className="mt-4">
            <p className="mb-1 text-xs text-muted">
              تلاش‌ها · {faNum(r.attempts.length)} از {faNum(r.maxAttempts)}
            </p>
            {r.attempts.map((a) => (
              <div key={a.n} className="row-dash text-[13px]">
                <span>
                  تلاش {faNum(a.n)} · {a.label}
                </span>
                <Status s={a.status === "succeeded" ? "PASS" : a.status === "failed" ? "FAIL" : a.status === "running" ? "RUNNING" : "PENDING"} />
              </div>
            ))}
          </div>
        )}
        {r.limitations.length > 0 && <p className="mt-3 text-xs leading-6 text-faint">محدودیت: {r.limitations.join(" · ")}</p>}
      </div>
    </div>
  );
}

function HypBar({ title, c }: { title: string; c: number }) {
  return (
    <div className="mb-2">
      <div className="mb-1 flex justify-between text-[13px]">
        <span>{title}</span>
        <span className="text-muted">{faNum(Math.round(c * 100))}٪ اطمینان</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[#1b2030]">
        <i className="block h-full bg-primary" style={{ width: `${Math.round(c * 100)}%` }} />
      </div>
    </div>
  );
}

export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="log mono ltr !p-0 !py-2">
      {diff.split("\n").map((l, i) => (
        <span key={i} className={`diff-line ${l.startsWith("+") && !l.startsWith("+++") ? "diff-add" : l.startsWith("-") && !l.startsWith("---") ? "diff-del" : l.startsWith("@@") ? "diff-hunk" : ""}`}>
          {l || " "}
        </span>
      ))}
    </pre>
  );
}

function PatchView({ b }: { b: Extract<Block, { type: "patch" }> }) {
  return (
    <div className="card p-5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="font-bold">تغییر پیشنهادی</h3>
        <Risk level="L2" />
        <Status s={b.status === "applied" ? "PASS" : b.status === "rejected" ? "FAIL" : "pending"}>{{ proposed: "پیشنهاد", applied: "اعمال‌شده روی نسخه‌ی دیپلوی", rejected: "رد شد", exported: "خروجی گرفته شد" }[b.status]}</Status>
        <a className="btn-ghost btn-sm mr-auto inline-flex items-center" href={`${API_URL}/api/patches/${b.patchId}/download`} download>
          دانلود فایل پچ
        </a>
      </div>
      <p className="mb-3 text-[13px] text-muted">{b.summary}</p>
      {b.files.map((f) => (
        <div key={f.path} className="mb-3">
          <p className="mb-1 text-xs">
            <Ltr>{f.path}</Ltr>
          </p>
          <DiffView diff={f.diff} />
        </div>
      ))}
      {b.testsPassed && <p className="text-sm text-success">تست‌هایی که الان قبول شدن: {b.testsPassed}</p>}
      <p className="mt-2 text-xs text-faint">مطمئن باش: مخزن اصلیت دست نمی‌خوره. تست‌ها هیچ‌وقت برای قبول شدن تغییر داده یا حذف نمی‌شن.</p>
    </div>
  );
}

function LimitationView({ b }: { b: Extract<Block, { type: "limitation" }> }) {
  return (
    <div className="card border-warning/30 p-5">
      <span className="badge !border-warning/50 !bg-warning/15 !text-[#fcd34d]">محدودیت · ایجنت نمی‌تونه انجامش بده</span>
      <h3 className="mt-3 font-bold">{b.title}</h3>
      <p className="mt-1 text-sm leading-7 text-muted">{b.reason}</p>
      {b.steps.length > 0 && (
        <ol className="mt-3 flex flex-col gap-2">
          {b.steps.map((s, i) => (
            <li key={s} className="flex items-start gap-3 text-sm">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-raised text-xs">{faNum(i + 1)}</span>
              {s}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {b.link && (
          <a className="btn-ghost btn-sm inline-flex items-center" href={b.link.href} target="_blank" rel="noreferrer noopener">
            {b.link.label}
          </a>
        )}
        {b.capabilityId && (
          <span className="text-[11px] text-faint">
            قابلیت: <Ltr>{b.capabilityId}</Ltr>
          </span>
        )}
      </div>
    </div>
  );
}

function IncidentBlock({ b }: { b: Extract<Block, { type: "incident" }> }) {
  return (
    <div className="card p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="badge">شواهد · فقط خوندن</span>
        <Status s={b.severity}>شدت {({ LOW: "پایین", MEDIUM: "متوسط", HIGH: "بالا", CRITICAL: "بحرانی" } as const)[b.severity]}</Status>
        <span className="text-xs text-muted">{b.state}</span>
      </div>
      <h3 className="mb-3 text-lg font-bold">{b.title}</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {b.metrics.map((m) => (
          <div key={m.label} className={`panel p-3 ${m.tone === "bad" ? "border-danger/50 bg-danger/[0.07]" : m.tone === "warn" ? "border-warning/40" : ""}`}>
            <p className="text-xs text-muted">{m.label}</p>
            <p className={`mt-1 text-xl font-bold ${m.tone === "bad" ? "text-[#fda4af]" : m.tone === "warn" ? "text-[#fcd34d]" : ""}`}>{m.value}</p>
          </div>
        ))}
      </div>
      {b.hypotheses.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-muted">علت‌های احتمالی</p>
          {[...b.hypotheses]
            .sort((x, y) => y.confidence - x.confidence)
            .map((h) => (
              <div key={h.title}>
                <HypBar title={h.title} c={h.confidence} />
                {h.evidence[0] && <p className="-mt-1 mb-2 text-xs text-faint">{h.evidence[0]}</p>}
              </div>
            ))}
        </div>
      )}
      {b.signature && (
        <pre className="log mono ltr mt-3 whitespace-pre-wrap">
          <span className="lv-error">{b.signature}</span>
        </pre>
      )}
    </div>
  );
}

export function VerificationView({ checks, delta, title }: { checks: VerificationCheck[]; delta: DeltaRow[]; title: string }) {
  return (
    <div className="card p-5">
      <h3 className="mb-3 font-bold">{title}</h3>
      {delta.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          {delta.map((d) => (
            <div key={d.label} className={`panel p-3 ${d.improved ? "border-success/40" : d.improved === false ? "border-danger/40" : ""}`}>
              <p className="text-xs text-muted">{d.label}</p>
              <p className="mt-1 text-sm">
                <span className="text-faint">{d.before ?? "—"}</span> ← <b className={d.improved ? "text-success" : d.improved === false ? "text-danger" : ""}>{d.after ?? "—"}</b>
              </p>
            </div>
          ))}
        </div>
      )}
      <table className="tbl">
        <thead>
          <tr>
            <th>مورد</th>
            <th>مقدار</th>
            <th>معمولاً</th>
            <th>حد</th>
            <th>نتیجه</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.key}>
              <td>{c.label}</td>
              <td>{c.value ?? "—"}</td>
              <td className="text-muted">{c.baseline ?? "—"}</td>
              <td className="text-muted">{c.threshold ?? "—"}</td>
              <td title={c.evidence ?? undefined}>
                <Status s={c.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SuccessView({ b }: { b: Extract<Block, { type: "success" }> }) {
  return (
    <div className="beam done">
      <div className="beam-in relative overflow-hidden">
        <Sparkles />
        <span className="badge !border-success/50 !bg-success/15 !text-[#6ee7b7]">✓ دپلوی موفق و بررسی‌شده</span>
        <h3 className="mt-3 text-2xl font-bold">{b.title}</h3>
        {b.url && (
          <a href={b.url} target="_blank" rel="noreferrer noopener" className="mt-2 inline-block text-lg text-primary-soft underline-offset-4 hover:underline">
            <Ltr>{b.url}</Ltr>
          </a>
        )}
        <div className="mt-4 grid gap-x-6 sm:grid-cols-2">
          {b.facts.map((f) => (
            <div key={f.label} className="row-dash">
              <span>{f.label}</span>
              <b>{f.value}</b>
            </div>
          ))}
        </div>
        {b.next.length > 0 && (
          <ul className="mt-4 list-inside list-disc text-sm leading-8 text-[#cfd6ee]">
            {b.next.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TableView({ b }: { b: Extract<Block, { type: "table" }> }) {
  const ltr = new Set(b.ltrColumns ?? []);
  return (
    <div className="card overflow-x-auto p-5">
      <h3 className="mb-3 font-bold">{b.title}</h3>
      <table className="tbl">
        <thead>
          <tr>
            {b.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {b.rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{ltr.has(j) ? <Ltr className="text-xs">{cell}</Ltr> : cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MetricChart({ s, height = 160, ramBytes }: { s: MetricSeries; height?: number; ramBytes?: number | null }) {
  const data = useMemo(() => s.points.map((p) => ({ t: p.t, v: s.key === "memory" && ramBytes ? Math.round((p.v / ramBytes) * 1000) / 10 : p.v })), [s, ramBytes]);
  const fmt = (v: number) => (s.key === "memory" ? (ramBytes ? `${faNum(v)}٪` : bytes(v)) : s.key.startsWith("network") ? `${bytes(v)}/s` : faNum(Math.round(v * 100) / 100));
  return (
    <div className="panel p-3">
      <div className="mb-2 flex justify-between text-xs">
        <b>{s.label}</b>
        <span className="text-muted">{data.length ? fmt(data.at(-1)!.v) : "داده‌ای نیست"}</span>
      </div>
      <div style={{ height, direction: "ltr" }}>
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5b8cff" stopOpacity={0.45} />
                <stop offset="100%" stopColor="#5b8cff" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#1f2333" vertical={false} />
            <XAxis dataKey="t" tickFormatter={(t: number) => faTime(new Date(t).toISOString())} stroke="#8a91a8" fontSize={10} minTickGap={40} />
            <YAxis stroke="#8a91a8" fontSize={10} width={46} tickFormatter={(v: number) => fmt(v)} />
            <Tooltip contentStyle={{ background: "#0e1018", border: "1px solid #2a3047", borderRadius: 10, fontSize: 12 }} labelFormatter={(t) => faTime(new Date(Number(t)).toISOString())} formatter={(v) => [fmt(Number(v)), s.label]} />
            <Area type="monotone" dataKey="v" stroke="#5b8cff" strokeWidth={2} fill={`url(#g-${s.key})`} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[10px] text-faint">
        منبع: <Ltr>{s.source}</Ltr>
      </p>
    </div>
  );
}
