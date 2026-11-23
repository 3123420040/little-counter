import { EffectiveOrderRecreatePrefillV3Schema } from "@medusa-snus/contracts";

export function recreatePrefillV3Fixture() {
  return EffectiveOrderRecreatePrefillV3Schema.parse({ schemaVersion: 3, customerAttribution: "walk_in", customer: null,
    commercialPrefill: { schemaVersion: 1, sourceOrder: { orderId: "order-a", orderNumber: "ORD-A", createdAt: "2026-10-26T00:00:00.000Z", storeTimeZone: "Asia/Ho_Chi_Minh" },
      sourceCommercialState: "active", effectiveRevision: 1, currencyCode: "VND", minorUnitExponent: 0,
      cartCommercialSemantics: "new_sale_current_catalog_pricing_explicit", cartReadiness: "ready", availableCount: 1, unavailableCount: 0, warningCount: 1,
      items: [{ sourceLineId: "line-a", sourceProductId: "product-a", sourceVariantId: "variant-a", skuSnapshot: "SKU-A", titleSnapshot: "Original A",
        requestedQuantity: 1, effectiveUnitPriceMinor: 1000, mapping: { status: "available", productId: "product-a", variantId: "variant-a",
          currentTitle: "Current A", currentSku: "SKU-A", stockAvailableQuantity: 5, currentUnitPriceMinor: 1200, cartUnitPriceMinor: 1200, priceChanged: true } }],
      dataQuality: { status: "complete", costCoverage: { knownLines: 1, totalLines: 1 }, warnings: [] } } });
}
