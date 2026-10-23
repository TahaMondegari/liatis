"use client";

import { useEffect, useState } from "react";
import type { ModelView } from "@liara-agent/shared";
import { api, post } from "@/lib/api";
import { faAgo, faNum } from "@/lib/fa";
import { ErrorNote, Ltr, Section } from "@/components/ui/primitives";
import { useShell } from "@/components/shell";

interface Usage {
  local: { byModel: { model: string; calls: number; failures: number; promptTokens: number; completionTokens: number; costToman: number | null; avgLatencyMs: number | null }[]; byDay: { day: string; costToman: number | null; calls: number }[]; todayToman: number };
  workspace: unknown;
  workspaceError: string | null;
}

const ROLE_FA: Record<string, string> = {
  simple_classification: "دسته‌بندی ساده",
  router_complex: "مسیریابی پیچیده",
  project_analysis: "تحلیل پروژه",
  infrastructure_planning: "برنامه‌ریزی زیرساخت",
  normal_reasoning: "استدلال عادی",
  operations_chat: "گفتگوی عملیات",
  root_cause_analysis: "ریشه‌یابی خطا",
  incident_diagnosis: "تشخیص رخداد",
  coding: "کدنویسی و پچ",
  escalation: "ارجاع به مدل قوی‌تر",
  daily_digest: "خلاصه‌ی روزانه",
  embeddings: "Embedding",
};
const SUP = { supported: "✓", unsupported: "✕", unknown: "?" } as const;

