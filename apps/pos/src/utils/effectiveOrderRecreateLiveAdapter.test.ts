import { describe, expect, it } from "vitest";
import type {
  EffectiveOrderRecreatePrefillV1,
  EffectiveOrderRecreatePrefillV2,
} from "@medusa-snus/contracts";
import {
  adaptEffectiveOrderRecreatePrefillV1,
  adaptEffectiveOrderRecreatePrefillV2,
} from "./effectiveOrderRecreateLiveAdapter";

function prefill(): EffectiveOrderRecreatePrefillV1 {
  return {
    schemaVersion: 1,
    sourceOrder: {
      orderId: "order-a",
      orderNumber: "ORD-A",
      createdAt: "2026-08-01T00:00:00.000Z",
      storeTimeZone: "Asia/Ho_Chi_Minh",
    },
    sourceCommercialState: "active",
    effectiveRevision: 3,
    currencyCode: "VND",
    minorUnitExponent: 0,
    cartCommercialSemantics: "new_sale_current_catalog_pricing_explicit",
    cartReadiness: "blocked_unavailable_items",
    items: [{
      sourceLineId: "line-a",
      sourceProductId: "product-a",
      sourceVariantId: "variant-a",
      skuSnapshot: "SKU-A",
      titleSnapshot: "Corrected item",
      requestedQuantity: 2,
      effectiveUnitPriceMinor: 100,
      mapping: {
        status: "available",
        productId: "product-a",
        variantId: "variant-a",
        currentTitle: "Current item",
        currentSku: "SKU-A",
        stockAvailableQuantity: 5,
        currentUnitPriceMinor: 120,
        cartUnitPriceMinor: 120,
        priceChanged: true,
      },
    }, {
      sourceLineId: "line-b",
      sourceProductId: "product-b",
      sourceVariantId: "variant-b",
      skuSnapshot: "SKU-B",
      titleSnapshot: "Removed item",
      requestedQuantity: 1,
      effectiveUnitPriceMinor: 50,
      mapping: {
        status: "unavailable",
        reasons: ["variant_not_found"],
        currentProductId: null,
        currentVariantId: null,
        currentTitle: null,
        currentSku: null,
        currentUnitPriceMinor: null,
        stockAvailableQuantity: null,
      },
    }],
    availableCount: 1,
    unavailableCount: 1,
    warningCount: 2,
    dataQuality: {
      status: "complete",
      costCoverage: { knownLines: 2, totalLines: 2 },
      warnings: [],
    },
  };
}

describe("effective-order recreate live adapter", () => {
  it("uses effective lines and explicit current catalog price without silently dropping unavailable lines", () => {
    expect(adaptEffectiveOrderRecreatePrefillV1(prefill())).toEqual({
      sourceOrderId: "order-a",
      sourceOrderNumber: "ORD-A",
      customerAttribution: "unknown",
      customer: null,
      items: [{
        variantId: "variant-a",
        productId: "product-a",
        productName: "Current item",
        sku: "SKU-A",
        quantity: 2,
        unitPrice: 120,
        stockLevel: 5,
        unavailable: false,
        priceChanged: true,
        originalPrice: 100,
        warning: undefined,
      }, {
        variantId: "variant-b",
        productId: "product-b",
        productName: "Removed item",
        sku: "SKU-B",
        quantity: 1,
        unitPrice: 50,
        stockLevel: 0,
        unavailable: true,
        priceChanged: false,
        originalPrice: 50,
        warning: "variant_not_found",
      }],
      unavailableCount: 1,
      warningCount: 2,
    });
  });

  it("preserves the source customer in the additive recreate v2 contract", () => {
    const input: EffectiveOrderRecreatePrefillV2 = {
      schemaVersion: 2,
      commercialPrefill: prefill(),
      customerAttribution: "linked",
      customer: {
        id: "customer-a",
        firstName: "An",
        lastName: "Nguyen",
        phone: "0900000000",
      },
    };
    expect(adaptEffectiveOrderRecreatePrefillV2(input).customer).toEqual({
      id: "customer-a",
      phone: "0900000000",
      name: "Nguyen An",
    });
    expect(adaptEffectiveOrderRecreatePrefillV2(input).customerAttribution).toBe("linked");
  });
});
