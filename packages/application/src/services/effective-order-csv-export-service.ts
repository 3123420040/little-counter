import {
  EffectiveOrderCsvOrderRecordV3Schema,
  EffectiveOrderCsvSnapshotV3Schema,
  ORDER_CSV_LINE_V3_HEADERS,
  ORDER_CSV_ORDER_V3_HEADERS,
  type EffectiveOrderCsvOrderRecordV3,
  type EffectiveOrderCsvSnapshotV3,
} from "@medusa-snus/contracts";
import { serializeCsv, type CsvCell } from "./csv-export-service";

interface NormalizedCsvExportV3 {
  snapshot: EffectiveOrderCsvSnapshotV3;
  snapshotRevision: string;
  records: EffectiveOrderCsvOrderRecordV3[];
}

function normalizeCsvExportV3(
  snapshotInput: EffectiveOrderCsvSnapshotV3,
  recordInputs: readonly EffectiveOrderCsvOrderRecordV3[],
): NormalizedCsvExportV3 {
  const snapshot = EffectiveOrderCsvSnapshotV3Schema.parse(snapshotInput);
  const storeIds = new Set(snapshot.storeRevisions.map((item) => item.storeId));
  const orderIds = new Set<string>();
  const records = recordInputs.map((input) => {
    const record = EffectiveOrderCsvOrderRecordV3Schema.parse(input);
    if (record.sourceOrder.merchantId !== snapshot.merchantId) {
      throw new Error("CSV order is outside the merchant snapshot scope");
    }
    if (!storeIds.has(record.sourceOrder.storeId)) {
      throw new Error("CSV order store is absent from the snapshot revision vector");
    }
    if (orderIds.has(record.sourceOrder.orderId)) {
      throw new Error(`duplicate CSV order: ${record.sourceOrder.orderId}`);
    }
    orderIds.add(record.sourceOrder.orderId);
    return record;
  });

  records.sort((left, right) => {
    const createdAtDifference = Date.parse(right.sourceOrder.createdAt)
      - Date.parse(left.sourceOrder.createdAt);
    if (createdAtDifference !== 0) return createdAtDifference;
    if (left.sourceOrder.orderId === right.sourceOrder.orderId) return 0;
    return left.sourceOrder.orderId < right.sourceOrder.orderId ? 1 : -1;
  });

  return {
    snapshot,
    snapshotRevision: JSON.stringify(snapshot.storeRevisions),
    records,
  };
}

function safeEffectiveQuantity(record: EffectiveOrderCsvOrderRecordV3): number {
  let quantity = 0;
  for (const line of record.effectiveOrder.lines) {
    quantity += line.quantity;
    if (!Number.isSafeInteger(quantity)) {
      throw new Error(`effective quantity exceeds safe integer: ${record.sourceOrder.orderId}`);
    }
  }
  return quantity;
}

export function serializeEffectiveOrderOrderCsvV3(
  snapshotInput: EffectiveOrderCsvSnapshotV3,
  recordInputs: readonly EffectiveOrderCsvOrderRecordV3[],
): string {
  const { snapshot, snapshotRevision, records } = normalizeCsvExportV3(
    snapshotInput,
    recordInputs,
  );
  const rows: CsvCell[][] = records.map((record) => {
    const { sourceOrder, customerAttribution, customer, effectiveOrder, paymentSummary } = record;
    const items = effectiveOrder.lines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      variantId: line.variantId,
      skuSnapshot: line.skuSnapshot,
      titleSnapshot: line.titleSnapshot,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.quantity * line.unitPriceMinor,
      archivedVariant: line.archivedVariant || false,
    }));
    return [
      snapshot.contractVersion,
      "order",
      snapshotRevision,
      snapshot.asOf,
      sourceOrder.merchantId,
      sourceOrder.storeId,
      sourceOrder.orderId,
      sourceOrder.orderNumber,
      sourceOrder.createdAt,
      customerAttribution,
      customer?.id || "",
      customer?.firstName || "",
      customer?.lastName || "",
      customer?.phone || "",
      effectiveOrder.effectiveRevision,
      effectiveOrder.commercialState,
      effectiveOrder.currencyCode,
      effectiveOrder.minorUnitExponent,
      effectiveOrder.components.taxMode,
      effectiveOrder.components.merchandiseGrossMinor,
      effectiveOrder.components.discountMinor,
      effectiveOrder.components.merchandiseNetMinor,
      effectiveOrder.components.shippingMinor,
      effectiveOrder.components.merchandiseVatMinor,
      effectiveOrder.components.shippingVatMinor,
      effectiveOrder.components.vatMinor,
      effectiveOrder.components.unclassifiedMinor,
      effectiveOrder.components.totalMinor,
      effectiveOrder.currentOrderGrossValueMinor,
      effectiveOrder.lines.length,
      safeEffectiveQuantity(record),
      JSON.stringify(items),
      paymentSummary.recordedGrossCollectionsMinor,
      paymentSummary.refundsMinor,
      paymentSummary.reversalsMinor,
      paymentSummary.chargebacksMinor,
      paymentSummary.negativeCollectionsMinor,
      paymentSummary.netCollectionsMinor,
      effectiveOrder.dataQuality.status,
      JSON.stringify(effectiveOrder.dataQuality.warnings),
    ];
  });
  return serializeCsv(ORDER_CSV_ORDER_V3_HEADERS, rows);
}

export function serializeEffectiveOrderLineCsvV3(
  snapshotInput: EffectiveOrderCsvSnapshotV3,
  recordInputs: readonly EffectiveOrderCsvOrderRecordV3[],
): string {
  const { snapshot, snapshotRevision, records } = normalizeCsvExportV3(
    snapshotInput,
    recordInputs,
  );
  const rows: CsvCell[][] = [];
  for (const record of records) {
    const { sourceOrder, customerAttribution, customer, effectiveOrder } = record;
    effectiveOrder.lines.forEach((line, index) => {
      rows.push([
        snapshot.contractVersion,
        "effective_line",
        snapshotRevision,
        snapshot.asOf,
        sourceOrder.merchantId,
        sourceOrder.storeId,
        sourceOrder.orderId,
        sourceOrder.orderNumber,
        sourceOrder.createdAt,
        customerAttribution,
        customer?.id || "",
        customer?.firstName || "",
        customer?.lastName || "",
        customer?.phone || "",
        effectiveOrder.effectiveRevision,
        effectiveOrder.commercialState,
        index + 1,
        line.lineId,
        line.productId,
        line.variantId,
        line.skuSnapshot,
        line.titleSnapshot,
        line.quantity,
        line.unitPriceMinor,
        line.quantity * line.unitPriceMinor,
        effectiveOrder.currencyCode,
        effectiveOrder.minorUnitExponent,
        line.archivedVariant || false,
        effectiveOrder.dataQuality.status,
      ]);
    });
  }
  return serializeCsv(ORDER_CSV_LINE_V3_HEADERS, rows);
}
