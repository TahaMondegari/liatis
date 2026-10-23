/** Persian end-user copy used by the server (phase labels, step labels, common phrases). */
export const PHASE_FA = {
  analyzing_request: "در حال تحلیل درخواست",
  fetching_project: "در حال دریافت و بررسی پروژه",
  analyzing_project: "در حال تحلیل پروژه",
  running_tests: "در حال اجرای تست‌ها",
  reading_logs: "در حال بررسی لاگ‌ها",
  finding_root_cause: "در حال پیدا کردن علت خطا",
  building_patch: "در حال ساخت Patch",
  waiting_approval: "در انتظار تأیید شما",
  waiting_answer: "منتظر انتخاب شما",
  deploying: "در حال Deploy",
  verifying: "در حال بررسی سلامت سرویس",
  reconnecting: "در حال تلاش برای اتصال مجدد",
  failed: "عملیات با خطا مواجه شد",
  calling_liara: "در حال دریافت اطلاعات از لیارا",
  thinking: "در حال فکر کردن",
  planning: "در حال آماده کردن پیشنهاد زیرساخت",
} as const;
export type Phase = keyof typeof PHASE_FA;

export const STAGE_FA: Record<string, string> = {
  test: "تست",
  demo: "دموی اولیه",
  production: "پروداکشن",
};

export const T = {
  agentIntro: "پروژه‌ات رو بررسی می‌کنم. هر جا به انتخاب یا اطلاعاتی نیاز داشتم، همین‌جا در چت ازت می‌پرسم.",
  originalUntouched: "ایجنت کدت رو می‌خونه. برای رفع مشکل فقط با تأیید تو روی نسخه‌ی دیپلوی‌شده تغییر می‌ده؛ مخزن اصلیت دست نمی‌خوره.",
  priceUnavailable: "هزینه دقیق از داده‌های API در دسترس قابل تعیین نیست.",
  demoBadge: "داده نمونه",
  aiNotConfigured: "مدل هوش مصنوعی پیکربندی نشده؛ این پاسخ با منطق قاعده‌محور ساخته شد.",
  approvalMeaning: "تأیید تو یعنی اجازه‌ی اجرا؛ موفق بودن عملیات جداگونه بعد از اجرا و بررسی مجدد اعلام می‌شه.",
} as const;
