import { describe, expect, it } from "vitest";
import { EffectiveOrderCsvOrderRecordV5Schema, EffectiveOrderCsvSnapshotV5Schema,
  ORDER_CSV_ORDER_V5_HEADERS, ORDER_CSV_LINE_V5_HEADERS } from "@medusa-snus/contracts";
import { serializeEffectiveOrderOrderCsvV5, serializeEffectiveOrderLineCsvV5 } from "../services/effective-order-csv-v4-export-service";
import { parseCsvRows } from "../services/csv-parse-service";

const snapshot = { contractVersion: "orders.effective-order.v5" as const, merchantId: "merchant-a",
  storeRevisions: [{ storeId: "store-a", revision: 2 }], asOf: "2026-10-27T00:00:00.000Z" };
const record = { sourceOrder: { merchantId: "merchant-a", storeId: "store-a", orderId: "order-a", orderNumber: "ORD-A",
    createdAt: "2026-10-26T00:00:00.000Z" }, customerAttribution: "walk_in" as const, customer: null,
  effectiveOrder: { schemaVersion: 2 as const, componentVersion: 2 as const, orderId: "order-a", currencyCode: "VND", minorUnitExponent: 0,
    effectiveRevision: 0, commercialState: "active" as const,
    lines: [{ lineId: "line-a", productId: null, variantId: null, skuSnapshot: "=SKU", titleSnapshot: 'Apple, "green"\n6mg', quantity: 1, unitPriceMinor: 600 },
      { lineId: "line-b", productId: null, variantId: null, skuSnapshot: "SKU-B", titleSnapshot: "Berry", quantity: 2, unitPriceMinor: 200 }],
    components: { taxMode: "exclusive" as const, merchandiseGrossMinor: 1000, discountMinor: 100, merchandiseNetMinor: 900,
      shippingMinor: 50, merchandiseVatMinor: 90, shippingVatMinor: 5, paymentFeeMinor: 90, paymentFeeVatMinor: 9,
      vatMinor: 104, unclassifiedMinor: 0, totalMinor: 1144 }, currentOrderGrossValueMinor: 1144,
    dataQuality: { status: "complete" as const, costCoverage: { knownLines: 2, totalLines: 2 }, warnings: [] } },
  paymentSummary: { currencyCode: "VND", recordedGrossCollectionsMinor: 1144, refundsMinor: 0, reversalsMinor: 0,
    chargebacksMinor: 0, negativeCollectionsMinor: 0, netCollectionsMinor: 1144, paymentMethods: ["cash" as const, "manual_bank" as const] },
  paymentFee: { paymentFeeType: "percent" as const, paymentFeeValue: 10, paymentFeeBasisMinor: 900, vatRatePpm: 100000 } };

