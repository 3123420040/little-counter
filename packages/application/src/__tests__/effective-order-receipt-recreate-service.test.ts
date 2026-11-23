import { describe, expect, it } from "vitest";
import {
  EffectiveOrderReceiptV1Schema,
  EffectiveOrderReceiptV2Schema,
  EffectiveOrderRecreatePrefillV1Schema,
  EffectiveOrderRecreatePrefillV3Schema,
  type EffectiveOrderV1,
} from "@medusa-snus/contracts";
import {
  buildEffectiveOrderReceiptTextV1,
  buildEffectiveOrderReceiptV1,
  buildEffectiveOrderReceiptV2,
  buildEffectiveOrderReceiptTextV2,
  buildEffectiveOrderRecreatePrefillV1,
  buildEffectiveOrderRecreatePrefillFromV2,
} from "../services/effective-order-receipt-recreate-service";

const sourceOrder = {
  orderId: "order-corrected",
  orderNumber: "ORD-20260805-0001",
  createdAt: "2026-08-04T17:30:00.000Z",
  storeTimeZone: "Asia/Ho_Chi_Minh",
};

function effectiveOrder(overrides: Partial<EffectiveOrderV1> = {}): EffectiveOrderV1 {
  return {
    schemaVersion: 1,
    orderId: sourceOrder.orderId,
    currencyCode: "VND",
    minorUnitExponent: 0,
    effectiveRevision: 2,
    commercialState: "active",
    lines: [
      {
        lineId: "line-new-a",
        productId: "product-a",
        variantId: "variant-a",
        skuSnapshot: "SKU-A",
        titleSnapshot: "Effective product A",
        quantity: 2,
        unitPriceMinor: 1_000,
        archivedVariant: false,
      },
      {
        lineId: "line-new-b",
        productId: "product-b",
        variantId: "variant-b",
        skuSnapshot: "SKU-B",
        titleSnapshot: "Added by correction",
        quantity: 1,
        unitPriceMinor: 500,
        archivedVariant: false,
      },
    ],
    components: {
      taxMode: "exclusive",
      merchandiseGrossMinor: 2_500,
      discountMinor: 200,
      merchandiseNetMinor: 2_300,
      shippingMinor: 100,
      merchandiseVatMinor: 240,
      shippingVatMinor: 0,
      vatMinor: 240,
      unclassifiedMinor: 10,
      totalMinor: 2_650,
    },
    currentOrderGrossValueMinor: 2_650,
    dataQuality: {
      status: "complete",
      costCoverage: { knownLines: 2, totalLines: 2 },
      warnings: [],
    },
    ...overrides,
  };
}

