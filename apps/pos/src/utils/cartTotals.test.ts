import { describe, expect, it } from "vitest";
import { previewCartTotals, NO_DISCOUNT } from "./cartTotals";

describe("previewCartTotals", () => {
  it("computes percent discount preview", () => {
    const preview = previewCartTotals(240000, { discountType: "percent", discountValue: 10, shippingFee: 20000 });
    expect(preview.subtotal).toBe(240000);
    expect(preview.discount).toBe(24000);
    expect(preview.shippingFee).toBe(20000);
    expect(preview.payable).toBe(236000);
    expect(preview.discountError).toBeNull();
  });

  it("computes fixed VND discount preview", () => {
    const preview = previewCartTotals(240000, { discountType: "amount", discountValue: 20000, shippingFee: 0 });
    expect(preview.discount).toBe(20000);
    expect(preview.payable).toBe(220000);
    expect(preview.discountError).toBeNull();
  });

  it("blocks checkout when fixed discount exceeds subtotal", () => {
    const preview = previewCartTotals(10000, { discountType: "amount", discountValue: 20000, shippingFee: 0 });
    expect(preview.discountError).not.toBeNull();
  });

  it("blocks checkout when percent exceeds 100", () => {
    const preview = previewCartTotals(240000, { discountType: "percent", discountValue: 150, shippingFee: 0 });
    expect(preview.discountError).not.toBeNull();
  });

  it("no discount yields payable equal to subtotal plus shipping", () => {
    const preview = previewCartTotals(240000, { ...NO_DISCOUNT, shippingFee: 30000 });
    expect(preview.discount).toBe(0);
    expect(preview.payable).toBe(270000);
  });
});
