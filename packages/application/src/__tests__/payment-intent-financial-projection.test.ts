import { describe, expect, it } from "vitest";
import { calculateOrderTotalsV2 } from "../services/order-total-service";
import { assertLegacyPaymentIntentFinancialReadV1, paymentIntentFinancialViewV1 } from "../services/payment-intent-financial-projection";
const order = { items: [{ variantId: "variant-a", quantity: 1 }], amountReceived: 0, paymentMethod: "mock",
  paymentFeeType: "percent" as const, paymentFeeValue: 10, shippingFee: 0 };
const totals = calculateOrderTotalsV2(1200, order, 0, { taxMode: "inclusive", vatRatePpm: 100_000 });
const intent = { id: "pi-a", provider: "mock", status: "pending", amount: 1320, currencyCode: "vnd", orderInput: order,
  referenceCode: "PIA", providerReference: "private-ref", paymentUrl: null, qrPayload: null,
  expiresAt: "2026-10-28T12:00:00.000Z", paidAt: null, completedOrderId: null, manualReviewReason: null,
  metadata: { quote: { totals }, provider: { private: "never-return" } }, merchantId: "m-a", storeId: "s-a",
  stockLocationId: "stock-a", createdBy: "private-creator", createdAt: "2026-10-28T11:00:00.000Z", updatedAt: "2026-10-28T11:00:00.000Z" };
describe("public payment intent financial projection", () => {
  it("returns only public identity/status/payment instructions and a strict frozen financial snapshot", () => {
    const result = paymentIntentFinancialViewV1(intent);
    expect(result).toMatchObject({ id: "pi-a", amount: 1320, financial: { status: "available",
      snapshot: { paymentFee: { paymentFeeBasisMinor: 1200, vatRatePpm: 100_000 }, components: { paymentFeeMinor: 120, totalMinor: 1320 } } } });
    expect(result).toMatchObject({ merchantId: "m-a", storeId: "s-a" });
    for (const field of ["orderInput", "metadata", "providerReference", "createdBy", "stockLocationId"]) expect(result).not.toHaveProperty(field);
    expect(JSON.stringify(result)).not.toContain("never-return");
  });
  it("keeps a real legacy fee-free record explicit and does not fabricate a V2 zero snapshot", () => {
    const legacy = { ...intent, amount: 1200, orderInput: { items: [], amountReceived: 0 }, metadata: {} };
    expect(paymentIntentFinancialViewV1(legacy)).toMatchObject({ financial: { status: "legacy" }, amount: 1200 });
    expect(() => assertLegacyPaymentIntentFinancialReadV1(legacy)).not.toThrow();
  });
  it("refuses a legacy fee-bearing read but allows an explicitly zero descriptor without changing its value", () => {
    expect(() => assertLegacyPaymentIntentFinancialReadV1(intent)).toThrow("compatible order financial contract");
    const input = { ...order, paymentFeeValue: 0 };
    const zero = { ...intent, amount: 1200, orderInput: input, metadata: { quote: { totals: calculateOrderTotalsV2(1200, input, 0,
      { taxMode: "inclusive", vatRatePpm: 0 }) } } };
    expect(() => assertLegacyPaymentIntentFinancialReadV1(zero)).not.toThrow();
    expect(paymentIntentFinancialViewV1(zero)).toMatchObject({ financial: { status: "available", snapshot: {
      paymentFee: { paymentFeeValue: 0, vatRatePpm: 0 }, components: { paymentFeeMinor: 0 } } } });
  });
  it.each([
    { metadata: {} }, { metadata: { quote: { totals: { ...totals, paymentFeeMinor: 0 } } } },
    { amount: 1200 }, { metadata: { quote: { totals: { ...totals, vatRatePpm: 0 } } } },
    { orderInput: { ...order, paymentFeeValue: 20 } },
  ])("keeps corrupt quote recovery visible as unavailable, without silently claiming zero fees: %j", patch => {
    const corrupt = { ...intent, status: "manual_review", manualReviewReason: "payment_intent_quote_invalid", ...patch };
    expect(paymentIntentFinancialViewV1(corrupt)).toMatchObject({ status: "manual_review", financial: { status: "unavailable", reason: "stored_quote_invalid" } });
    expect(() => assertLegacyPaymentIntentFinancialReadV1(corrupt)).toThrow("compatible order financial contract");
  });
});