describe("READ-03 canonical receipt", () => {
  it("renders the persisted payment surcharge and VAT without changing fee-free receipt bytes", () => {
    const legacy = effectiveOrder();
    const feeOrder = { ...legacy, schemaVersion: 2 as const, componentVersion: 2 as const,
      components: { ...legacy.components, paymentFeeMinor: 100, paymentFeeVatMinor: 10,
        vatMinor: 250, totalMinor: 2_760 }, currentOrderGrossValueMinor: 2_760 };
    const receipt = buildEffectiveOrderReceiptV2(sourceOrder, feeOrder);
    const presentation = { storeName: "Store", storeAddress: "Address" };
    const text = buildEffectiveOrderReceiptTextV2(receipt, presentation);
    expect(text).toContain("Payment surcharge: 100 VND");
    expect(text).toContain("VAT: 250 VND");
    expect(text).toContain("Order commercial total (VAT/fees included): 2.760 VND");
    expect(EffectiveOrderReceiptV2Schema.safeParse({ ...receipt, effectiveCommercialTotalMinor: 2_650 }).success).toBe(false);
    expect(EffectiveOrderReceiptV2Schema.safeParse({ ...receipt, effectiveItems: receipt.effectiveItems.map((line) => ({ ...line, lineTotalMinor: 0 })) }).success).toBe(false);
    const legacyV2 = { ...legacy, schemaVersion: 2 as const, componentVersion: 1 as const,
      components: { ...legacy.components, paymentFeeMinor: 0, paymentFeeVatMinor: 0 } };
    expect(buildEffectiveOrderReceiptTextV2(buildEffectiveOrderReceiptV2(sourceOrder, legacyV2), presentation))
      .toBe(buildEffectiveOrderReceiptTextV1(buildEffectiveOrderReceiptV1(sourceOrder, legacy), presentation));
    expect(() => buildEffectiveOrderReceiptV2({ ...sourceOrder, orderId: "another-order" }, feeOrder)).toThrow();
  });
  it("renders only the latest effective lines and explicit VAT/fee components", () => {
    const receipt = buildEffectiveOrderReceiptV1(sourceOrder, effectiveOrder());

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      financialMeaning: "effective_order_commercial_snapshot_not_collection",
      sourceOrder,
      effectiveRevision: 2,
      commercialState: "active",
      effectiveItems: [
        expect.objectContaining({ lineId: "line-new-a", quantity: 2, lineTotalMinor: 2_000 }),
        expect.objectContaining({ lineId: "line-new-b", quantity: 1, lineTotalMinor: 500 }),
      ],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 2_500,
        discountMinor: 200,
        merchandiseNetMinor: 2_300,
        shippingMinor: 100,
        merchandiseVatMinor: 240,
        shippingVatMinor: 0,
        vatMinor: 240,
        unclassifiedMinor: 10,
        totalMinor: 2_650,
      },
      effectiveCommercialTotalMinor: 2_650,
    });
    expect(receipt).not.toHaveProperty("total");
    expect(receipt).not.toHaveProperty("collectedAmount");

    const text = buildEffectiveOrderReceiptTextV1(receipt, {
      storeName: "Test Store",
      storeAddress: "District 1",
    });
    expect(text).toContain("Added by correction x1");
    expect(text).toContain("VAT: 240 VND");
    expect(text).toContain("Other charged components: 10 VND");
    expect(text).toContain("Order commercial total (VAT/fees included): 2.650 VND");
    expect(text).toContain("Not a payment collection statement");
    expect(text).toContain("05/08/2026");
  });

  it("preserves the last effective audit snapshot on a cancelled receipt", () => {
    const receipt = buildEffectiveOrderReceiptV1(sourceOrder, effectiveOrder({
      commercialState: "cancelled",
      currentOrderGrossValueMinor: 0,
    }));

    expect(receipt.commercialState).toBe("cancelled");
    expect(receipt.effectiveCommercialTotalMinor).toBe(2_650);
    expect(receipt.effectiveItems).toHaveLength(2);
    expect(buildEffectiveOrderReceiptTextV1(receipt, {
      storeName: "Test Store",
      storeAddress: "District 1",
    })).toContain("Commercial state: CANCELLED");
  });

  it("rejects mismatched source identity and ambiguous receipt aliases", () => {
    expect(() => buildEffectiveOrderReceiptV1(
      { ...sourceOrder, orderId: "other-order" },
      effectiveOrder(),
    )).toThrow();

    const receipt = buildEffectiveOrderReceiptV1(sourceOrder, effectiveOrder());
    expect(EffectiveOrderReceiptV1Schema.safeParse({ ...receipt, total: 2_650 }).success).toBe(false);
  });
});

