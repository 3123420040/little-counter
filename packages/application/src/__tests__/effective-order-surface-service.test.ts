import { describe, expect, it, vi } from "vitest";
import type { EffectiveOrderV1 } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import {
  buildEffectiveOrderSurfaceV2,
  buildEffectiveOrderSurfaceV3,
  readEffectiveOrderSurfacesV2,
} from "../services/effective-order-surface-service";
import { EFFECTIVE_ORDER_FIXTURES } from "./effective-order-oracle-fixtures";

function projectionFor(fixtureName: string): EffectiveOrderV1 {
  const expected = EFFECTIVE_ORDER_FIXTURES.find((fixture) => fixture.name === fixtureName)!.expected;
  return {
    schemaVersion: 1,
    orderId: expected.orderId,
    currencyCode: expected.currencyCode,
    minorUnitExponent: 0,
    effectiveRevision: expected.effectiveRevision,
    commercialState: expected.commercialState,
    lines: expected.lines.map((line, index) => ({
      lineId: `${expected.orderId}:line:${index}`,
      productId: `product-${line.sku}`,
      variantId: `variant-${line.sku}`,
      skuSnapshot: line.sku,
      titleSnapshot: `Product ${line.sku}`,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      archivedVariant: Boolean(line.archived),
    })),
    components: expected.components,
    currentOrderGrossValueMinor: expected.currentOrderGrossValueMinor,
    dataQuality: {
      status: "complete",
      costCoverage: {
        knownLines: expected.lines.length,
        totalLines: expected.lines.length,
      },
      warnings: [],
    },
  };
}

function rowsFor(projection: EffectiveOrderV1) {
  return projection.lines.map((line, index) => ({
    requested_order_id: projection.orderId,
    request_ordinal: 1,
    revision_id: `revision-${projection.orderId}`,
    revision: String(projection.effectiveRevision),
    commercial_state: projection.commercialState,
    currency_code: projection.currencyCode,
    minor_unit_exponent: String(projection.minorUnitExponent),
    data_quality: projection.dataQuality.status,
    effective_at: "2026-08-04T12:00:00.000Z",
    tax_mode: projection.components.taxMode,
    merchandise_gross_minor: String(projection.components.merchandiseGrossMinor),
    discount_minor: String(projection.components.discountMinor),
    merchandise_net_minor: String(projection.components.merchandiseNetMinor),
    shipping_minor: String(projection.components.shippingMinor),
    merchandise_vat_minor: String(projection.components.merchandiseVatMinor),
    shipping_vat_minor: String(projection.components.shippingVatMinor),
    vat_minor: String(projection.components.vatMinor),
    unclassified_minor: String(projection.components.unclassifiedMinor),
    total_minor: String(projection.components.totalMinor),
    line_key: line.lineId,
    product_id: line.productId,
    variant_id: line.variantId,
    sku_snapshot: line.skuSnapshot,
    title_snapshot: line.titleSnapshot,
    archived_variant: line.archivedVariant || false,
    quantity: String(line.quantity),
    unit_price_minor: String(line.unitPriceMinor),
    line_total_minor: String(line.quantity * line.unitPriceMinor),
    cost_minor: "1",
    cost_evidence_id: `cost-${index}`,
  }));
}

