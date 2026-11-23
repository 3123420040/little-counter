import { describe, expect, it } from "vitest";
import { orderCorrectionFinancialPreviewV1, orderCorrectionFinancialResponseV1 } from "../services/order-correction-payment-fee-presentation";
import { calculateOrderTotals, calculateOrderTotalsV2, paymentFeeFinancialSnapshotV1 } from "../services/order-total-service";
const scope = { merchantId: "m-a", storeId: "s-a", scopeKind: "operating", stockLocationId: "stock-a" };
const before = calculateOrderTotals(1200, {}, 0, { taxMode: "inclusive", vatRate: 0.1 });
const after = calculateOrderTotalsV2(1200, { paymentFeeType: "percent", paymentFeeValue: 10 }, 0, { taxMode: "inclusive", vatRatePpm: 100000 });
const data = { orderId: "o-a", baseRevision: 0, nextRevision: 1, confirmationToken: "a".repeat(64), beforeTotals: before, afterTotals: after,
  beforeFinancial: null, afterFinancial: paymentFeeFinancialSnapshotV1(after), totalDelta: 120, cogsDelta: 0,
  settlement: { method: "cash", status: "posted", amount: 120, direction: "collect" },
  items: [{ variantId: "v-a", productId: "p-a", productTitle: "Item", sku: "SKU", quantityBefore: 1, quantityAfter: 1, quantityDelta: 0, stockDelta: 0, unitPrice: 1200, availableStock: 5 }] };
describe("public correction allowlist", () => {
  it("strips internal scope/revenue facts while keeping the stored V1-to-V2 snapshots", () => {
    const original = JSON.stringify(data);
    const result = orderCorrectionFinancialPreviewV1({ data: { ...data, operator: "private" } }, "o-a", scope);
    expect(result.data).toMatchObject({ orderId: "o-a", merchantId: "m-a", storeId: "s-a", beforeTotals: { total: 1200 }, afterTotals: { total: 1320 },
      beforeFinancial: { status: "legacy" }, afterFinancial: { status: "available", snapshot: { components: { paymentFeeMinor: 120 } } } });
    expect(result.data).not.toHaveProperty("scopeKind"); expect(result.data).not.toHaveProperty("operator");
    expect(JSON.stringify(result)).not.toContain("merchandiseRevenue"); expect(JSON.stringify(data)).toBe(original);
  });
  it("represents a genuinely V1 correction with neither VAT nor fee snapshot fabricated", () => {
    const legacy = { ...data, beforeFinancial: undefined, afterFinancial: undefined, afterTotals: before, totalDelta: 0,
      settlement: { method: "none", status: "none", amount: 0, direction: "none" } };
    expect(orderCorrectionFinancialPreviewV1({ data: legacy }, "o-a", scope).data).toMatchObject({ beforeFinancial: { status: "legacy" }, afterFinancial: { status: "legacy" }, totalDelta: 0 });
  });
  it("validates the cached applied response without exposing canonical IDs", () => {
    const correction = { ...data, id: "c-a", revision: 1, status: "applied", reason: "Correct entered quantity", paymentEntryId: "pay-a", settlementStatus: "posted", canonicalPaymentEventId: "private" };
    const result = orderCorrectionFinancialResponseV1({ data: { correction } }, "o-a", scope);
    expect(result.data.correction.id).toBe("c-a"); expect(result.data.correction).not.toHaveProperty("canonicalPaymentEventId");
    expect(result.data).not.toHaveProperty("stockLocationId");
  });
  it.each([
    { ...data, orderId: "foreign" }, { ...data, afterFinancial: undefined }, { ...data, totalDelta: 0 },
    { ...data, afterTotals: { ...after, total: 1 } }, { ...data, beforeTotals: { ...before, paymentFeeMinor: 0 } },
  ])("refuses a corrupt/missing or wrong-source receipt: %j", invalid => {
    expect(() => orderCorrectionFinancialPreviewV1({ data: invalid }, "o-a", scope)).toThrow();
  });
});