describe("CSV V5 stored surcharge snapshot", () => {
  it("exports the persisted descriptor/basis, VAT and commercial revenue once per order", () => {
    const parsed = parseCsvRows(serializeEffectiveOrderOrderCsvV5(snapshot, [record]), ORDER_CSV_ORDER_V5_HEADERS);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ payment_methods: "cash|manual_bank", payment_fee_type: "percent", payment_fee_value: "10",
      payment_fee_basis_minor: "900", payment_fee_minor: "90", payment_fee_vat_minor: "9",
      payment_fee_customer_total_minor: "99", payment_fee_commercial_revenue_ex_vat_minor: "90", effective_commercial_total_minor: "1144" });
    const lines = parseCsvRows(serializeEffectiveOrderLineCsvV5(snapshot, [record]), ORDER_CSV_LINE_V5_HEADERS);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ title_snapshot: 'Apple, "green"\n6mg', sku_snapshot: "'=SKU", payment_methods: "cash|manual_bank" });
    expect(Object.keys(lines[0]!)).not.toContain("payment_fee_minor");
    expect(parsed[0]!.effective_quantity).toBe("3");
  });
  it("keeps explicit zero distinct from a legacy no-descriptor order and uses inclusive fee VAT", () => {
    const inclusive = { ...record, effectiveOrder: { ...record.effectiveOrder,
      components: { ...record.effectiveOrder.components, taxMode: "inclusive" as const, merchandiseVatMinor: 82, shippingVatMinor: 5,
        paymentFeeVatMinor: 8, vatMinor: 95, totalMinor: 1040 }, currentOrderGrossValueMinor: 1040 } };
    expect(parseCsvRows(serializeEffectiveOrderOrderCsvV5(snapshot, [inclusive]), ORDER_CSV_ORDER_V5_HEADERS)[0])
      .toMatchObject({ payment_fee_customer_total_minor: "90", payment_fee_commercial_revenue_ex_vat_minor: "82" });
    const zero = { ...record, paymentFee: { ...record.paymentFee, paymentFeeType: "amount" as const, paymentFeeValue: 0 },
      effectiveOrder: { ...record.effectiveOrder, components: { ...record.effectiveOrder.components, paymentFeeMinor: 0, paymentFeeVatMinor: 0,
        vatMinor: 95, totalMinor: 1045 }, currentOrderGrossValueMinor: 1045 } };
    const legacy = { ...zero, paymentFee: null, effectiveOrder: { ...zero.effectiveOrder, componentVersion: 1 as const } };
    expect(parseCsvRows(serializeEffectiveOrderOrderCsvV5(snapshot, [zero]), ORDER_CSV_ORDER_V5_HEADERS)[0])
      .toMatchObject({ component_version: "2", payment_fee_type: "amount", payment_fee_value: "0", payment_fee_basis_minor: "900" });
    expect(parseCsvRows(serializeEffectiveOrderOrderCsvV5(snapshot, [legacy]), ORDER_CSV_ORDER_V5_HEADERS)[0])
      .toMatchObject({ component_version: "1", payment_fee_type: "", payment_fee_value: "", payment_fee_basis_minor: "" });
  });
  it("preserves cancelled components without pretending they are current revenue", () => {
    const cancelled = { ...record, effectiveOrder: { ...record.effectiveOrder, commercialState: "cancelled" as const, currentOrderGrossValueMinor: 0 } };
    const [row] = parseCsvRows(serializeEffectiveOrderOrderCsvV5(snapshot, [cancelled]), ORDER_CSV_ORDER_V5_HEADERS);
    expect(row).toMatchObject({ commercial_state: "cancelled", payment_fee_minor: "90", current_order_gross_value_minor: "0" });
  });
  it.each([
    { paymentFee: null }, { paymentFee: { ...record.paymentFee, paymentFeeType: "amount", paymentFeeValue: 1.5 } }, { paymentFee: { ...record.paymentFee, paymentFeeValue: 11 } },
    { paymentFee: { ...record.paymentFee, paymentFeeBasisMinor: 1000 } },
    { paymentFee: { ...record.paymentFee, vatRatePpm: 200000 } },
    { paymentFee: { ...record.paymentFee, unexpected: true } },
    { sourceOrder: { ...record.sourceOrder, orderId: "foreign" } },
    { paymentSummary: { ...record.paymentSummary, currencyCode: "USD" } },
  ])("rejects invalid descriptor/identity bindings: %j", (patch) => {
    expect(EffectiveOrderCsvOrderRecordV5Schema.safeParse({ ...record, ...patch }).success).toBe(false);
  });
  it("rejects version drift, duplicate order IDs and scope drift", () => {
    expect(EffectiveOrderCsvSnapshotV5Schema.safeParse({ ...snapshot, contractVersion: "orders.effective-order.v4" }).success).toBe(false);
    expect(() => serializeEffectiveOrderOrderCsvV5(snapshot, [record, record])).toThrow(/duplicate/);
    expect(() => serializeEffectiveOrderOrderCsvV5({ ...snapshot, merchantId: "foreign" }, [record])).toThrow(/merchant/);
  });
});
