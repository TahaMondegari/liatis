import type { AskCard, Invoice, Money, PlanOption } from "@liara-agent/shared";
import { PLATFORM_LABEL_FA, type ProjectProfile } from "../analyzer/analyzer.js";
import { faNum, newId } from "../util.js";

/** Ask Card factories (board: «ایجنت می‌پرسه»). Copy is Persian end-user text. */
const base = (key: string, kind: AskCard["kind"], question: string, extra: Partial<AskCard> = {}): AskCard => ({
  id: newId("ask"),
  key,
  kind,
  badge: "ایجنت می‌پرسه",
  question,
  allowDefer: true,
  state: "pending",
  ...extra,
});

export function sourceCard(demo: boolean): AskCard {
  return base("source", "source", "ایجنت از کجا کد پروژه رو بخونه؟", {
    description: "ایجنت کدت رو می‌خونه. برای رفع مشکل فقط با تأیید تو روی نسخه‌ی دیپلوی‌شده تغییر می‌ده؛ مخزن اصلیت دست نمی‌خوره.",
    options: [
      { value: "git", label: "مخزن Git", description: "لینک GitHub یا GitLab بده.", icon: "Git" },
      { value: "zip", label: "آپلود فایل", description: "فایل ZIP پروژه رو بکش و رها کن.", icon: "ZIP" },
      { value: "image", label: "Docker Image", description: "از طریق API لیارا پشتیبانی نمی‌شه.", icon: "Img", disabled: true },
      ...(demo ? [{ value: "sample", label: "پروژه‌ی نمونه", description: "فروشگاه Next.js نمونه (حالت دمو).", icon: "Demo" }] : []),
    ],
    text: { placeholder: "https://github.com/acme/shop-front.git", ltr: true },
    defaultValue: demo ? "sample" : "git",
  });
}

export function platformCard(p: ProjectProfile): AskCard {
  const opts = ["next", "node", "react", "vue", "angular", "laravel", "php", "django", "flask", "python", "go", "netcore", "static", "docker"].map((v) => ({ value: v, label: PLATFORM_LABEL_FA[v] ?? v }));
  return base("platform", "select", "نوع برنامه‌ات چیه؟", {
    description: "ایجنت کد رو بررسی کرد و این مورد رو پیدا کرد. اگه اشتباهه عوضش کن.",
    recommendation: { value: p.liaraPlatform.value, reason: `چرا ${PLATFORM_LABEL_FA[p.liaraPlatform.value] ?? p.liaraPlatform.value}؟ ${p.liaraPlatform.evidence}` },
    options: opts,
    defaultValue: p.liaraPlatform.value,
  });
}

export function stageCard(): AskCard {
  return base("stage", "choice", "پروژه الان در چه مرحله‌ایه؟", {
    description: "با این انتخاب، ایجنت پایداری و هزینه رو متناسب تنظیم می‌کنه.",
    options: [
      { value: "test", label: "تست", description: "برای امتحان کردن و رفع باگ. کم‌هزینه‌ترین حالت.", meta: "هزینه: کم", icon: "T" },
      { value: "demo", label: "دموی اولیه", description: "نمایش به چند نفر یا مشتری. پایداری متوسط.", meta: "هزینه: متوسط", icon: "D", recommended: true },
      { value: "production", label: "پروداکشن", description: "کاربران واقعی. پشتیبان‌گیری و پایداری بالا.", meta: "هزینه: بیشتر", icon: "P" },
    ],
    recommendation: { value: "demo", reason: "مطمئن نیستی؟ «دموی اولیه» رو نگه دار؛ هر وقت خواستی می‌تونی به پروداکشن ارتقا بدی." },
    defaultValue: "demo",
  });
}

export function usersCard(initial: number): AskCard {
  return base("users", "slider", "چند نفر همزمان وارد سایت می‌شن؟", {
    description: "نوار رو بکش تا ظرفیت مناسب پیدا بشه. دقیق نبودن مشکلی نداره.",
    slider: {
      min: 10,
      max: 20000,
      step: 10,
      unit: "کاربر همزمان",
      logScale: true,
      marks: [
        { value: 100, label: "وبلاگ کوچک" },
        { value: 1000, label: "فروشگاه کوچک" },
        { value: 5000, label: "فروشگاه متوسط" },
        { value: 20000, label: "کمپین بزرگ" },
      ],
    },
    tip: "«همزمان» یعنی همین لحظه چند نفر داخل سایت هستن، نه تعداد کل کاربران.",
    defaultValue: initial,
  });
}

export function appNameCard(suggested: string): AskCard {
  return base("appName", "text", "برای برنامه‌ات یه شناسه انتخاب کن", {
    description: "این شناسه اسم پروژه و بخشی از آدرس سایتته. ایجنت یه اسم پیشنهاد داده.",
    text: { placeholder: suggested, pattern: "^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$", ltr: true, prefix: "https://", suffix: ".liara.run", hint: "فقط حروف انگلیسی کوچک، عدد و خط تیره" },
    recommendation: { value: suggested, reason: "از اسم پروژه ساخته شد." },
    defaultValue: suggested,
  });
}