describe("READ-02 canonical order detail/list surface", () => {
  it("keeps the fee-aware detail total and quantity separate, including cancelled snapshots", () => {
    const legacy = projectionFor("add sku");
    const feeOrder = { ...legacy, schemaVersion: 2 as const, componentVersion: 2 as const,
      components: { ...legacy.components, paymentFeeMinor: 100, paymentFeeVatMinor: 10,
        vatMinor: legacy.components.vatMinor + 10, totalMinor: legacy.components.totalMinor + 110 },
      currentOrderGrossValueMinor: legacy.currentOrderGrossValueMinor + 110 };
    const surface = buildEffectiveOrderSurfaceV3("detail", feeOrder);
    expect(surface).toMatchObject({ schemaVersion: 3, componentVersion: 2,
      components: feeOrder.components, effectiveCommercialTotalMinor: feeOrder.components.totalMinor,
      currentOrderGrossValueMinor: feeOrder.currentOrderGrossValueMinor,
      effectiveItemQuantity: legacy.lines.reduce((sum, line) => sum + line.quantity, 0) });
    expect(buildEffectiveOrderSurfaceV3("detail", { ...feeOrder, commercialState: "cancelled", currentOrderGrossValueMinor: 0 }))
      .toMatchObject({ currentOrderGrossValueMinor: 0, effectiveItemQuantity: 0, components: feeOrder.components });
  });
  it("uses the same effective commercial payload for detail and list", () => {
    const projection = projectionFor("add sku");
    const detail = buildEffectiveOrderSurfaceV2("detail", projection);
    const list = buildEffectiveOrderSurfaceV2("list", projection);

    expect(detail).toMatchObject({
      schemaVersion: 2,
      surfaceKind: "detail",
      orderId: "ord-add",
      effectiveRevision: 1,
      commercialState: "active",
      effectiveItems: [
        expect.objectContaining({
          productId: "product-A",
          variantId: "variant-A",
          skuSnapshot: "A",
          quantity: 1,
          lineTotalMinor: 1_000,
        }),
        expect.objectContaining({
          productId: "product-B",
          variantId: "variant-B",
          skuSnapshot: "B",
          quantity: 2,
          lineTotalMinor: 600,
        }),
      ],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 1_600,
        discountMinor: 100,
        merchandiseNetMinor: 1_500,
        shippingMinor: 100,
        merchandiseVatMinor: 160,
        shippingVatMinor: 0,
        vatMinor: 160,
        unclassifiedMinor: 0,
        totalMinor: 1_760,
      },
      effectiveCommercialTotalMinor: 1_760,
      currentOrderGrossValueMinor: 1_760,
      effectiveItemQuantity: 3,
    });
    expect({ ...list, surfaceKind: "detail" }).toEqual(detail);
    expect(detail).not.toHaveProperty("total");
    expect(detail).not.toHaveProperty("originalItems");
    expect(detail).not.toHaveProperty("corrections");
  });

  it("preserves cancelled audit lines while current gross and current quantity are zero", () => {
    const surface = buildEffectiveOrderSurfaceV2(
      "detail",
      projectionFor("corrected then cancelled"),
    );

    expect(surface).toMatchObject({
      commercialState: "cancelled",
      effectiveCommercialTotalMinor: 2_200,
      currentOrderGrossValueMinor: 0,
      effectiveItemQuantity: 0,
    });
    expect(surface.effectiveItems).toEqual([
      expect.objectContaining({ skuSnapshot: "A", quantity: 2, lineTotalMinor: 2_000 }),
    ]);
  });

  it("rejects forged line/component arithmetic rather than falling back", () => {
    const projection = projectionFor("remove and replace sku");
    expect(() => buildEffectiveOrderSurfaceV2("detail", {
      ...projection,
      lines: projection.lines.map((line) => ({ ...line, quantity: 2 })),
    })).toThrow();
    expect(() => buildEffectiveOrderSurfaceV2("list", {
      ...projection,
      components: { ...projection.components, totalMinor: 936 },
    })).toThrow();
  });

  it("builds a list batch through the one canonical READ-01 query without N+1", async () => {
    const projection = projectionFor("add sku");
    const query = vi.fn(async () => ({ rows: rowsFor(projection) }));

    const surfaces = await readEffectiveOrderSurfacesV2(
      { query } as unknown as PoolClient,
      {
        surfaceKind: "list",
        scope: {
          scopeKind: "report",
          merchantId: "merchant-a",
          storeIds: ["store-a"],
        },
        orderIds: [projection.orderId],
        currencyCode: "VND",
        asOf: "2026-08-05T00:00:00.000Z",
      },
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(surfaces).toEqual([
      expect.objectContaining({
        surfaceKind: "list",
        orderId: "ord-add",
        currentOrderGrossValueMinor: 1_760,
      }),
    ]);
  });
});
