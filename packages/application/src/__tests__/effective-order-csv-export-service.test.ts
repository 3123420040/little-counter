import { describe, expect, it } from "vitest";
import {
  EffectiveOrderCsvOrderRecordV3Schema,
  ORDER_CSV_LINE_V3_HEADERS,
  ORDER_CSV_ORDER_V3_HEADERS,
  ORDER_CSV_LINE_V4_HEADERS,
  ORDER_CSV_ORDER_V4_HEADERS,
  type EffectiveOrderCsvOrderRecordV3,
  type EffectiveOrderV1,
} from "@medusa-snus/contracts";
import { parseCsvRows } from "../services/csv-parse-service";
import {
  serializeEffectiveOrderLineCsvV3,
  serializeEffectiveOrderOrderCsvV3,
} from "../services/effective-order-csv-export-service";
import { serializeEffectiveOrderLineCsvV4, serializeEffectiveOrderOrderCsvV4 } from "../services/effective-order-csv-v4-export-service";

const snapshot = {
  contractVersion: "orders.effective-order.v3" as const,
  merchantId: "merchant-a",
  storeRevisions: [
    { storeId: "store-a", revision: 17 },
    { storeId: "store-b", revision: 9 },
  ],
  asOf: "2026-08-05T00:00:00.000Z",
};

