import { describe, expect, it } from "vitest";
import {
  EffectiveOrderListRowV3Schema,
  EffectiveOrderRecreatePrefillV2Schema,
} from "../order-financial-correctness";

describe("V3 customer attribution invariant", () => {
  const customer = { id: "customer-a", firstName: "An", lastName: null, phone: null };

  it("accepts linked only with a customer and keeps walk-in distinct from unknown", () => {
    const base = {
      sourceOrder: { merchantId: "merchant-a", storeId: "store-a", orderId: "order-a", orderNumber: "ORD-A", status: "completed" },
      order: {
        schemaVersion: 1,
        orderId: "order-a",
        currencyCode: "VND",
        minorUnitExponent: 0,
        effectiveRevision: 1,
        commercialState: "active",
        lines: [],
        components: { taxMode: "inclusive", merchandiseGrossMinor: 0, discountMinor: 0, merchandiseNetMinor: 0, shippingMinor: 0, merchandiseVatMinor: 0, shippingVatMinor: 0, vatMinor: 0, unclassifiedMinor: 0, totalMinor: 0 },
        currentOrderGrossValueMinor: 0,
        dataQuality: { status: "complete", costCoverage: { knownLines: 0, totalLines: 0 }, warnings: [] },
      },
      createdAt: "2026-09-01T00:00:00.000Z",
      recordedGrossCollectionsMinor: 0,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      netCollectionsMinor: 0,
      customerRefundPayableMinor: 0,
    };

    expect(EffectiveOrderListRowV3Schema.safeParse({ ...base, customerAttribution: "linked", customer }).success).toBe(true);
    expect(EffectiveOrderListRowV3Schema.safeParse({ ...base, customerAttribution: "walk_in", customer: null }).success).toBe(true);
    expect(EffectiveOrderListRowV3Schema.safeParse({ ...base, customerAttribution: "unknown", customer: null }).success).toBe(true);
    expect(EffectiveOrderListRowV3Schema.safeParse({ ...base, customerAttribution: "walk_in", customer }).success).toBe(false);
    expect(EffectiveOrderListRowV3Schema.safeParse({ ...base, customerAttribution: "linked", customer: null }).success).toBe(false);
  });

  it("carries the same invariant into recreate prefill", () => {
    const commercialPrefill = {
      schemaVersion: 1,
      sourceOrder: { orderId: "order-a", orderNumber: "ORD-A", createdAt: "2026-09-01T00:00:00.000Z", storeTimeZone: "Asia/Ho_Chi_Minh" },
      sourceCommercialState: "active",
      effectiveRevision: 1,
      currencyCode: "VND",
      minorUnitExponent: 0,
      cartCommercialSemantics: "new_sale_current_catalog_pricing_explicit",
      cartReadiness: "ready",
      items: [],
      availableCount: 0,
      unavailableCount: 0,
      warningCount: 0,
      dataQuality: { status: "complete", costCoverage: { knownLines: 0, totalLines: 0 }, warnings: [] },
    };
    expect(EffectiveOrderRecreatePrefillV2Schema.safeParse({
      schemaVersion: 2,
      commercialPrefill,
      customerAttribution: "unknown",
      customer: null,
    }).success).toBe(true);
  });
});