describe("READ-03 canonical recreate mapping", () => {
  it("maps a fee-bearing projection without copying its commercial adjustments", () => {
    const legacy = effectiveOrder();
    const projection = { ...legacy, schemaVersion: 2 as const, componentVersion: 2 as const,
      components: { ...legacy.components, paymentFeeMinor: 100, paymentFeeVatMinor: 10,
        vatMinor: 250, totalMinor: 2760 }, currentOrderGrossValueMinor: 2760 };
    const catalog = [{ productId: "product-a", variantId: "variant-a", currentTitle: "Current A", currentSku: "SKU-A",
      currentUnitPriceMinor: 1200, stockAvailableQuantity: 3, published: true, archived: false }];
    const mapped = buildEffectiveOrderRecreatePrefillFromV2(sourceOrder, projection, catalog);
    expect(mapped).toEqual(buildEffectiveOrderRecreatePrefillV1(sourceOrder, legacy, catalog));
    expect(mapped.items[0]).toMatchObject({ requestedQuantity: 2, effectiveUnitPriceMinor: 1000,
      mapping: { currentUnitPriceMinor: 1200, cartUnitPriceMinor: 1200, priceChanged: true, stockAvailableQuantity: 3 } });
    expect(mapped.items[1]!.mapping).toMatchObject({ status: "unavailable", reasons: ["variant_not_found"] });
    expect(mapped).not.toHaveProperty("components"); expect(JSON.stringify(mapped)).not.toContain("paymentFee");
    const reply = { schemaVersion: 3, commercialPrefill: mapped, customerAttribution: "walk_in", customer: null };
    expect(EffectiveOrderRecreatePrefillV3Schema.parse(reply)).toEqual(reply);
    expect(EffectiveOrderRecreatePrefillV3Schema.safeParse({ ...reply, customerAttribution: "linked" }).success).toBe(false);
    expect(EffectiveOrderRecreatePrefillV3Schema.safeParse({ ...reply, paymentFeeMinor: 100 }).success).toBe(false);
    expect(EffectiveOrderRecreatePrefillV3Schema.safeParse({ ...reply, schemaVersion: 2 }).success).toBe(false);
    expect(() => buildEffectiveOrderRecreatePrefillFromV2({ ...sourceOrder, orderId: "foreign" }, projection, catalog)).toThrow(/identity/);
    expect(() => buildEffectiveOrderRecreatePrefillFromV2(sourceOrder, { ...projection,
      components: { ...projection.components, totalMinor: 1 } }, catalog)).toThrow();
  });
  it("uses every effective line and makes current-price changes explicit", () => {
    const prefill = buildEffectiveOrderRecreatePrefillV1(sourceOrder, effectiveOrder(), [
      {
        productId: "product-a",
        variantId: "variant-a",
        currentTitle: "Current product A",
        currentSku: "SKU-A",
        currentUnitPriceMinor: 1_200,
        stockAvailableQuantity: 8,
        published: true,
        archived: false,
      },
      {
        productId: "product-b",
        variantId: "variant-b",
        currentTitle: "Current product B",
        currentSku: "SKU-B",
        currentUnitPriceMinor: 500,
        stockAvailableQuantity: 4,
        published: true,
        archived: false,
      },
    ]);

    expect(prefill).toMatchObject({
      sourceOrder,
      sourceCommercialState: "active",
      effectiveRevision: 2,
      cartCommercialSemantics: "new_sale_current_catalog_pricing_explicit",
      cartReadiness: "ready",
      availableCount: 2,
      unavailableCount: 0,
      warningCount: 1,
    });
    expect(prefill.items).toEqual([
      expect.objectContaining({
        sourceLineId: "line-new-a",
        requestedQuantity: 2,
        effectiveUnitPriceMinor: 1_000,
        mapping: expect.objectContaining({
          status: "available",
          cartUnitPriceMinor: 1_200,
          priceChanged: true,
        }),
      }),
      expect.objectContaining({
        sourceLineId: "line-new-b",
        requestedQuantity: 1,
        mapping: expect.objectContaining({ status: "available", priceChanged: false }),
      }),
    ]);
  });

  it("does not silently skip missing, archived, mismatched or understocked effective lines", () => {
    const projection = effectiveOrder({
      lines: [
        {
          lineId: "missing-identity",
          productId: null,
          variantId: null,
          skuSnapshot: "OLD-1",
          titleSnapshot: "Missing identity",
          quantity: 1,
          unitPriceMinor: 500,
        },
        {
          lineId: "archived-source",
          productId: "product-a",
          variantId: "variant-a",
          skuSnapshot: "OLD-2",
          titleSnapshot: "Archived source",
          quantity: 1,
          unitPriceMinor: 500,
          archivedVariant: true,
        },
        {
          lineId: "identity-mismatch",
          productId: "product-b",
          variantId: "variant-b",
          skuSnapshot: "OLD-3",
          titleSnapshot: "Mismatch",
          quantity: 1,
          unitPriceMinor: 500,
        },
      ],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 1_500,
        discountMinor: 0,
        merchandiseNetMinor: 1_500,
        shippingMinor: 0,
        merchandiseVatMinor: 0,
        shippingVatMinor: 0,
        vatMinor: 0,
        unclassifiedMinor: 0,
        totalMinor: 1_500,
      },
      currentOrderGrossValueMinor: 1_500,
      dataQuality: {
        status: "partial",
        costCoverage: { knownLines: 0, totalLines: 3 },
        warnings: ["historical identity/cost gaps"],
      },
    });
    const prefill = buildEffectiveOrderRecreatePrefillV1(sourceOrder, projection, [
      {
        productId: "product-a",
        variantId: "variant-a",
        currentTitle: "Archived source",
        currentSku: "OLD-2",
        currentUnitPriceMinor: 500,
        stockAvailableQuantity: 10,
        published: true,
        archived: false,
      },
      {
        productId: "different-product",
        variantId: "variant-b",
        currentTitle: "Mismatch",
        currentSku: "OLD-3",
        currentUnitPriceMinor: 500,
        stockAvailableQuantity: 0,
        published: false,
        archived: false,
      },
    ]);

    expect(prefill.items).toHaveLength(3);
    expect(prefill).toMatchObject({
      cartReadiness: "blocked_unavailable_items",
      availableCount: 0,
      unavailableCount: 3,
      warningCount: 3,
    });
    expect(prefill.items.map((item) => item.mapping)).toEqual([
      expect.objectContaining({ status: "unavailable", reasons: ["missing_variant_identity"] }),
      expect.objectContaining({ status: "unavailable", reasons: ["source_variant_archived"] }),
      expect.objectContaining({
        status: "unavailable",
        reasons: ["product_identity_mismatch", "variant_unpublished", "insufficient_stock"],
      }),
    ]);
    expect(EffectiveOrderRecreatePrefillV1Schema.parse(prefill)).toEqual(prefill);
  });

  it("rejects duplicate catalog candidates instead of choosing one by row order", () => {
    const candidate = {
      productId: "product-a",
      variantId: "variant-a",
      currentTitle: "A",
      currentSku: "SKU-A",
      currentUnitPriceMinor: 1_000,
      stockAvailableQuantity: 10,
      published: true,
      archived: false,
    };
    expect(() => buildEffectiveOrderRecreatePrefillV1(
      sourceOrder,
      effectiveOrder(),
      [candidate, candidate],
    )).toThrow();
  });

  it("rejects forged recreate summary counts and implicit cart prices", () => {
    const prefill = buildEffectiveOrderRecreatePrefillV1(sourceOrder, effectiveOrder(), [
      {
        productId: "product-a",
        variantId: "variant-a",
        currentTitle: "A",
        currentSku: "SKU-A",
        currentUnitPriceMinor: 1_100,
        stockAvailableQuantity: 10,
        published: true,
        archived: false,
      },
      {
        productId: "product-b",
        variantId: "variant-b",
        currentTitle: "B",
        currentSku: "SKU-B",
        currentUnitPriceMinor: 500,
        stockAvailableQuantity: 10,
        published: true,
        archived: false,
      },
    ]);
    expect(EffectiveOrderRecreatePrefillV1Schema.safeParse({
      ...prefill,
      warningCount: 0,
    }).success).toBe(false);
    expect(EffectiveOrderRecreatePrefillV1Schema.safeParse({
      ...prefill,
      cartReadiness: "blocked_unavailable_items",
    }).success).toBe(false);
    expect(EffectiveOrderRecreatePrefillV1Schema.safeParse({
      ...prefill,
      items: prefill.items.map((item, index) => index === 0 && item.mapping.status === "available"
        ? { ...item, mapping: { ...item.mapping, cartUnitPriceMinor: 1_000 } }
        : item),
    }).success).toBe(false);
  });
});
