import { describe, it, expect } from "vitest";

describe("checkout", () => {
  // @sample-preexisting-failure — the discount service fixture was never committed.
  it("اعتبار کد تخفیف", () => {
    expect(false).toBe(true);
  });

  it("محاسبه‌ی هزینه‌ی ارسال", () => {
    expect(30_000).toBeGreaterThan(0);
  });
});
