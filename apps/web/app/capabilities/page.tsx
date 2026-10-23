"use client";

import { useEffect, useMemo, useState } from "react";
import type { CapabilityView } from "@liara-agent/shared";
import { api } from "@/lib/api";
import { faNum } from "@/lib/fa";
import { ErrorNote, Ltr, Risk } from "@/components/ui/primitives";

const SERVICE_FA: Record<string, string> = {
  paas: "پلتفرم (PaaS)",
  dbaas: "دیتابیس",
  dbinspector: "مدیریت داده‌ی دیتابیس",
  dns: "DNS",
  storage: "ذخیره‌سازی ابری",
  mail: "ایمیل",
  filebrowser: "فایل‌های دیسک",
  iaas: "سرور مجازی",
  billing: "صورتحساب",
  account: "حساب",
  ai_inference: "هوش مصنوعی · استنتاج",
  ai_workspaces: "هوش مصنوعی · ورک‌اسپیس",
  ai_keys: "هوش مصنوعی · کلیدها",
  ai_logs: "هوش مصنوعی · لاگ‌ها",
  ai_models: "هوش مصنوعی · کاتالوگ مدل",
  ai_playground: "هوش مصنوعی · Playground",
};
const ST_FA = { supported: "پشتیبانی‌شده", partial: "ناقص", unsupported: "پشتیبانی‌نشده", unknown: "نامشخص" } as const;

export default function CapabilitiesPage() {
  const [caps, setCaps] = useState<CapabilityView[]>([]);
  const [q, setQ] = useState("");
  const [st, setSt] = useState<string>("all");
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    api<CapabilityView[]>("/api/capabilities").then(setCaps).catch(setErr);
  }, []);
  const groups = useMemo(() => {
    const f = caps.filter((c) => (st === "all" || c.status === st) && (!q || `${c.labelFa} ${c.id} ${c.endpoint ?? ""}`.toLowerCase().includes(q.toLowerCase())));
    const g = new Map<string, CapabilityView[]>();
    for (const c of f) g.set(c.service, [...(g.get(c.service) ?? []), c]);
    return [...g.entries()];
  }, [caps, q, st]);
  const count = (s: string) => caps.filter((c) => c.status === s).length;
  return (
    <main className="mx-auto max-w-[1300px] px-4 py-8">
      <h1 className="text-2xl font-bold">قابلیت‌ها و محدودیت‌ها</h1>
      <p className="mb-5 mt-2 max-w-3xl text-sm leading-7 text-muted">
        هر عملیات اجرایی فقط از روی مشخصات رسمی OpenAPI لیارا ساخته شده. چیزی که در API نیست، «پشتیبانی‌نشده» علامت خورده و ایجنت مراحل دستی‌اش رو توضیح می‌ده. {faNum(count("supported"))} پشتیبانی‌شده · {faNum(count("partial"))} ناقص · {faNum(count("unsupported"))} پشتیبانی‌نشده.
      </p>
      <div className="mb-4 flex flex-wrap gap-2">
        <input className="field !h-9 !w-64 !text-sm" placeholder="جستجو" value={q} onChange={(e) => setQ(e.target.value)} />
        {(["all", "supported", "partial", "unsupported"] as const).map((s) => (
          <button key={s} className="chip" aria-pressed={st === s} onClick={() => setSt(s)}>
            {s === "all" ? "همه" : ST_FA[s]}
          </button>
        ))}
      </div>
      <ErrorNote error={err} />
      <div className="flex flex-col gap-4">
        {groups.map(([svc, list]) => (
          <details key={svc} className="card p-4" open={st !== "all" || !!q}>
            <summary className="cursor-pointer font-bold">
              {SERVICE_FA[svc] ?? svc} <span className="text-xs font-normal text-muted">· {faNum(list.length)}</span>
            </summary>
            <div className="mt-3 overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>قابلیت</th>
                    <th>وضعیت</th>
                    <th>ریسک</th>
                    <th>Endpoint</th>
                    <th>در دسترس مدل</th>
                    <th>توضیح</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((c) => (
                    <tr key={c.id}>
                      <td>{c.labelFa}</td>
                      <td className={c.status === "supported" ? "st-PASS" : c.status === "partial" ? "st-WARN" : "st-FAIL"}>{ST_FA[c.status]}</td>
                      <td>
                        <Risk level={c.risk} />
                      </td>
                      <td>{c.endpoint ? <Ltr className="text-xs">{`${c.method} ${c.endpoint}`}</Ltr> : "—"}</td>
                      <td>{c.exposedToAgent ? "✓" : "—"}</td>
                      <td className="max-w-md text-xs leading-6 text-muted">
                        {c.notes ?? ""} {c.sourceUrl && <a className="text-primary-soft" href={c.sourceUrl} target="_blank" rel="noreferrer noopener">منبع</a>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </div>
    </main>
  );
}
