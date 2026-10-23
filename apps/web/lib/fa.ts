import type { Money } from "@liara-agent/shared";

const nf = new Intl.NumberFormat("fa-IR");
export const faNum = (n: number | null | undefined, opts?: Intl.NumberFormatOptions): string => (n === null || n === undefined || Number.isNaN(n) ? "—" : opts ? new Intl.NumberFormat("fa-IR", opts).format(n) : nf.format(n));

const jalali = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric", month: "long", day: "numeric" });
const jalaliTime = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const timeOnly = new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit" });

export const faDate = (iso: string | null | undefined) => (iso ? jalali.format(new Date(iso)) : "—");
export const faDateTime = (iso: string | null | undefined) => (iso ? jalaliTime.format(new Date(iso)) : "—");
export const faTime = (iso: string | null | undefined) => (iso ? timeOnly.format(new Date(iso)) : "—");

const rtf = new Intl.RelativeTimeFormat("fa-IR", { numeric: "auto" });
export function faAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(Math.round(s), "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export function faElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${faNum(s)} ثانیه` : `${faNum(Math.floor(s / 60))}:${faNum(s % 60, { minimumIntegerDigits: 2 })}`;
}

export function money(m: Money | null | undefined): { text: string; note: string | null } {
  if (!m || m.status === "unavailable") return { text: "نامشخص", note: m?.note ?? "هزینه دقیق از داده‌های API در دسترس قابل تعیین نیست." };
  if (m.hourlyToman !== null) return { text: `${faNum(Math.round(m.hourlyToman))} تومان / ساعت`, note: m.note };
  if (m.monthlyToman !== null) return { text: `${faNum(Math.round(m.monthlyToman))} تومان / ماه`, note: m.note };
  return { text: "نامشخص", note: m.note };
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${faNum(Math.round(v * 10) / 10)} ${u[i]}`;
}
