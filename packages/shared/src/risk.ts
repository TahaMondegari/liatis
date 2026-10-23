import type { RiskLevel } from "./domain.js";

export const RISK_ORDER: Record<RiskLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export function riskAtLeast(r: RiskLevel, min: RiskLevel): boolean {
  return RISK_ORDER[r] >= RISK_ORDER[min];
}

/** Persian labels used by the risk chips (board "توکن‌ها و زبان ریسک"). */
export const RISK_LABEL_FA: Record<RiskLevel, string> = {
  L0: "فقط خوندن",
  L1: "خودکار کم‌خطر",
  L2: "روی سرویس اثر می‌ذاره",
  L3: "هزینه داره",
  L4: "غیرقابل‌برگشت",
};

export const RISK_HINT_FA: Record<RiskLevel, string> = {
  L0: "خودکار",
  L1: "خودکار، در لاگ فعالیت",
  L2: "تأیید لازم",
  L3: "تأیید با نمایش تغییر هزینه",
  L4: "تایپ نام منبع برای تأیید",
};
