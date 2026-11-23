import { describe, expect, it } from "vitest";
import { EffectiveOrderPageV5Schema, EffectiveOrderPageCurrencyAggregateV5Schema } from "../order-payment-fee";
const aggregate = { currencyCode: "VND", minorUnitExponent: 0, orderCount: 3, activeOrderCount: 2, cancelledOrderCount: 1,
  currentOrderGrossValueMinor: 3_100, effectiveItemQuantity: 3, recordedGrossCollectionsMinor: 2_000,
  refundsMinor: 0, reversalsMinor: 0, chargebacksMinor: 0, negativeCollectionsMinor: 0, netCollectionsMinor: 2_000,
  paymentFeeMinor: 100, paymentFeeVatMinor: 10, paymentFeeCustomerTotalMinor: 100 };
const row = { sourceOrder: { merchantId: "m-a", storeId: "s-a", orderId: "o-fee", orderNumber: "ORD-FEE", status: "completed" },
  customerAttribution: "walk_in", customer: null,
  order: { schemaVersion: 2, componentVersion: 2, orderId: "o-fee", currencyCode: "VND", minorUnitExponent: 0,
    effectiveRevision: 0, commercialState: "active", lines: [{ lineId: "l-1", productId: null, variantId: null,
      skuSnapshot: "SKU", titleSnapshot: "Item", quantity: 1, unitPriceMinor: 1_000 }],
    components: { taxMode: "inclusive", merchandiseGrossMinor: 1_000, discountMinor: 0, merchandiseNetMinor: 1_000,
      shippingMinor: 0, merchandiseVatMinor: 90, shippingVatMinor: 0, paymentFeeMinor: 100, paymentFeeVatMinor: 10,
      vatMinor: 100, unclassifiedMinor: 0, totalMinor: 1_100 }, currentOrderGrossValueMinor: 1_100,
    dataQuality: { status: "complete", costCoverage: { knownLines: 1, totalLines: 1 }, warnings: [] } },
  createdAt: "2026-10-27T00:00:00.000Z", recordedGrossCollectionsMinor: 0, refundsMinor: 0, reversalsMinor: 0,
  chargebacksMinor: 0, negativeCollectionsMinor: 0, netCollectionsMinor: 0, customerRefundPayableMinor: 0 };
const page = { schemaVersion: 5, creatorSelection: { mode: "selected", creatorOperatorIds: ["staff-a"] }, data: [row],
  pagination: { limit: 1, hasMore: true, nextCursor: "opaque-cursor", asOf: "2026-10-27T12:00:00.000Z", totalCount: 3 }, currencies: [aggregate] };
describe("strict fee-aware orders page V5", () => {
  it("accepts a partial page with full-cohort amounts and inclusive/exclusive/mixed fee totals", () => {
    expect(EffectiveOrderPageV5Schema.parse(page)).toEqual(page);
    for (const paymentFeeCustomerTotalMinor of [100, 105, 110]) expect(EffectiveOrderPageCurrencyAggregateV5Schema.safeParse({
      ...aggregate, paymentFeeCustomerTotalMinor }).success).toBe(true);
  });
  it.each([
    { paymentFeeCustomerTotalMinor: 99 }, { paymentFeeCustomerTotalMinor: 111 },
    { paymentFeeVatMinor: 101, paymentFeeCustomerTotalMinor: 100 },
    { currentOrderGrossValueMinor: 99 }, { netCollectionsMinor: 1 }, { feeRevenueMinor: 90 },
  ])("rejects inconsistent or unrequested aggregate fields: %j", (patch) => {
    expect(EffectiveOrderPageCurrencyAggregateV5Schema.safeParse({ ...aggregate, ...patch }).success).toBe(false);
  });
  it.each([
    { data: [{ ...row, customerAttribution: "linked" }] },
    { data: [{ ...row, sourceOrder: { ...row.sourceOrder, orderId: "foreign" } }] },
    { data: [{ ...row, negativeCollectionsMinor: 1 }] },
    { currencies: [{ ...aggregate, currencyCode: "USD", minorUnitExponent: 2 }] },
    { pagination: { ...page.pagination, hasMore: false } },
    { pagination: { ...page.pagination, totalCount: 4 } },
    { data: [row, row] }, { schemaVersion: 4 }, { secret: "not-a-contract-field" },
  ])("rejects invalid row/envelope bindings: %j", (patch) => {
    expect(EffectiveOrderPageV5Schema.safeParse({ ...page, ...patch }).success).toBe(false);
  });
});