function effectiveOrder(
  orderId = "order-corrected",
  overrides: Partial<EffectiveOrderV1> = {},
): EffectiveOrderV1 {
  return {
    schemaVersion: 1,
    orderId,
    currencyCode: "VND",
    minorUnitExponent: 0,
    effectiveRevision: 2,
    commercialState: "active",
    lines: [
      {
        lineId: `${orderId}:line-a`,
        productId: "product-a",
        variantId: "variant-a",
        skuSnapshot: "SKU-A",
        titleSnapshot: "Effective A",
        quantity: 2,
        unitPriceMinor: 1_000,
        archivedVariant: false,
      },
      {
        lineId: `${orderId}:line-b`,
        productId: "product-b",
        variantId: "variant-b",
        skuSnapshot: "=FORMULA",
        titleSnapshot: "Added, corrected \"B\"\nsecond line",
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

function record(
  orderId = "order-corrected",
  overrides: Partial<EffectiveOrderCsvOrderRecordV3> = {},
): EffectiveOrderCsvOrderRecordV3 {
  return {
    sourceOrder: {
      merchantId: "merchant-a",
      storeId: "store-a",
      orderId,
      orderNumber: `ORD-${orderId}`,
      createdAt: "2026-08-04T12:00:00.000Z",
    },
    customerAttribution: "unknown",
    customer: null,
    effectiveOrder: effectiveOrder(orderId),
    paymentSummary: {
      currencyCode: "VND",
      recordedGrossCollectionsMinor: 2_650,
      refundsMinor: 100,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 100,
      netCollectionsMinor: 2_550,
    },
    ...overrides,
  };
}

describe("CSV-01 versioned effective-order export", () => {
  it("preserves V4 escaping and split methods in both grains", () => {
    const v4Snapshot = { ...snapshot, contractVersion: "orders.effective-order.v4" as const };
    const original = record();
    const v4 = { ...original, paymentSummary: { ...original.paymentSummary, paymentMethods: ["cash", "manual_bank"] } };
    const orders = parseCsvRows(serializeEffectiveOrderOrderCsvV4(v4Snapshot, [v4]), ORDER_CSV_ORDER_V4_HEADERS);
    const lines = parseCsvRows(serializeEffectiveOrderLineCsvV4(v4Snapshot, [v4]), ORDER_CSV_LINE_V4_HEADERS);
    expect(orders[0]!.payment_methods).toBe("cash|manual_bank");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.payment_methods === "cash|manual_bank")).toBe(true);
    expect(lines[1]).toMatchObject({ sku_snapshot: "'=FORMULA", title_snapshot: "Added, corrected \"B\"\nsecond line" });
  });
  it("emits one order row with the complete corrected items JSON and exact components", () => {
    const csv = serializeEffectiveOrderOrderCsvV3(snapshot, [record()]);
    const rows = parseCsvRows(csv, ORDER_CSV_ORDER_V3_HEADERS);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      contract_version: "orders.effective-order.v3",
      grain: "order",
      order_id: "order-corrected",
      customer_attribution: "unknown",
      effective_revision: "2",
      tax_mode: "exclusive",
      merchandise_gross_minor: "2500",
      discount_minor: "200",
      shipping_minor: "100",
      merchandise_vat_minor: "240",
      shipping_vat_minor: "0",
      vat_minor: "240",
      unclassified_minor: "10",
      effective_commercial_total_minor: "2650",
      current_order_gross_value_minor: "2650",
      effective_item_count: "2",
      effective_quantity: "3",
      recorded_gross_collections_minor: "2650",
      negative_collections_minor: "100",
      net_collections_minor: "2550",
    });
    expect(JSON.parse(rows[0]!.snapshot_revision)).toEqual(snapshot.storeRevisions);
    expect(JSON.parse(rows[0]!.effective_items_json)).toEqual([
      expect.objectContaining({ skuSnapshot: "SKU-A", quantity: 2, lineTotalMinor: 2_000 }),
      expect.objectContaining({ skuSnapshot: "=FORMULA", quantity: 1, lineTotalMinor: 500 }),
    ]);
    expect(rows[0]!.effective_items_json).not.toContain("REMOVED-OLD-SKU");
  });

  it("emits one row per effective line without repeated order/payment aggregates", () => {
    expect(ORDER_CSV_LINE_V3_HEADERS).not.toEqual(expect.arrayContaining([
      "effective_commercial_total_minor",
      "current_order_gross_value_minor",
      "recorded_gross_collections_minor",
      "net_collections_minor",
    ]));
    const csv = serializeEffectiveOrderLineCsvV3(snapshot, [record()]);
    const rows = parseCsvRows(csv, ORDER_CSV_LINE_V3_HEADERS);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.line_position)).toEqual(["1", "2"]);
    expect(rows.reduce((sum, row) => sum + Number(row.effective_line_total_minor), 0)).toBe(2_500);
    expect(rows[1]).toMatchObject({
      order_id: "order-corrected",
      effective_revision: "2",
      sku_snapshot: "'=FORMULA",
      title_snapshot: "Added, corrected \"B\"\nsecond line",
      quantity: "1",
      effective_line_total_minor: "500",
      snapshot_revision: JSON.stringify(snapshot.storeRevisions),
      as_of: snapshot.asOf,
    });
  });

  it("keeps cancelled audit value/items but exports zero current order value", () => {
    const cancelled = effectiveOrder("order-cancelled", {
      commercialState: "cancelled",
      currentOrderGrossValueMinor: 0,
    });
    const csv = serializeEffectiveOrderOrderCsvV3(snapshot, [record("order-cancelled", {
      effectiveOrder: cancelled,
      paymentSummary: {
        currencyCode: "VND",
        recordedGrossCollectionsMinor: 2_650,
        refundsMinor: 0,
        reversalsMinor: 0,
        chargebacksMinor: 0,
        negativeCollectionsMinor: 0,
        netCollectionsMinor: 2_650,
      },
    })]);
    const [row] = parseCsvRows(csv, ORDER_CSV_ORDER_V3_HEADERS);

    expect(row).toMatchObject({
      commercial_state: "cancelled",
      effective_commercial_total_minor: "2650",
      current_order_gross_value_minor: "0",
      effective_item_count: "2",
    });
  });

  it("fails closed for scope, source identity, payment arithmetic and snapshot drift", () => {
    expect(() => serializeEffectiveOrderOrderCsvV3(snapshot, [record("order-a", {
      sourceOrder: {
        merchantId: "merchant-other",
        storeId: "store-a",
        orderId: "order-a",
        orderNumber: "ORD-A",
        createdAt: "2026-08-04T12:00:00.000Z",
      },
    })])).toThrow();
    expect(() => EffectiveOrderCsvOrderRecordV3Schema.parse({
      ...record(),
      paymentSummary: { ...record().paymentSummary, netCollectionsMinor: 2_649 },
    })).toThrow();
    expect(() => serializeEffectiveOrderLineCsvV3(
      { ...snapshot, storeRevisions: [{ storeId: "store-b", revision: 9 }] },
      [record()],
    )).toThrow();
    expect(() => serializeEffectiveOrderOrderCsvV3(snapshot, [record(), record()])).toThrow();
  });

  it("sorts deterministically and preserves 10,000 one-row orders without multiplying totals", () => {
    const records = Array.from({ length: 10_000 }, (_, index) => {
      const orderId = `order-${String(index).padStart(5, "0")}`;
      return record(orderId, {
        sourceOrder: {
          merchantId: "merchant-a",
          storeId: index % 2 === 0 ? "store-a" : "store-b",
          orderId,
          orderNumber: `ORD-${index}`,
          createdAt: new Date(Date.parse("2026-08-04T00:00:00.000Z") + index).toISOString(),
        },
      });
    }).reverse();
    const rows = parseCsvRows(
      serializeEffectiveOrderOrderCsvV3(snapshot, records),
      ORDER_CSV_ORDER_V3_HEADERS,
    );

    expect(rows).toHaveLength(10_000);
    expect(rows[0]!.order_id).toBe("order-09999");
    expect(rows.at(-1)!.order_id).toBe("order-00000");
    expect(rows.reduce((sum, row) => sum + Number(row.current_order_gross_value_minor), 0))
      .toBe(26_500_000);
  }, 15_000);
});
