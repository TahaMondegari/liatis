"use client";

import { useMemo, useRef, useState } from "react";
import type { AskCard as Card, PlanOption } from "@liara-agent/shared";
import { post, upload } from "@/lib/api";
import { faNum, money } from "@/lib/fa";
import t from "@/messages/fa.json";
import { ErrorNote, Ltr, Modal } from "../ui/primitives";

export function AskCardView({ card, chatId }: { card: Card; chatId: string }) {
  const [value, setValue] = useState<unknown>(card.defaultValue ?? card.recommendation?.value ?? card.options?.[0]?.value ?? null);
  const [text, setText] = useState(typeof card.defaultValue === "string" && card.kind === "text" ? card.defaultValue : "");
  const [env, setEnv] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const done = card.state !== "pending";

  const submit = async (v: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      if (card.kind === "invoice") await post(`/api/chats/${chatId}/invoice`, { cardId: card.id });
      else await post(`/api/chats/${chatId}/answer`, { cardId: card.id, value: v });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const confirmValue = (): unknown => {
    switch (card.kind) {
      case "text":
        return text || card.defaultValue;
      case "env":
        return env;
      case "source":
        return value === "git" ? { kind: "git", url: text } : value === "zip" ? { kind: "zip", uploadId: text } : { kind: value };
      case "choice":
        return card.text ? { choice: value, name: text || undefined } : value;
      default:
        return value;
    }
  };

  const canConfirm = useMemo(() => {
    if (card.kind === "text") return new RegExp(card.text?.pattern ?? ".*").test(text || String(card.defaultValue ?? ""));
    if (card.kind === "source") return value === "sample" || ((value === "git" || value === "zip") && text.length > 0);
    // Choosing an existing private network needs its name (networks cannot be created via the API).
    if (card.kind === "choice" && card.text && value === "yes") return /^[a-z0-9][a-z0-9-]{1,62}$/.test(text);
    // Missing env values are allowed: the server reports them and asks again after a failed build.
    if (card.kind === "env") return true;
    return value !== null;
  }, [card, text, value, env]);

  return (
    <div className={`beam ${done ? "done" : ""}`}>
      <div className="beam-in fade-up">
        <div className="mb-4 flex items-center justify-between gap-2">
          <span className="badge">{card.badge ?? "ایجنت می‌پرسه"}</span>
          {done ? <span className="text-xs text-success">✓ {card.state === "deferred" ? t.ask.deferred : t.ask.answered}</span> : <span className="text-xs text-muted">هر زمان لازم باشه نمایش داده می‌شه</span>}
        </div>
        <div>
          <h2 className="mb-1.5 text-xl font-bold">{card.question}</h2>
          {card.description && <p className="mb-5 text-sm leading-7 text-muted">{card.description}</p>}

          {card.recommendation && card.kind !== "plan" && (
            <div className="mb-4 flex gap-2.5 rounded-xl border border-primary/30 bg-primary/10 px-3.5 py-2.5 text-[13px] leading-7 text-[#cfd6ee]">
              <span className="badge shrink-0">پیشنهاد ایجنت</span>
              <span>{card.recommendation.reason}</span>
            </div>
          )}

          {(card.kind === "choice" || card.kind === "source" || card.kind === "confirm") && card.options && (
            <div className={`grid gap-3 ${card.options.length >= 3 && card.kind !== "confirm" ? "sm:grid-cols-3" : card.kind === "confirm" ? "" : "sm:grid-cols-2"}`} role="radiogroup" aria-label={card.question}>
              {card.options.map((o) =>
                card.kind === "confirm" ? (
                  <button key={o.value} disabled={done || busy} onClick={() => submit(o.value)} className={o.recommended ? "btn-primary" : "btn-ghost"}>
                    {o.label}
                  </button>
                ) : (
                  <button key={o.value} role="radio" aria-checked={value === o.value} aria-pressed={value === o.value} disabled={done || o.disabled} onClick={() => setValue(o.value)} className="opt">
                    {o.icon && <div className="opt-ic mb-2">{o.icon}</div>}
                    <b className="mb-1 block text-[15px]">
                      {o.label} {o.recommended && <span className="badge mr-1 align-middle">پیشنهاد</span>}
                    </b>
                    {o.description && <p className="text-[13px] leading-6 text-muted">{o.description}</p>}
                    {o.meta && <p className="mt-1 text-xs text-faint">{o.meta}</p>}
                  </button>
                ),
              )}
            </div>
          )}

          {card.kind === "source" && !done && (value === "git" || value === "zip") && <SourceInput kind={value as "git" | "zip"} text={text} setText={setText} placeholder={card.text?.placeholder ?? ""} />}

          {card.kind === "choice" && card.text && value === "yes" && !done && (
            <div className="mt-4">
              <label className="label" htmlFor={`${card.id}-t`}>
                نام شبکه
              </label>
              <input id={`${card.id}-t`} className="field mono ltr" placeholder={card.text.placeholder} value={text} onChange={(e) => setText(e.target.value)} />
              {card.text.hint && <p className="mt-2 text-xs text-faint">{card.text.hint}</p>}
            </div>
          )}

          {card.kind === "select" && (
            <div>
              <label className="label" htmlFor={`${card.id}-s`}>
                {card.question}
              </label>
              <select id={`${card.id}-s`} className="field" disabled={done} value={String(value)} onChange={(e) => setValue(e.target.value)}>
                {card.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {card.kind === "slider" && card.slider && <Slider card={card} value={Number(value ?? card.slider.min)} onChange={setValue} disabled={done} />}

          {card.kind === "text" && card.text && (
            <div>
              <div className="field flex items-center gap-1 !px-3" dir="ltr">
                {card.text.prefix && <span className="mono text-faint">{card.text.prefix}</span>}
                <input aria-label={card.question} className="mono min-w-0 flex-1 bg-transparent outline-none" disabled={done} value={text} placeholder={card.text.placeholder} onChange={(e) => setText(e.target.value.toLowerCase())} />
                {card.text.suffix && <span className="mono text-faint">{card.text.suffix}</span>}
              </div>
              <p className={`mt-2 text-xs ${canConfirm ? "text-success" : "text-danger"}`}>{canConfirm ? `✓ ${card.text.hint ?? ""}` : card.text.hint}</p>
            </div>
          )}

          {card.kind === "env" && (
            <div className="flex flex-col gap-3">
              {(card.envKeys ?? []).map((k) => (
                <div key={k.key}>
                  <label className="label flex items-center gap-2" htmlFor={`${card.id}-${k.key}`}>
                    <Ltr>{k.key}</Ltr>
                    {k.required ? <span className="text-[11px] text-danger">ضروری</span> : <span className="text-[11px] text-faint">اختیاری</span>}
                    {k.hint && <span className="text-[11px] font-normal text-faint">{k.hint}</span>}
                  </label>
                  <input id={`${card.id}-${k.key}`} type="password" autoComplete="off" className="field mono ltr" disabled={done} value={env[k.key] ?? ""} onChange={(e) => setEnv({ ...env, [k.key]: e.target.value })} />
                </div>
              ))}
            </div>
          )}

          {card.kind === "plan" && card.plans && <Plans plans={card.plans} value={String(value)} onChange={setValue} disabled={done} />}

          {card.kind === "invoice" && card.invoice && <InvoiceBody inv={card.invoice} />}

          {card.tip && (
            <div className="mt-4 flex gap-2.5 rounded-xl border border-primary/25 bg-primary/[0.08] px-3.5 py-3 text-[13px] leading-7 text-[#cfd6ee]">
              <span aria-hidden className="text-primary-soft">i</span>
              {card.tip}
            </div>
          )}
          <ErrorNote error={err} />
        </div>

        {!done && card.kind !== "confirm" && (
          <div className="mt-6 flex flex-wrap justify-between gap-3">
            {card.allowDefer ? (
              <button className="btn-ghost" disabled={busy} onClick={() => submit("__defer__")}>
                {t.ask.defer}
              </button>
            ) : (
              <span />
            )}
            <button className="btn-primary" disabled={busy || !canConfirm} onClick={() => submit(confirmValue())}>
              {busy ? "…" : card.kind === "invoice" ? "تأیید و پرداخت" : t.ask.confirm}
            </button>
          </div>
        )}
        {done && card.answer !== undefined && card.kind !== "env" && card.kind !== "invoice" && (
          <p className="mt-4 text-xs text-faint">
            انتخاب تو: <Ltr>{typeof card.answer === "string" ? card.answer : JSON.stringify(card.answer)}</Ltr>
          </p>
        )}
      </div>
    </div>
  );
}

function SourceInput({ kind, text, setText, placeholder }: { kind: "git" | "zip"; text: string; setText: (s: string) => void; placeholder: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<string | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setState(`در حال آپلود ${f.name}…`);
    try {
      const r = await upload(f);
      setText(r.uploadId);
      setState(`✓ ${r.name} آپلود شد`);
    } catch (e) {
      setState((e as Error).message);
    }
  };
  if (kind === "git")
    return (
      <div className="mt-4">
        <label className="label" htmlFor="git-url">
          آدرس مخزن Git
        </label>
        <input id="git-url" className="field mono ltr" placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} />
        <p className="mt-2 text-xs text-faint">فقط مخزن‌های عمومی https. توکن یا رمز رو داخل آدرس نذار.</p>
      </div>
    );
  return (
    <button
      type="button"
      className="mt-4 w-full rounded-xl border-[1.5px] border-dashed border-line p-5 text-center text-[13px] text-muted transition-colors hover:border-primary"
      onClick={() => ref.current?.click()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void onFile(e.dataTransfer.files[0]);
      }}
    >
      {state ?? "فایل ZIP رو بکش اینجا یا کلیک کن"}
      <input ref={ref} type="file" accept=".zip" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
    </button>
  );
}

function Slider({ card, value, onChange, disabled }: { card: Card; value: number; onChange: (v: number) => void; disabled: boolean }) {
  const s = card.slider!;
  const toPos = (v: number) => (s.logScale ? (Math.log(v) - Math.log(s.min)) / (Math.log(s.max) - Math.log(s.min)) : (v - s.min) / (s.max - s.min));
  const fromPos = (p: number) => {
    const raw = s.logScale ? Math.exp(Math.log(s.min) + p * (Math.log(s.max) - Math.log(s.min))) : s.min + p * (s.max - s.min);
    const step = raw > 1000 ? 100 : raw > 100 ? 10 : s.step;
    return Math.round(raw / step) * step;
  };
  return (
    <div>
      <div className="mb-3 text-center">
        <span className="text-3xl font-bold">{faNum(value)}</span> <span className="text-muted">{s.unit}</span>
      </div>
      <input type="range" min={0} max={1000} value={Math.round(toPos(value) * 1000)} disabled={disabled} onChange={(e) => onChange(fromPos(Number(e.target.value) / 1000))} className="w-full accent-[#5b8cff]" style={{ direction: "ltr" }} aria-label={card.question} aria-valuetext={`${faNum(value)} ${s.unit}`} />
      <div className="mt-1 flex justify-between text-xs text-faint" dir="ltr">
        <span>{faNum(s.min)}</span>
        <span>{faNum(s.max)}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {s.marks.map((m) => (
          <button key={m.value} className="chip" aria-pressed={value === m.value} disabled={disabled} onClick={() => onChange(m.value)}>
            {faNum(m.value)} · {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Plans({ plans, value, onChange, disabled }: { plans: PlanOption[]; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const [detail, setDetail] = useState<PlanOption | null>(null);
  return (
    <>
      <div className="grid gap-3 md:grid-cols-3">
        {plans.map((p) => {
          const m = money(p.price);
          return (
            <div key={p.planId} className="plan3d panel relative p-4" aria-pressed={value === p.planId}>
              {p.recommended && <span className="badge absolute -top-2.5 right-4">پیشنهاد ایجنت</span>}
              <button className="w-full text-start" disabled={disabled || !p.available} onClick={() => onChange(p.planId)} aria-label={`انتخاب پلن ${p.title}`}>
                <b className="mono ltr block text-base">{p.title}</b>
                <p className="mt-2 text-[13px] text-[#b4bad0]">
                  {p.cpu === null ? "?" : faNum(p.cpu)} هسته · {p.ramGb === null ? "?" : faNum(p.ramGb)} گیگ RAM
                </p>
                <p className="text-[13px] text-[#b4bad0]">{p.diskGb === null ? "?" : faNum(p.diskGb)} گیگ SSD</p>
                {p.capacityHint && <p className="text-[13px] text-[#b4bad0]">{p.capacityHint}</p>}
                <p className="mt-3 text-lg font-bold">{m.text}</p>
                {p.price.monthlyToman !== null && p.price.hourlyToman !== null && <p className="text-xs text-faint">{faNum(p.price.monthlyToman)} تومان / ماه</p>}
                <p className="mt-1 text-[11px] text-faint">{p.price.status === "from_api" ? "قیمت از API لیارا" : (m.note ?? "")}</p>
              </button>
              <button className="btn-ghost btn-sm mt-3 w-full" onClick={() => setDetail(p)}>
                مشخصات کامل
              </button>
            </div>
          );
        })}
      </div>
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `پلن ${detail.title}` : ""}>
        {detail && (
          <div>
            {[
              ["پردازنده", `${detail.cpu ?? "?"} هسته vCPU`],
              ["حافظه RAM", `${detail.ramGb ?? "?"} گیگابایت`],
              ["فضای ذخیره‌سازی", `${detail.diskGb ?? "?"} گیگابایت SSD`],
              ["ظرفیت تقریبی", detail.capacityHint ?? "نامشخص"],
              ["قیمت", money(detail.price).text],
              ...detail.details.map((d) => [d.label, d.value]),
            ].map(([k, v]) => (
              <div key={k} className="row-dash">
                <span>{k}</span>
                <b>{v}</b>
              </div>
            ))}
            <p className="mt-3 text-xs leading-6 text-faint">منبع: {detail.price.source ?? "—"}. ظرفیت کاربر همزمان یک تخمین تقریبیه، نه اندازه‌گیری.</p>
            <button
              className="btn-primary mt-4 w-full"
              disabled={disabled}
              onClick={() => {
                onChange(detail.planId);
                setDetail(null);
              }}
            >
              انتخاب این پلن
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}

function InvoiceBody({ inv }: { inv: NonNullable<Card["invoice"]> }) {
  const total = money(inv.total);
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div>
        {inv.summary.map((s) => (
          <div key={s.label} className="row-dash">
            <span>{s.label}</span>
            <b>{s.value}</b>
          </div>
        ))}
      </div>
      <div>
        {inv.lines.map((l) => (
          <div key={l.label} className="row-dash">
            <span>
              {l.label}
              {l.detail && <span className="block text-[11px] text-faint">{l.detail}</span>}
            </span>
            <b>{money(l.price).text}</b>
          </div>
        ))}
        <div className="row-dash">
          <span>هزینه ساعتی</span>
          <b className="text-lg">{total.text}</b>
        </div>
        {inv.total.hourlyToman !== null && (
          <>
            <div className="row-dash">
              <span>هزینه روزانه</span>
              <b>{faNum(Math.round(inv.total.hourlyToman * 24))} تومان</b>
            </div>
            <div className="row-dash">
              <span>هزینه ماهانه</span>
              <b>{faNum(Math.round(inv.total.hourlyToman * 730))} تومان</b>
            </div>
          </>
        )}
        {total.note && <p className="mt-2 text-xs text-faint">{total.note}</p>}
      </div>
      <div className="md:col-span-2 flex flex-col gap-1.5 rounded-xl border border-primary/25 bg-primary/[0.08] px-3.5 py-3 text-[13px] leading-7 text-[#cfd6ee]">
        {inv.balanceToman !== null && <span>موجودی کیف پول: {faNum(inv.balanceToman)} تومان ({inv.balanceSource})</span>}
        {inv.notes.map((n) => (
          <span key={n}>• {n}</span>
        ))}
      </div>
    </div>
  );
}
