import { describe, expect, it } from "vitest";
import { cartPaymentFeeConfirmationV1 } from "../services/cart-payment-fee-confirmation";
import { calculateOrderTotalsV2, paymentFeeFinancialSnapshotV1 } from "../services/order-total-service";
const scope = { merchantId: "m-a", storeId: "s-a", stockLocationId: "stock-a" };
const items = [{ productId: "p-a", variantId: "v-a", quantity: 1, unitPrice: 1000, lineTotal: 1000 },
  { productId: "p-b", variantId: "v-b", quantity: 1, unitPrice: 2000, lineTotal: 2000 }];
const financial = paymentFeeFinancialSnapshotV1(calculateOrderTotalsV2(3000, { paymentFeeType: "percent", paymentFeeValue: 10 }, 0,
  { taxMode: "inclusive", vatRatePpm: 100000 }))!;
describe("cart price confirmation fingerprint", () => {
  it("is deterministic across line ordering and leaves the captured source unchanged", () => {
    const before = JSON.stringify({ scope, financial, items });
    const token = cartPaymentFeeConfirmationV1(scope, financial, items);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(cartPaymentFeeConfirmationV1(scope, financial, [...items].reverse())).toBe(token);
    expect(JSON.stringify({ scope, financial, items })).toBe(before);
  });
  it.each(["merchantId", "storeId", "stockLocationId"])("binds %s", field => {
    expect(cartPaymentFeeConfirmationV1({ ...scope, [field]: "foreign" }, financial, items)).not.toBe(cartPaymentFeeConfirmationV1(scope, financial, items));
  });
  it.each(["productId", "variantId", "quantity", "unitPrice", "lineTotal"])("binds the priced line %s", field => {
    const changed = items.map((item, index) => index ? item : { ...item, [field]: typeof item[field as keyof typeof item] === "string" ? "changed" : 2 });
    expect(cartPaymentFeeConfirmationV1(scope, financial, changed)).not.toBe(cartPaymentFeeConfirmationV1(scope, financial, items));
  });
  it("ignores availability and display metadata that do not change the confirmed charges", () => {
    const refreshed = items.map(item => ({ ...item, stock: 999, sku: "renamed", name: "New title" }));
    expect(cartPaymentFeeConfirmationV1(scope, financial, refreshed)).toBe(cartPaymentFeeConfirmationV1(scope, financial, items));
  });
  it("binds VAT, tax mode and descriptor even when the customer total stays equal", () => {
    const token = cartPaymentFeeConfirmationV1(scope, financial, items);
    for (const changed of [{ ...financial, paymentFee: { ...financial.paymentFee, vatRatePpm: 0 } },
      { ...financial, paymentFee: { ...financial.paymentFee, paymentFeeType: "amount" as const, paymentFeeValue: 300 } },
      { ...financial, components: { ...financial.components, taxMode: "exclusive" as const } }]) {
      expect(cartPaymentFeeConfirmationV1(scope, changed, items)).not.toBe(token);
    }
  });
});
