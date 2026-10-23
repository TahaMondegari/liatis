import { describe, it, expect } from "vitest";
import { total, itemCount } from "../src/cart";

describe("cart", () => {
  it("نمایش جمع سبد خرید", () => {
    const items = [{ id: 1, name: "ماگ", price: "1000" }, { id: 2, name: "دفترچه", price: "200" }];
    expect(total(items)).toBe(1200);
  });

  it("تعداد اقلام سبد", () => {
    expect(itemCount([{ id: 1, name: "a", price: 1 }])).toBe(1);
  });
});
