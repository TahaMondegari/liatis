"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import type { IncidentView, MetricSeries, PatrolRunView, PatrolSettings } from "@liara-agent/shared";
import { api, post, put } from "@/lib/api";
import { faAgo, faDateTime, faNum } from "@/lib/fa";
import { MetricChart, VerificationView } from "@/components/blocks/Blocks";
import { ErrorNote, Ltr, Section, Status } from "@/components/ui/primitives";

interface Detail {
  app: { name: string; platform: string | null; status: string | null; scale: number | null; planId: string | null; envKeys: string[]; zeroDowntime: boolean | null; defaultSubdomain: boolean | null; hourlyPrice: number | null; createdAt: string | null };
  plan: { ramGb: number | null; cpu: number | null; hourly: number | null };
  releases: { current: string | null; releases: { id: string; state: string; createdAt: string | null; tag: string | null }[] } | null;
  domains: { id: string; name: string; status: string | null; certificatesStatus: string | null; cname: string | null }[];
  applets: { name: string | null; state: string | null; reason: string | null }[];
  deployments: { id: string; release_id: string | null; status: string; started_at: string; finished_at: string | null }[];
  patrol: PatrolSettings | null;
  incidents: IncidentView[];
}

const TABS = [
  ["overview", "نمای کلی"],
  ["deploys", "دیپلوی‌ها"],
  ["logs", "لاگ‌ها"],
  ["monitor", "پایش"],
  ["settings", "تنظیمات"],
] as const;

export default function ProjectPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("overview");
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => api<Detail>(`/api/projects/${name}`).then(setD).catch(setErr), [name]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto max-w-[1300px] px-4 py-8">
      <p className="mb-2 text-sm text-muted">
        <Link href="/projects">پروژه‌ها</Link> / <Ltr>{name}</Ltr>
      </p>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mono ltr text-2xl font-bold">{name}</h1>
        {d && <Status s={d.app.scale === 0 ? "stopped" : d.incidents.some((i) => i.state !== "RESOLVED" && i.state !== "FAILED") ? "warning" : "healthy"} />}
        <a className="btn-ghost btn-sm mr-auto inline-flex items-center" href={`https://${name}.liara.run`} target="_blank" rel="noreferrer noopener">
          باز کردن سایت ↗
        </a>
        <Link href="/chat" className="btn-ghost btn-sm inline-flex items-center">
          پرسیدن از ایجنت
        </Link>
      </div>
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-[#232940]" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`border-b-2 px-4 py-3 text-sm transition-colors ${tab === k ? "border-primary text-white" : "border-transparent text-muted hover:text-white"}`}>
            {l}
          </button>
        ))}
      </div>
      <ErrorNote error={err} />
      {d && tab === "overview" && <Overview d={d} />}
      {d && tab === "deploys" && <Deploys d={d} />}
      {tab === "logs" && <Logs name={name} />}
      {tab === "monitor" && <Monitor name={name} />}
      {d && tab === "settings" && <Settings d={d} />}
    </main>
  );
}

