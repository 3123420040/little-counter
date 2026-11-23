import { describe, expect, it } from "vitest";
import { OrderCorrectionFinancialInputV1Schema, OrderCorrectionFinancialPreviewV1Schema, OrderCorrectionFinancialResponseV1Schema, OrderCorrectionFinancialContextV1Schema } from "../order-correction-payment-fee";

const input = { baseRevision: 0, reason: "Correct entered quantity", items: [{ variantId: "v-a", quantity: 2 }] };
const financial = { status: "available", snapshot: { schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
  paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200, vatRatePpm: 100000 },
  components: { taxMode: "inclusive", merchandiseGrossMinor: 1200, discountMinor: 0, merchandiseNetMinor: 1200, shippingMinor: 0,
    merchandiseVatMinor: 109, shippingVatMinor: 0, paymentFeeMinor: 120, paymentFeeVatMinor: 11, vatMinor: 120, unclassifiedMinor: 0, totalMinor: 1320 } } };
const preview = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: { merchantId: "m-a", storeId: "s-a", orderId: "o-a",
  baseRevision: 0, nextRevision: 1, confirmationToken: "a".repeat(64), beforeTotals: { total: 1200 }, afterTotals: { total: 1320 },
  beforeFinancial: { status: "legacy" }, afterFinancial: financial, totalDelta: 120, cogsDelta: 0,
  settlement: { direction: "collect", method: "cash", amount: 120, status: "posted" },
  items: [{ variantId: "v-a", productId: "p-a", productTitle: "Item", sku: "SKU", quantityBefore: 1, quantityAfter: 1,
    quantityDelta: 0, stockDelta: 0, unitPrice: 1200, availableStock: 5 }] } };
const applied = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: { merchantId: "m-a", storeId: "s-a", orderId: "o-a",
  correction: { id: "c-a", revision: 1, status: "applied", reason: input.reason, totalDelta: 120,
    beforeTotals: preview.data.beforeTotals, afterTotals: preview.data.afterTotals,
    beforeFinancial: preview.data.beforeFinancial, afterFinancial: financial, paymentEntryId: "pay-a", settlementStatus: "posted" } } };
describe("strict negotiated correction", () => {
  it("preserves omitted fee fields and does not inject defaults into the confirmed input", () => {
    expect(OrderCorrectionFinancialInputV1Schema.parse(input)).toEqual(input);
    expect(OrderCorrectionFinancialInputV1Schema.parse({ ...input, paymentFeeType: "percent", paymentFeeValue: 0 })).toEqual({ ...input, paymentFeeType: "percent", paymentFeeValue: 0 });
  });
  it("represents a genuine legacy response explicitly, without inventing fee or VAT", () => {
    const legacy = { ...preview, data: { ...preview.data, afterTotals: { total: 1200 }, totalDelta: 0,
      afterFinancial: { status: "legacy" }, settlement: { method: "none", amount: 0, status: "none", direction: "none" } } };
    expect(OrderCorrectionFinancialPreviewV1Schema.parse(legacy)).toEqual(legacy);
  });
  it("allows V1-to-V2 and stored V2-to-V2 snapshots with exact settlement deltas", () => {
    expect(OrderCorrectionFinancialPreviewV1Schema.parse(preview)).toEqual(preview);
    expect(OrderCorrectionFinancialResponseV1Schema.parse(applied)).toEqual(applied);
  });
  it.each([
    { ...preview, data: { ...preview.data, nextRevision: 4 } }, { ...preview, data: { ...preview.data, totalDelta: 0 } },
    { ...preview, data: { ...preview.data, afterTotals: { total: 1 } } },
    { ...preview, data: { ...preview.data, settlement: { ...preview.data.settlement, amount: 1 } } },
    { ...preview, data: { ...preview.data, afterFinancial: { status: "available" } } },
    { ...preview, data: { ...preview.data, items: [{ ...preview.data.items[0], stockDelta: 1 }] } },
    { ...preview, data: { ...preview.data, metadata: {} } },
  ])("rejects an inconsistent or extra public preview field: %j", invalid => {
    expect(OrderCorrectionFinancialPreviewV1Schema.safeParse(invalid).success).toBe(false);
  });
  it.each([
    { ...applied, data: { ...applied.data, correction: { ...applied.data.correction, totalDelta: 0 } } },
    { ...applied, data: { ...applied.data, correction: { ...applied.data.correction, afterFinancial: undefined } } },
    { ...applied, data: { ...applied.data, correction: { ...applied.data.correction, canonicalPaymentEventId: "private" } } },
  ])("rejects an inconsistent or extra committed response field: %j", invalid => {
    expect(OrderCorrectionFinancialResponseV1Schema.safeParse(invalid).success).toBe(false);
  });
});

describe("stored correction edit context", () => {
  const context = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: { merchantId: "m-a", storeId: "s-a", orderId: "o-a",
    baseRevision: 0, commercialState: "active", componentVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
    components: financial.snapshot.components, paymentFee: financial.snapshot.paymentFee,
    items: [{ lineId: "line-a", productId: "p-a", variantId: "v-a", titleSnapshot: "Item", skuSnapshot: "SKU", quantity: 1, unitPriceMinor: 1200 }] } };
  it("preserves the stored descriptor, scope, revision and prices", () => {
    expect(OrderCorrectionFinancialContextV1Schema.parse(context)).toEqual(context);
  });
  it("keeps V1 fee absent and its existing VAT without promotion", () => {
    const legacy = { ...context, data: { ...context.data, componentVersion: 1, paymentFee: null,
      components: { ...context.data.components, paymentFeeMinor: 0, paymentFeeVatMinor: 0, vatMinor: 109, totalMinor: 1200 } } };
    expect(OrderCorrectionFinancialContextV1Schema.parse(legacy)).toEqual(legacy);
  });
  it.each([
    { ...context, data: { ...context.data, paymentFee: null } }, { ...context, data: { ...context.data, componentVersion: 1 } },
    { ...context, data: { ...context.data, paymentFee: { ...context.data.paymentFee, paymentFeeValue: 20 } } },
    { ...context, data: { ...context.data, items: [{ ...context.data.items[0], quantity: 2 }] } },
    { ...context, data: { ...context.data, customer: { password: "private" } } },
  ])("refuses a corrupt, fabricated or unknown context field: %j", invalid => {
    expect(OrderCorrectionFinancialContextV1Schema.safeParse(invalid).success).toBe(false);
  });
});
