"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary } from "@liara-agent/shared";
import { api } from "@/lib/api";
import { faAgo, faNum } from "@/lib/fa";
import { Empty, ErrorNote, Ltr, Status } from "@/components/ui/primitives";
import { useShell } from "@/components/shell";

export default function ProjectsPage() {
  const router = useRouter();
  const { meta } = useShell();
  const [rows, setRows] = useState<ProjectSummary[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [filter, setFilter] = useState<"all" | "healthy" | "warning" | "incident">("all");
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const load = () =>
    api<ProjectSummary[]>("/api/projects")
      .then((r) => {
        setRows(r);
        setSyncedAt(new Date().toISOString());
      })
      .catch(setErr);
  useEffect(() => {
    void load();
  }, []);
  const shown = useMemo(() => (rows ?? []).filter((p) => (filter === "all" ? true : filter === "incident" ? p.openIncidents > 0 : filter === "healthy" ? p.health === "healthy" : p.health === "warning" || p.health === "failing")), [rows, filter]);

  return (
    <main className="mx-auto max-w-[1300px] px-4 py-8">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">پروژه‌ها</h1>
        {meta?.mode === "demo" && <span className="badge !border-warning/50 !bg-warning/15 !text-[#fcd34d]">داده نمونه</span>}
        <Link href="/chat" className="btn-primary mr-auto inline-flex items-center">
          + پروژه‌ی جدید در چت
        </Link>
      </div>
      <div className="card mb-4 flex flex-wrap items-center gap-3 p-3.5 text-sm">
        <span className={`h-2 w-2 rounded-full ${err ? "bg-danger" : "bg-success"}`} />
        <span>{err ? "اتصال به لیارا برقرار نیست" : `اتصال لیارا برقرار است${syncedAt ? ` · آخرین همگام‌سازی ${faAgo(syncedAt)}` : ""}`}</span>
        <button className="btn-ghost btn-sm mr-auto" onClick={() => void load()}>
          همگام‌سازی دوباره
        </button>
      </div>
      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {(
          [
            ["all", "همه"],
            ["healthy", "سالم"],
            ["warning", "هشدار"],
            ["incident", "رخداد باز"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={filter === k} aria-pressed={filter === k} className="chip" onClick={() => setFilter(k)}>
            {l}
          </button>
        ))}
      </div>
      <ErrorNote error={err} />
      {rows && rows.length === 0 && <Empty title="هنوز پروژه‌ای نداری" sub="در چت بگو «پروژه‌م رو دیپلوی کن» تا شروع کنیم." />}
      {rows && rows.length > 0 && (
        <div className="card overflow-x-auto p-2">
          <table className="tbl">
            <thead>
              <tr>
                <th>نام</th>
                <th>فریم‌ورک</th>
                <th>محیط</th>
                <th>آخرین دیپلوی</th>
                <th>سلامت</th>
                <th>دامنه اصلی</th>
                <th>رخداد</th>
                <th>پایش</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.name} className="cursor-pointer" onClick={() => router.push(`/projects/${p.name}`)}>
                  <td>
                    <Link href={`/projects/${p.name}`} className="font-bold">
                      <Ltr>{p.name}</Ltr>
                    </Link>
                  </td>
                  <td>{p.platform ?? "—"}</td>
                  <td>{p.environment === "production" ? "پروداکشن" : p.environment === "demo" ? "دمو" : p.environment === "test" ? "تست" : "—"}</td>
                  <td>{p.lastDeployAt ? faAgo(p.lastDeployAt) : "—"}</td>
                  <td>
                    <Status s={p.health} />
                  </td>
                  <td>{p.primaryDomain ? <Ltr>{p.primaryDomain}</Ltr> : "—"}</td>
                  <td>{p.openIncidents ? <span className="st-FAIL">{faNum(p.openIncidents)} رخداد باز</span> : "—"}</td>
                  <td>{p.patrolEnabled ? "✓" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-xs text-faint">
            {faNum(shown.length)} از {faNum(rows.length)} پروژه · با کلیک روی ردیف وارد جزئیات پروژه می‌شی
          </p>
        </div>
      )}
    </main>
  );
}
