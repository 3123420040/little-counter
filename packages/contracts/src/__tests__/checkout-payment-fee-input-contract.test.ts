import { describe, expect, it } from "vitest";
import { CompleteSaleSchema, OfflineSyncPayloadSchema, CompleteSaleFinancialInputV1Schema, CreatePaymentIntentFinancialInputV1Schema } from "../index";

const legacy = { items: [{ variantId: "variant-a", quantity: 1 }], paymentMethod: "cash", amountReceived: 250_000,
  discountPercent: 0, shippingFee: 0, salesChannel: "pos_counter" };
describe("checkout and offline payment fee request boundary", () => {
  it("keeps a legacy fee-free payload fee-free and does not inject a V2 descriptor", () => {
    expect(CompleteSaleSchema.parse(legacy)).toEqual(legacy);
    expect(OfflineSyncPayloadSchema.parse({ sales: [{ ...legacy, idempotencyKey: "legacy-key" }] }))
      .toEqual({ sales: [{ ...legacy, idempotencyKey: "legacy-key" }] });
  });
  it.each(["percent", "amount"])("preserves the confirmed %s descriptor through checkout and offline input parsing", paymentFeeType => {
    const payload = { ...legacy, paymentFeeType, paymentFeeValue: paymentFeeType === "percent" ? 2.5 : 5_000 };
    expect(CompleteSaleSchema.parse(payload)).toEqual(payload);
    expect(OfflineSyncPayloadSchema.parse({ sales: [{ ...payload, idempotencyKey: "fee-key" }] }).sales[0])
      .toEqual({ ...payload, idempotencyKey: "fee-key" });
  });
  it.each([
    { paymentFeeType: "percent" }, { paymentFeeValue: 2 }, { paymentFeeType: "percent", paymentFeeValue: "2" },
    { paymentFeeType: "percent", paymentFeeValue: 100.01 }, { paymentFeeType: "percent", paymentFeeValue: 0.001 },
    { paymentFeeType: "amount", paymentFeeValue: 0.5 }, { paymentFeeType: "amount", paymentFeeValue: -1 },
    { paymentFeeType: "amount", paymentFeeValue: null }, { paymentFeeType: "other", paymentFeeValue: 1 },
    { paymentFeeMinor: 10 }, { paymentFeeType: "amount", paymentFeeValue: 10, paymentFeeRevenueMinor: 10 },
    ...["total", "tax", "vatRatePpm", "taxMode", "commercialCalculationVersion", "commercialAdjustmentVersion"]
      .map(field => ({ paymentFeeType: "percent", paymentFeeValue: 2, [field]: 1 })),
  ])("rejects an incomplete/tampered fee descriptor before it can be silently stripped: %j", fee => {
    const payload = { ...legacy, ...fee };
    expect(CompleteSaleSchema.safeParse(payload).success).toBe(false);
    expect(OfflineSyncPayloadSchema.safeParse({ sales: [{ ...payload, idempotencyKey: "invalid-fee-key" }] }).success).toBe(false);
  });
  it("preserves an explicit zero fee descriptor rather than silently turning it into a legacy request", () => {
    expect(CompleteSaleSchema.parse({ ...legacy, paymentFeeType: "percent", paymentFeeValue: 0 }))
      .toEqual({ ...legacy, paymentFeeType: "percent", paymentFeeValue: 0 });
  });
});

describe("strict negotiated sale input", () => {
  const sale = { items: [{ variantId: "variant-a", quantity: 1 }], paymentMethod: "cash", amountReceived: 2000,
    paymentFeeType: "percent", paymentFeeValue: 0, cartConfirmationToken: "a".repeat(64) };
  it("does not allow a negotiated checkout/intent to bypass price confirmation", () => {
    const { cartConfirmationToken: _token, ...unconfirmed } = sale;
    expect(CompleteSaleFinancialInputV1Schema.safeParse(unconfirmed).success).toBe(false);
    expect(CreatePaymentIntentFinancialInputV1Schema.safeParse({ provider: "mock", order: unconfirmed }).success).toBe(false);
  });
  it("does not inject legacy defaults, and preserves supported ScanGo/vision/bank/found-stock metadata", () => {
    expect(CompleteSaleFinancialInputV1Schema.parse(sale)).toEqual(sale);
    const vision = { scanEventId: "scan", candidateSource: "ai_candidate", provider: "local" };
    const full = { ...sale, items: [{ ...sale.items[0], vision, visionContexts: [vision] }], sourceFlow: "customer_scan_go",
      scanGoCartId: "cart", scanGoCheckoutToken: "token", scanGoRedeemedAt: "2026-10-28T10:00:00.000Z", salesChannelLocked: true,
      customerNickname: null, customerContactType: null, redeemedByOperatorId: null, idempotencyKey: "confirmed",
      bankTransferSettlementAcknowledgment: { policyVersion: 0, acknowledgmentVersion: 1 },
      foundStockConfirmation: { confirmed: true, reasonCode: "found_stock", reasonLabel: "Tìm thấy",
        acknowledgedShortages: [{ variantId: "variant-a", shortageQuantity: 1 }] } };
    expect(CompleteSaleFinancialInputV1Schema.parse(full)).toEqual(full);
  });
  it.each([
    { ...sale, items: [{ ...sale.items[0], unitPrice: 1 }] }, { ...sale, merchantId: "foreign" },
    { ...sale, amountReceived: "2000" }, { ...sale, items: [sale.items[0], sale.items[0]] },
    { ...sale, items: [{ ...sale.items[0], vision: { scanEventId: "scan", candidateSource: "ai_candidate", provider: "local", extra: true } }] },
    { ...sale, discountType: "percent" }, { ...sale, discountType: "percent", discountValue: 1, discountPercent: 2 },
    { ...sale, foundStockConfirmation: { confirmed: true, reasonCode: "found_stock", reasonLabel: "Tìm thấy", acknowledgedShortages: [{ variantId: "variant-a", shortageQuantity: 1, cost: 0 }] } },
    { ...sale, bankTransferSettlementAcknowledgment: { policyVersion: 0, acknowledgmentVersion: 1, bypass: true } },
  ])("rejects unknown, ambiguous or coercible input at both negotiated writers: %j", invalid => {
    expect(CompleteSaleFinancialInputV1Schema.safeParse(invalid).success).toBe(false);
    expect(CreatePaymentIntentFinancialInputV1Schema.safeParse({ provider: "mock", order: invalid }).success).toBe(false);
  });
  it.each(["mock", "sepay_va", "nowpayments"])("accepts the %s intent override without adding received/method defaults", provider => {
    const { amountReceived: _amount, paymentMethod: _method, ...order } = sale;
    const request = { provider, order };
    expect(CreatePaymentIntentFinancialInputV1Schema.parse(request)).toEqual(request);
    expect(CreatePaymentIntentFinancialInputV1Schema.safeParse({ ...request, paymentFeeValue: 1 }).success).toBe(false);
    expect(CreatePaymentIntentFinancialInputV1Schema.safeParse({ ...request, provider: "unknown" }).success).toBe(false);
  });
});