export default function AiPage() {
  const { meta } = useShell();
  const [models, setModels] = useState<{ models: ModelView[]; catalogFetchedAt: string | null; catalogError: string | null; roles: Record<string, { primary: string; fallback: string[]; reasoning_effort?: string }> } | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = () => {
    api<typeof models>("/api/ai/models").then(setModels).catch(setErr);
    api<Usage>("/api/ai/usage?days=7").then(setUsage).catch(setErr);
  };
  useEffect(load, []);
  const act = async (label: string, path: string) => {
    setBusy(label);
    setErr(null);
    try {
      await post(path);
      load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <main className="mx-auto max-w-[1300px] px-4 py-8">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">هوش مصنوعی</h1>
        <span className={`badge ${meta?.ai.configured ? "!border-success/50 !bg-success/15 !text-[#6ee7b7]" : "!border-warning/50 !bg-warning/15 !text-[#fcd34d]"}`}>{meta?.ai.configured ? "متصل به Liara AI" : "پیکربندی نشده"}</span>
        <div className="mr-auto flex gap-2">
          <button className="btn-ghost btn-sm" disabled={!!busy} onClick={() => act("catalog", "/api/ai/catalog/refresh")}>
            {busy === "catalog" ? "…" : "به‌روزرسانی کاتالوگ"}
          </button>
          <button className="btn-primary !h-9" disabled={!!busy || !meta?.ai.configured} onClick={() => act("probe", "/api/ai/probe")}>
            {busy === "probe" ? "در حال ارزیابی مدل‌ها…" : "ارزیابی همه‌ی مدل‌ها"}
          </button>
        </div>
      </div>
      <p className="mb-5 max-w-3xl text-sm leading-7 text-muted">
        همه‌ی فراخوانی‌های مدل از یک درگاه می‌گذرن: فقط مدل‌های مجاز، انتخاب ارزان‌ترین مدل کافی برای هر نقش، جایگزینی خودکار در خطا، اعتبارسنجی خروجی ساختاریافته و ثبت هزینه‌ی واقعی (total_cost_toman از پاسخ Liara AI). کاتالوگ: {models?.catalogFetchedAt ? faAgo(models.catalogFetchedAt) : "دریافت نشده"}
        {models?.catalogError ? ` (خطا: ${models.catalogError})` : ""}.
      </p>
      <ErrorNote error={err} />
      <div className="grid gap-4">
        <Section title="مدل‌های مجاز">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>مدل</th>
                  <th>شناسه‌ی ارائه‌دهنده</th>
                  <th>وضعیت</th>
                  <th>Context</th>
                  <th>قیمت ورودی/خروجی (USD/1M)</th>
                  <th>Tools</th>
                  <th>Structured</th>
                  <th>Stream</th>
                  <th>فارسی</th>
                  <th>تأخیر</th>
                  <th>نقش‌ها</th>
                </tr>
              </thead>
              <tbody>
                {models?.models.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Ltr className="font-bold">{m.id}</Ltr>
                    </td>
                    <td>
                      <Ltr className="text-xs text-muted">{m.providerId}</Ltr>
                    </td>
                    <td className={m.available === "verified" ? "st-PASS" : m.available === "listed" ? "st-WARN" : m.available === "unavailable" ? "st-FAIL" : "st-unknown"} title={m.lastProbe?.note ?? undefined}>
                      {{ verified: "آزموده", listed: "در کاتالوگ", unavailable: "در دسترس نیست", unknown: "نامشخص" }[m.available]}
                    </td>
                    <td>{m.contextLength ? faNum(m.contextLength) : "—"}</td>
                    <td>
                      <Ltr className="text-xs">
                        {m.promptPricePerToken !== null ? (m.promptPricePerToken * 1e6).toFixed(2) : "—"} / {m.completionPricePerToken !== null ? (m.completionPricePerToken * 1e6).toFixed(2) : "—"}
                      </Ltr>
                    </td>
                    <td>{SUP[m.supports.tool_calling ?? m.supports.tools ?? "unknown"]}</td>
                    <td>{SUP[m.supports.structured_output ?? m.supports.structured_outputs ?? "unknown"]}</td>
                    <td>{SUP[m.supports.streaming ?? "unknown"]}</td>
                    <td>{SUP[m.supports.persian_output ?? "unknown"]}</td>
                    <td>{m.lastProbe?.latencyMs ? `${faNum(m.lastProbe.latencyMs)}ms` : "—"}</td>
                    <td className="text-xs text-muted">{m.roles.map((r) => ROLE_FA[r] ?? r).join("، ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-faint">✓/✕ از ارزیابی واقعی یا فهرست supported_parameters کاتالوگ؛ «?» یعنی هنوز آزموده نشده. یک تماس موفق دلیل پشتیبانی از همه‌ی قابلیت‌ها حساب نمی‌شه.</p>
        </Section>
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="نقش‌ها و مسیریابی">
            {models &&
              Object.entries(models.roles).map(([role, r]) => (
                <div key={role} className="row-dash text-[13px]">
                  <span>{ROLE_FA[role] ?? role}</span>
                  <Ltr className="text-xs">
                    {r.primary}
                    {r.fallback.length ? ` → ${r.fallback.join(" → ")}` : ""}
                    {r.reasoning_effort ? ` · effort=${r.reasoning_effort}` : ""}
                  </Ltr>
                </div>
              ))}
          </Section>
          <Section title="مصرف و هزینه (۷ روز، دفتر محلی)">
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div className="panel p-3">
                <p className="text-xs text-muted">هزینه‌ی امروز</p>
                <p className="mt-1 text-xl font-bold">{faNum(Math.round(usage?.local.todayToman ?? 0))} تومان</p>
              </div>
              <div className="panel p-3">
                <p className="text-xs text-muted">سقف روزانه</p>
                <p className="mt-1 text-xl font-bold">{meta?.ai.dailyBudgetToman ? `${faNum(meta.ai.dailyBudgetToman)} تومان` : "بدون سقف"}</p>
              </div>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>مدل</th>
                  <th>تماس</th>
                  <th>خطا</th>
                  <th>توکن</th>
                  <th>هزینه</th>
                  <th>میانگین تأخیر</th>
                </tr>
              </thead>
              <tbody>
                {usage?.local.byModel.map((r) => (
                  <tr key={r.model}>
                    <td>
                      <Ltr className="text-xs">{r.model}</Ltr>
                    </td>
                    <td>{faNum(r.calls)}</td>
                    <td>{faNum(r.failures)}</td>
                    <td>{faNum(r.promptTokens + r.completionTokens)}</td>
                    <td>{r.costToman === null ? "نامشخص" : `${faNum(Math.round(r.costToman))} ت`}</td>
                    <td>{r.avgLatencyMs ? `${faNum(r.avgLatencyMs)}ms` : "—"}</td>
                  </tr>
                ))}
                {usage && usage.local.byModel.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-muted">
                      هنوز فراخوانی مدلی ثبت نشده.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="mt-3 text-xs leading-6 text-faint">
              گزارش ورک‌اسپیس Liara AI (GET /v1/workspaces/{"{id}"}/activity): {usage?.workspaceError ?? "دریافت شد"}
            </p>
            {usage?.workspace != null && <pre className="log mono ltr mt-2 max-h-48 whitespace-pre-wrap text-[11px]">{JSON.stringify(usage.workspace, null, 1)}</pre>}
          </Section>
        </div>
      </div>
    </main>
  );
}