export function databaseCard(kind: string, evidence: string, existing: { id: string; hostname: string; type: string | null }[], versions: string[]): AskCard {
  return base("database", "choice", `دیتابیس ${kind === "postgres" ? "PostgreSQL" : kind} لازم داره؛ چی کار کنیم؟`, {
    description: `در کد پیدا شد: ${evidence}`,
    options: [
      { value: "new", label: "ساخت دیتابیس جدید در لیارا", description: `${kind}${versions.length ? ` · نسخه ${versions[0]}` : ""}`, recommended: true },
      ...existing.filter((d) => !d.type || d.type === kind).map((d) => ({ value: `existing:${d.id}:${d.hostname}`, label: `استفاده از ${d.hostname}`, description: d.type ?? "" })),
      { value: "none", label: "فعلاً نه", description: "DATABASE_URL رو خودم وارد می‌کنم." },
    ],
    defaultValue: "new",
  });
}

export function networkCard(hasDb: boolean): AskCard {
  return base("network", "choice", "شبکه خصوصی لازم داری؟", {
    description: "با شبکه خصوصی، دیتابیس و برنامه‌ات فقط با هم ارتباط دارن و از بیرون دیده نمی‌شن. مثل یه اتاق قفل‌شده.",
    options: [
      { value: "yes", label: "بله، شبکه خصوصی", description: hasDb ? "پیشنهاد می‌شه چون پروژه دیتابیس داره." : "", recommended: hasDb },
      { value: "no", label: "نه، لازم نیست", description: "برای سایت‌های ساده بدون دیتابیس.", recommended: !hasDb },
    ],
    text: { placeholder: "shop-private-net", ltr: true, hint: "نام شبکه‌ای که در کنسول لیارا ساختی. ساخت شبکه از طریق API ممکن نیست." },
    defaultValue: hasDb ? "yes" : "no",
  });
}

export function envCard(keys: { key: string; required: boolean; hint?: string }[]): AskCard {
  return base("env", "env", "این متغیرهای محیطی رو لازم داره", {
    description: "مقدارها فقط سمت سرور و رمزنگاری‌شده نگه داشته می‌شن؛ به مدل هوش مصنوعی، لاگ‌ها یا مرورگرهای دیگه نمی‌رسن.",
    envKeys: keys,
  });
}

export function planCard(plans: PlanOption[], users: number, reason: string): AskCard {
  return base("plan", "plan", "منابع و پلن سرور", {
    description: reason,
    plans,
    tip: "پلن بزرگ‌تر لازم شد؟ بعداً بدون از دست دادن اطلاعات ارتقا می‌دی.",
    defaultValue: plans.find((p) => p.recommended)?.planId,
    recommendation: plans.find((p) => p.recommended) ? { value: plans.find((p) => p.recommended)!.planId, reason: `برای ${faNum(users)} کاربر همزمان` } : undefined,
  });
}

export function invoiceCard(invoice: Invoice, approvalIds: string[]): AskCard {
  return base("invoice", "invoice", "فاکتور نهایی", {
    badge: "جمع‌بندی ایجنت",
    description: "همه‌چیز رو یک بار مرور کن، بعد تأیید کن.",
    invoice,
    allowDefer: false,
    defaultValue: approvalIds,
  });
}

export function confirmCard(key: string, question: string, description: string, options: { value: string; label: string; description?: string; recommended?: boolean }[]): AskCard {
  return base(key, "confirm", question, { description, options, allowDefer: false });
}

export function patrolCard(app: string, hours: number): AskCard {
  return base("patrol", "choice", `هر ${faNum(hours)} ساعت سلامت ${app} رو چک کنم؟`, {
    badge: "پایش سلامت",
    description: "اگه همه‌چیز سالم باشه، مزاحمت نمی‌شم. چک‌های سالم هیچ هزینه‌ی هوش مصنوعی ندارن.",
    options: [
      { value: "on", label: "بله، فعالش کن", recommended: true },
      { value: "off", label: "فعلاً نه" },
    ],
    defaultValue: "on",
  });
}

/** Clearly-labelled sizing heuristic: RAM estimate from platform baseline + concurrency. */
export function estimateRamGb(platform: string, users: number): number {
  const baseGb: Record<string, number> = { next: 1, node: 0.5, laravel: 1, php: 0.5, django: 1, flask: 0.5, python: 0.5, go: 0.25, netcore: 1, static: 0.25, react: 0.25, vue: 0.25, angular: 0.25, docker: 1 };
  return (baseGb[platform] ?? 0.5) + users / 1800;
}

export function capacityHint(platform: string, ramGb: number | null): string | null {
  if (ramGb === null) return null;
  const baseGb = estimateRamGb(platform, 0);
  const users = Math.max(0, Math.round(((ramGb - baseGb) * 1800) / 100) * 100);
  return users > 0 ? `تا حدود ${faNum(users)} کاربر همزمان (تخمین)` : "مناسب ترافیک خیلی کم (تخمین)";
}

export function money(m: Money | null | undefined): string {
  if (!m || m.status === "unavailable") return "نامشخص";
  if (m.hourlyToman !== null) return `${faNum(Math.round(m.hourlyToman))} تومان / ساعت`;
  if (m.monthlyToman !== null) return `${faNum(Math.round(m.monthlyToman))} تومان / ماه`;
  return "نامشخص";
}

/** Hourly from monthly is a derived estimate (730h/month) and labelled as such. */
export function hourlyOf(m: Money): number | null {
  if (m.hourlyToman !== null) return m.hourlyToman;
  if (m.monthlyToman !== null) return m.monthlyToman / 730;
  return null;
}