function Overview({ d }: { d: Detail }) {
  const open = d.incidents.filter((i) => i.state !== "RESOLVED" && i.state !== "FAILED");
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Section title="برنامه" className="md:col-span-1">
        {[
          ["پلتفرم", d.app.platform ?? "—"],
          ["وضعیت", d.app.scale === 0 ? "خاموش" : (d.app.status ?? "—")],
          ["پلن", d.app.planId ?? "—"],
          ["منابع", `${d.plan.cpu ?? "?"} هسته · ${d.plan.ramGb ?? "?"} گیگ`],
          ["هزینه ساعتی", d.app.hourlyPrice !== null ? `${faNum(Math.round(d.app.hourlyPrice))} تومان` : "نامشخص"],
          ["ساخته شده", faDateTime(d.app.createdAt)],
        ].map(([k, v]) => (
          <div key={k} className="row-dash">
            <span>{k}</span>
            <b>{v}</b>
          </div>
        ))}
      </Section>
      <Section title="کانتینرها">
        {d.applets.length === 0 && <p className="text-sm text-muted">اطلاعاتی نیست.</p>}
        {d.applets.map((a, i) => (
          <div key={i} className="row-dash">
            <Ltr>{a.name ?? "?"}</Ltr>
            <span className={/running/i.test(a.state ?? "") ? "st-PASS" : "st-FAIL"}>
              {a.state}
              {a.reason ? ` (${a.reason})` : ""}
            </span>
          </div>
        ))}
      </Section>
      <Section title="رخدادهای باز">
        {open.length === 0 && <p className="text-sm text-muted">رخداد بازی نیست.</p>}
        {open.map((i) => (
          <Link key={i.id} href={`/incidents?id=${i.id}`} className="row-dash">
            <span>
              {i.code} · {i.title}
            </span>
            <Status s={i.severity} />
          </Link>
        ))}
      </Section>
      <Section title="دامنه‌ها" className="md:col-span-3">
        {d.domains.length === 0 ? (
          <p className="text-sm text-muted">دامنه‌ای وصل نیست. در چت بگو «دامنه example.ir رو وصل کن».</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>دامنه</th>
                <th>وضعیت</th>
                <th>SSL</th>
                <th>CNAME</th>
              </tr>
            </thead>
            <tbody>
              {d.domains.map((x) => (
                <tr key={x.id}>
                  <td>
                    <Ltr>{x.name}</Ltr>
                  </td>
                  <td>{x.status ?? "—"}</td>
                  <td>{x.certificatesStatus ?? "—"}</td>
                  <td>
                    <Ltr>{x.cname ?? "—"}</Ltr>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function Deploys({ d }: { d: Detail }) {
  return (
    <div className="grid gap-4">
      <Section title="نسخه‌های لیارا (GET releases)">
        <table className="tbl">
          <thead>
            <tr>
              <th>شناسه</th>
              <th>برچسب</th>
              <th>وضعیت</th>
              <th>زمان</th>
            </tr>
          </thead>
          <tbody>
            {(d.releases?.releases ?? []).map((r) => (
              <tr key={r.id} className={r.id === d.releases?.current ? "sel" : ""}>
                <td>
                  <Ltr className="text-xs">{r.id}</Ltr> {r.id === d.releases?.current && <span className="badge">فعلی</span>}
                </td>
                <td>{r.tag ?? "—"}</td>
                <td>
                  <Status s={r.state === "READY" ? "PASS" : r.state === "FAILED" ? "FAIL" : "RUNNING"}>{r.state}</Status>
                </td>
                <td>{faAgo(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="دیپلوی‌های ایجنت">
        {d.deployments.length === 0 ? (
          <p className="text-sm text-muted">ایجنت هنوز برای این برنامه دیپلوی نکرده.</p>
        ) : (
          d.deployments.map((x) => (
            <div key={x.id} className="row-dash">
              <span>
                {faDateTime(x.started_at)} · <Ltr className="text-xs">{x.release_id ?? "—"}</Ltr>
              </span>
              <Status s={x.status === "succeeded" ? "PASS" : "FAIL"}>{x.status === "succeeded" ? "موفق و بررسی‌شده" : "بررسی سلامت رد شد"}</Status>
            </div>
          ))
        )}
      </Section>
    </div>
  );
}

interface LogRow {
  at: string;
  type: string;
  level: "ERROR" | "WARN" | "INFO";
  message: string;
}

function Logs({ name }: { name: string }) {
  const [minutes, setMinutes] = useState(30);
  const [levels, setLevels] = useState<string[]>(["ERROR", "WARN", "INFO"]);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<LogRow[]>([]);
  const [sel, setSel] = useState<LogRow | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [live, setLive] = useState(true);
  const load = useCallback(() => {
    const q = new URLSearchParams({ minutes: String(minutes), level: levels.join(","), ...(search ? { search } : {}) });
    api<{ lines: LogRow[] }>(`/api/projects/${name}/logs?${q}`)
      .then((r) => setRows(r.lines.slice().reverse()))
      .catch(setErr);
  }, [name, minutes, levels, search]);
  useEffect(() => {
    load();
    if (!live) return;
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, [load, live]);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select className="field !h-9 !w-44 !text-sm" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="بازه">
            <option value={30}>۳۰ دقیقه‌ی اخیر</option>
            <option value={180}>۳ ساعت اخیر</option>
            <option value={1440}>امروز (۲۴ ساعت)</option>
          </select>
          {["ERROR", "WARN", "INFO"].map((l) => (
            <button key={l} className="chip" aria-pressed={levels.includes(l)} onClick={() => setLevels(levels.includes(l) ? levels.filter((x) => x !== l) : [...levels, l])}>
              {l}
            </button>
          ))}
          <input className="field !h-9 !w-48 !text-sm" placeholder="جستجو" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="chip" onClick={() => { setLevels(["ERROR", "WARN", "INFO"]); setSearch(""); }}>
            پاک‌کردن فیلترها
          </button>
          <label className="mr-auto flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> زنده
          </label>
        </div>
        <ErrorNote error={err} />
        <div className="log max-h-[60vh] !p-1" role="log">
          {rows.map((r, i) => (
            <button key={i} onClick={() => setSel(r)} className={`mono ltr grid w-full grid-cols-[80px_56px_1fr] gap-2 rounded-lg px-3 py-1.5 text-left text-[12.5px] ${sel === r ? "bg-primary/15" : "hover:bg-white/5"}`}>
              <span className="text-faint">{r.at.slice(11, 19)}</span>
              <span className={r.level === "ERROR" ? "lv-error" : r.level === "WARN" ? "lv-warn" : "text-muted"}>{r.level}</span>
              <span className="truncate">{r.message.split("\n")[0]}</span>
            </button>
          ))}
          {rows.length === 0 && <p className="p-3 text-sm text-muted">رکوردی در این بازه نیست.</p>}
        </div>
        <p className="mt-2 text-xs text-faint">
          {live ? "اتصال زنده برقراره" : "زنده خاموشه"} · {faNum(rows.length)} رکورد · دانلود فایل لاگ از طریق API فعلی لیارا ممکن نیست؛ از «کپی» استفاده کن.
        </p>
      </div>
      <div className="card p-4">
        <h3 className="mb-3 font-bold">جزئیات رکورد</h3>
        {sel ? (
          <>
            <Status s={sel.level === "ERROR" ? "FAIL" : sel.level === "WARN" ? "WARN" : "PASS"}>{sel.level}</Status>
            <pre className="log mono ltr mt-3 whitespace-pre-wrap">{sel.message}</pre>
            <div className="row-dash mt-3">
              <span>زمان</span>
              <span>{faDateTime(sel.at)}</span>
            </div>
            <div className="row-dash">
              <span>جریان</span>
              <Ltr>{sel.type}</Ltr>
            </div>
            <button className="btn-ghost btn-sm mt-3" onClick={() => navigator.clipboard?.writeText(sel.message)}>
              کپی
            </button>
          </>
        ) : (
          <p className="text-sm text-muted">یک رکورد رو انتخاب کن.</p>
        )}
      </div>
    </div>
  );
}

function Monitor({ name }: { name: string }) {
  const [series, setSeries] = useState<MetricSeries[]>([]);
  const [ram, setRam] = useState<number | null>(null);
  const [hours, setHours] = useState(6);
  const [p, setP] = useState<{ settings: PatrolSettings | null; history: PatrolRunView[] } | null>(null);
  const [sel, setSel] = useState<PatrolRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const loadP = useCallback(() => api<{ settings: PatrolSettings | null; history: PatrolRunView[] }>(`/api/projects/${name}/patrol`).then((r) => { setP(r); setSel((s) => s ?? r.history[0] ?? null); }), [name]);
  useEffect(() => {
    api<{ series: MetricSeries[]; plan: { ramGb: number | null } }>(`/api/projects/${name}/metrics?hours=${hours}`).then((r) => {
      setSeries(r.series);
      setRam(r.plan.ramGb ? r.plan.ramGb * 1024 ** 3 : null);
    }).catch(setErr);
  }, [name, hours]);
  useEffect(() => {
    void loadP();
  }, [loadP]);
  const s = p?.settings;
  const save = async (patch: Partial<PatrolSettings>) => {
    setErr(null);
    try {
      await put(`/api/projects/${name}/patrol`, patch);
      await loadP();
    } catch (e) {
      setErr(e);
    }
  };
  const runNow = async () => {
    setBusy(true);
    try {
      const r = await post<PatrolRunView>(`/api/projects/${name}/patrol/run`);
      setSel(r);
      await loadP();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const CHECKS: [string, string][] = [
    ["status", "وضعیت و ری‌استارت‌ها"],
    ["http", "باز شدن صفحه‌ها و سرعتشون"],
    ["tls", "گواهی SSL و دامنه"],
    ["resources", "مصرف CPU و RAM"],
    ["logs", "ارورهای جدید لاگ"],
    ["disk", "فضای دیسک و بکاپ دیتابیس"],
    ["wallet", "موجودی کیف پول"],
  ];
  return (
    <div className="grid gap-4">
      <ErrorNote error={err} />
      <Section
        title="مصرف منابع"
        actions={
          <select className="field !h-9 !w-40 !text-sm" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="بازه">
            <option value={1}>۱ ساعت</option>
            <option value={6}>۶ ساعت</option>
            <option value={24}>۲۴ ساعت</option>
            <option value={168}>۷ روز</option>
          </select>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          {series.map((x) => (
            <MetricChart key={x.key} s={x} ramBytes={x.key === "memory" ? ram : undefined} />
          ))}
        </div>
      </Section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={`پایش سلامت · ${name}`} actions={<button className="btn-primary !h-9" disabled={busy} onClick={runNow}>{busy ? "…" : "همین الان چک کن"}</button>}>
          <p className="mb-3 text-sm text-muted">
            {s?.lastRunAt ? `آخرین چک: ${faAgo(s.lastRunAt)}` : "هنوز چکی انجام نشده"} · {s?.nextRunAt && s.enabled ? `چک بعدی: ${faAgo(s.nextRunAt)}` : "زمان‌بندی خاموشه"}
          </p>
          <label className="mb-4 flex items-center justify-between">
            <span className="text-sm font-bold">هر چند ساعت چک کنم؟ اگه همه‌چیز سالم باشه، مزاحمت نمی‌شم.</span>
            <input type="checkbox" checked={Boolean(s?.enabled)} onChange={(e) => void save({ enabled: e.target.checked })} aria-label="فعال بودن پایش" />
          </label>
          <div className="mb-4 flex flex-wrap gap-2">
            {[1, 3, 6, 12, 24].map((h) => (
              <button key={h} className="chip" aria-pressed={s?.intervalHours === h} onClick={() => void save({ intervalHours: h, enabled: true })}>
                {faNum(h)} ساعت
              </button>
            ))}
          </div>
          <p className="label">چی چک می‌شه؟</p>
          <div className="mb-4 grid gap-2 sm:grid-cols-2">
            {CHECKS.map(([k, l]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={s?.checks?.[k] !== false} onChange={(e) => void save({ checks: { ...(s?.checks ?? {}), [k]: e.target.checked } })} /> {l}
              </label>
            ))}
          </div>
          <p className="label">خبر دادن از طریق</p>
          <div className="mb-4 flex flex-wrap gap-2">
            {(["inApp", "telegram", "email"] as const).map((c) => (
              <button key={c} className="chip" aria-pressed={Boolean(s?.channels?.[c])} onClick={() => void save({ channels: { inApp: true, telegram: false, email: false, ...(s?.channels ?? {}), [c]: !s?.channels?.[c] } })}>
                {{ inApp: "داخل برنامه", telegram: "تلگرام", email: "ایمیل (Liara Mail)" }[c]}
              </button>
            ))}
          </div>
          <div className="panel p-3">
            <label className="flex items-center justify-between gap-3">
              <span>
                <b className="text-sm">پیشرفته · اجازه‌ی اقدام خودکار</b>
                <span className="block text-xs leading-6 text-muted">ری‌استارت وقتی برنامه مدام کرش می‌کنه · حداکثر ۱ بار در ۲۴ ساعت</span>
              </span>
              <input type="checkbox" checked={Boolean(s?.autoRestartOnCrashLoop)} onChange={(e) => void save({ autoRestartOnCrashLoop: e.target.checked })} />
            </label>
            {s?.autoRestartOnCrashLoop && <p className="mt-2 text-xs text-[#fcd34d]">هشدار: ایجنت بدون اینکه ازت بپرسه ری‌استارت می‌کنه. روی سرویس اثر می‌ذاره.</p>}
          </div>
        </Section>
        <Section title={`تاریخچه‌ی چک‌ها · ${faNum(p?.history.length ?? 0)} چک اخیر`}>
          <div className="mb-4 flex flex-wrap gap-1.5" role="list">
            {(p?.history ?? []).slice().reverse().map((r) => (
              <button
                key={r.id}
                role="listitem"
                title={`${faDateTime(r.startedAt)} · ${r.status} · مدل: ${r.llmCalls}`}
                onClick={() => setSel(r)}
                className={`h-3.5 w-3.5 rounded-full ${r.status === "healthy" ? "bg-success" : r.status === "warning" ? "bg-warning" : "bg-danger"} ${sel?.id === r.id ? "ring-2 ring-primary ring-offset-2 ring-offset-surface" : ""}`}
              />
            ))}
          </div>
          {sel && (
            <>
              <p className="mb-2 text-xs text-muted">
                جزئیات چک {faDateTime(sel.startedAt)} · {sel.trigger === "manual" ? "دستی" : sel.trigger === "catch_up" ? "جبرانی" : "زمان‌بندی"} · فراخوانی مدل هوش مصنوعی: {faNum(sel.llmCalls)}
              </p>
              <VerificationView title="" checks={sel.checks} delta={[]} />
            </>
          )}
        </Section>
      </div>
    </div>
  );
}

function Settings({ d }: { d: Detail }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Section title="متغیرهای محیطی">
        <p className="mb-3 text-xs text-muted">فقط نام متغیرها نمایش داده می‌شه؛ مقدارها هیچ‌وقت به مرورگر یا مدل ارسال نمی‌شن.</p>
        <div className="flex flex-wrap gap-2">
          {d.app.envKeys.length ? d.app.envKeys.map((k) => <span key={k} className="chip mono ltr">{k}</span>) : <span className="text-sm text-muted">متغیری تنظیم نشده.</span>}
        </div>
      </Section>
      <Section title="تنظیمات پلتفرم">
        {[
          ["دپلوی بدون اختلال", d.app.zeroDowntime],
          ["زیردامنه‌ی پیش‌فرض liara.run", d.app.defaultSubdomain],
        ].map(([k, v]) => (
          <div key={String(k)} className="row-dash">
            <span>{k}</span>
            <b>{v === null ? "نامشخص" : v ? "روشن" : "خاموش"}</b>
          </div>
        ))}
        <p className="mt-3 text-xs leading-6 text-muted">برای تغییر این تنظیم‌ها در چت بگو (مثلاً «دپلوی بدون اختلال رو روشن کن»)؛ همه‌ی تغییرها با کارت تأیید انجام می‌شن.</p>
      </Section>
    </div>
  );
}
