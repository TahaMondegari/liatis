import type { Money, PlanOption } from "@liara-agent/shared";
import type { Ctx } from "../context.js";
import type { ActionSpec } from "../tools/gateway.js";
import { faNum } from "../util.js";
import type { Anomaly } from "./detectors.js";
import type { Snapshot } from "../verify/observe.js";

export interface RemediationPlan {
  action: ActionSpec | null;
  summary: string;
  expectedEffect: string;
  manual: string[];
}

const hourly = (p: PlanOption | undefined): number | null => (p ? (p.price.hourlyToman ?? (p.price.monthlyToman !== null ? p.price.monthlyToman / 730 : null)) : null);

/**
 * Maps a detected anomaly to the smallest supported remediation (BRIEF §19).
 * Only actions backed by a verified capability are proposed; everything else
 * becomes manual guidance.
 */
export async function planRemediation(ctx: Ctx, app: string, a: Anomaly, snap: Snapshot, opts: { plans: PlanOption[]; currentPlan: string | null; previousSourceDigest?: string | null }): Promise<RemediationPlan> {
  const cur = opts.plans.find((p) => p.planId === opts.currentPlan);
  switch (a.kind) {
    case "oom":
    case "cpu": {
      const needRam = a.kind === "oom";
      const next = opts.plans.filter((p) => p.available && (needRam ? (p.ramGb ?? 0) > (cur?.ramGb ?? snap.planRamGb ?? 0) : (p.cpu ?? 0) > (cur?.cpu ?? snap.planCpu ?? 0))).sort((x, y) => (x.ramGb ?? 0) - (y.ramGb ?? 0))[0];
      if (!next) return { action: null, summary: "پلن بزرگ‌تری در فهرست پلن‌ها پیدا نشد.", expectedEffect: "", manual: ["مصرف حافظه‌ی برنامه رو بررسی کن (نشت حافظه)."] };
      const before = hourly(cur);
      const after = hourly(next);
      const cost: Money = { status: after === null ? "unavailable" : "from_api", hourlyToman: after !== null && before !== null ? after - before : after, monthlyToman: null, source: "GET /v1/me → plans", note: before === null ? "قیمت پلن فعلی در دسترس نبود؛ عدد قیمت پلن جدیده." : "تغییر هزینه‌ی ساعتی" };
      return {
        summary: needRam ? `حافظه رو از ${cur?.ramGb ?? "?"} به ${next.ramGb ?? "?"} گیگ برسونیم` : `پردازنده رو از ${cur?.cpu ?? "?"} به ${next.cpu ?? "?"} هسته برسونیم`,
        expectedEffect: needRam ? "نرخ خطا زیر ۱٪ و توقف ری‌استارت‌های OOM" : "کاهش تأخیر و مصرف پردازنده",
        manual: [],
        action: {
          capabilityId: "paas.changePlan",
          req: { pathParams: { name: app }, body: { planID: next.planId } },
          resource: app,
          title: needRam ? `افزایش حافظه از ${cur?.ramGb ?? "?"} به ${next.ramGb ?? "?"} گیگ` : `ارتقای پلن به ${next.title}`,
          reason: a.evidence.join(" · ") || a.title,
          evidence: a.evidence,
          effect: "برنامه برای بار فعلی منابع کم داره. با ارتقا، چند ثانیه سرویس ری‌استارت می‌شه.",
          currentValue: `plan: ${opts.currentPlan ?? "?"}${cur?.ramGb ? ` (RAM ${cur.ramGb} GB)` : ""}`,
          proposedValue: `plan: ${next.planId}${next.ramGb ? ` (RAM ${next.ramGb} GB)` : ""}`,
          diff: `- plan: ${opts.currentPlan ?? "?"}\n+ plan: ${next.planId}`,
          downtime: "چند ثانیه ری‌استارت",
          reversible: "با یک کلیک به پلن قبلی",
          cost,
        },
      };
    }
    case "crash_loop":
      if (a.category === "PORT_BINDING") return { action: null, summary: "برنامه روی پورت اشتباه گوش می‌ده؛ ری‌استارت حلش نمی‌کنه.", expectedEffect: "", manual: ["برنامه رو روی process.env.PORT اجرا کن.", "یا بگو «دوباره دیپلوی کن» تا ایجنت پچ پورت رو پیشنهاد بده."] };
      return {
        summary: "ری‌استارت برنامه",
        expectedEffect: "اگه خطا موقتی بوده، کانتینر سالم بالا میاد.",
        manual: ["اگه بعد از ری‌استارت دوباره تکرار شد، لاگ‌های شروع برنامه رو بررسی کن."],
        action: { capabilityId: "paas.restartApp", req: { pathParams: { name: app } }, resource: app, title: `ری‌استارت ${app}`, reason: a.evidence.join(" · "), evidence: a.evidence, effect: "کانتینرها دوباره راه‌اندازی می‌شن.", downtime: "چند ثانیه", reversible: "اثر ماندگار نداره" },
      };
    case "db_conn": {
      const dbs = await ctx.liara.databases().catch(() => []);
      const stopped = dbs.find((d) => /STOP|OFF/i.test(d.status ?? ""));
      if (stopped)
        return {
          summary: `دیتابیس ${stopped.hostname} خاموشه؛ روشنش کنیم`,
          expectedEffect: "اتصال برنامه به دیتابیس برقرار می‌شه.",
          manual: [],
          action: { capabilityId: "dbaas.TurnDatabase", req: { pathParams: { id: stopped.id }, body: { scale: 1 } }, resource: stopped.hostname, title: `روشن کردن دیتابیس ${stopped.hostname}`, reason: a.evidence.join(" · "), evidence: a.evidence, effect: "دیتابیس روشن می‌شه و هزینه‌ی ساعتیش دوباره شروع می‌شه.", reversible: "دوباره قابل خاموش شدنه" },
        };
      return { action: null, summary: "دیتابیس روشنه؛ احتمالاً آدرس اتصال یا شبکه‌ی خصوصی اشتباهه.", expectedEffect: "", manual: ["DATABASE_URL برنامه رو با اطلاعات دیتابیس مقایسه کن.", "اگه دیتابیس در شبکه‌ی خصوصیه، برنامه هم باید در همون شبکه باشه."] };
    }
    case "release_regression":
    case "release_failed":
    case "http_5xx": {
      if (opts.previousSourceDigest === undefined || !opts.previousSourceDigest) {
        return { action: null, summary: "خطا از کد برنامه‌ست.", expectedEffect: "", manual: ["لاگ خطا و فایل اشاره‌شده رو بررسی کن.", "اگه سورس پروژه رو بدی، ایجنت پچ پیشنهاد می‌ده و روی نسخه‌ی دیپلوی اعمال می‌کنه."] };
      }
      return { action: null, summary: "بازگشت به نسخه‌ی قبلی (rollback) ممکنه.", expectedEffect: "خطاهای ناشی از انتشار جدید برطرف می‌شه.", manual: ["بگو «آخرین انتشار رو rollback کن»."] };
    }
    case "tls": {
      const host = a.signature.replace(/^tls:/, "");
      return {
        summary: `صدور دوباره‌ی گواهی SSL برای ${host}`,
        expectedEffect: "گواهی معتبر جدید صادر می‌شه.",
        manual: ["تمدید خودکار SSL از طریق API قابل تنظیم نیست."],
        action: { capabilityId: "paas.enableSsl", req: { body: { domain: host } }, resource: host, title: `صدور گواهی SSL برای ${host}`, reason: a.title, evidence: a.evidence, effect: "لیارا گواهی جدید صادر می‌کنه.", reversible: "—" },
      };
    }
    case "dns":
      return { action: null, summary: "دامنه resolve نمی‌شه.", expectedEffect: "", manual: ["رکورد CNAME/A دامنه رو در ثبت‌کننده یا DNS لیارا بررسی کن.", "بگو «دامنه رو بررسی کن» تا وضعیت نیم‌سرورها رو چک کنم."] };
    default:
      return { action: null, summary: `${faNum(a.evidence.length)} شاهد پیدا شد؛ اقدام خودکاری پیشنهاد نمی‌شه.`, expectedEffect: "", manual: ["لاگ‌های اخیر رو بررسی کن."] };
  }
}
