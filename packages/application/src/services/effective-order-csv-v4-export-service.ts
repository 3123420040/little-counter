import {
  EffectiveOrderCsvOrderRecordV5Schema, EffectiveOrderCsvSnapshotV5Schema, ORDER_CSV_ORDER_V5_HEADERS, ORDER_CSV_LINE_V5_HEADERS,
  type EffectiveOrderCsvOrderRecordV5, type EffectiveOrderCsvSnapshotV5,
  EffectiveOrderCsvOrderRecordV4Schema,
  EffectiveOrderCsvSnapshotV4Schema,
  ORDER_CSV_LINE_V4_HEADERS,
  ORDER_CSV_ORDER_V4_HEADERS,
  type EffectiveOrderCsvOrderRecordV4,
  type EffectiveOrderCsvSnapshotV4,
} from "@medusa-snus/contracts";
import { serializeCsv, type CsvCell } from "./csv-export-service";

type CsvRecord = EffectiveOrderCsvOrderRecordV4 | EffectiveOrderCsvOrderRecordV5;
type CsvSnapshot = EffectiveOrderCsvSnapshotV4 | EffectiveOrderCsvSnapshotV5;

interface NormalizedCsvExportV4 {
  snapshot: CsvSnapshot;
  snapshotRevision: string;
  records: CsvRecord[];
}

function normalizeCsvExportV4(
  snapshotInput: CsvSnapshot,
  recordInputs: readonly CsvRecord[],
  version: 4 | 5,
): NormalizedCsvExportV4 {
  const snapshot = version === 5 ? EffectiveOrderCsvSnapshotV5Schema.parse(snapshotInput) : EffectiveOrderCsvSnapshotV4Schema.parse(snapshotInput);
  const storeIds = new Set(snapshot.storeRevisions.map((item) => item.storeId));
  const orderIds = new Set<string>();
  const records = recordInputs.map((input) => {
    const record = version === 5 ? EffectiveOrderCsvOrderRecordV5Schema.parse(input) : EffectiveOrderCsvOrderRecordV4Schema.parse(input);
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

function safeEffectiveQuantity(record: CsvRecord): number {
  let quantity = 0;
  for (const line of record.effectiveOrder.lines) {
    quantity += line.quantity;
    if (!Number.isSafeInteger(quantity)) {
      throw new Error(`effective quantity exceeds safe integer: ${record.sourceOrder.orderId}`);
    }
  }
  return quantity;
}

function serializeOrderCsv(
  snapshotInput: CsvSnapshot,
  recordInputs: readonly CsvRecord[],
  version: 4 | 5,
): string {
  const { snapshot, snapshotRevision, records } = normalizeCsvExportV4(
    snapshotInput,
    recordInputs,
    version,
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
      paymentSummary.paymentMethods.join("|"),
      ...(version === 5 && "paymentFee" in record ? [
        effectiveOrder.schemaVersion === 2 ? effectiveOrder.componentVersion : 1,
        record.paymentFee?.paymentFeeType ?? "", record.paymentFee?.paymentFeeValue ?? "",
        record.paymentFee?.paymentFeeBasisMinor ?? "", record.paymentFee?.vatRatePpm ?? "",
        "paymentFeeMinor" in effectiveOrder.components ? effectiveOrder.components.paymentFeeMinor : 0,
        "paymentFeeVatMinor" in effectiveOrder.components ? effectiveOrder.components.paymentFeeVatMinor : 0,
        feeCustomerTotal(record), feeCommercialRevenue(record),
      ] : []),
    ];
  });
  return serializeCsv(version === 5 ? ORDER_CSV_ORDER_V5_HEADERS : ORDER_CSV_ORDER_V4_HEADERS, rows);
}

function serializeLineCsv(
  snapshotInput: CsvSnapshot,
  recordInputs: readonly CsvRecord[],
  version: 4 | 5,
): string {
  const { snapshot, snapshotRevision, records } = normalizeCsvExportV4(
    snapshotInput,
    recordInputs,
    version,
  );
  const rows: CsvCell[][] = [];
  for (const record of records) {
    const { sourceOrder, customerAttribution, customer, effectiveOrder, paymentSummary } = record;
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
        paymentSummary.paymentMethods.join("|"),
      ]);
    });
  }
  return serializeCsv(version === 5 ? ORDER_CSV_LINE_V5_HEADERS : ORDER_CSV_LINE_V4_HEADERS, rows);
}

function feeCustomerTotal(record: EffectiveOrderCsvOrderRecordV5): number {
  const c = record.effectiveOrder.components;
  return c.paymentFeeMinor + (c.taxMode === "exclusive" ? c.paymentFeeVatMinor : 0);
}
function feeCommercialRevenue(record: EffectiveOrderCsvOrderRecordV5): number {
  const c = record.effectiveOrder.components;
  return c.paymentFeeMinor - (c.taxMode === "inclusive" ? c.paymentFeeVatMinor : 0);
}
export function serializeEffectiveOrderOrderCsvV4(snapshot: EffectiveOrderCsvSnapshotV4, records: readonly EffectiveOrderCsvOrderRecordV4[]): string {
  return serializeOrderCsv(snapshot, records, 4);
}
export function serializeEffectiveOrderLineCsvV4(snapshot: EffectiveOrderCsvSnapshotV4, records: readonly EffectiveOrderCsvOrderRecordV4[]): string {
  return serializeLineCsv(snapshot, records, 4);
}
export function serializeEffectiveOrderOrderCsvV5(snapshot: EffectiveOrderCsvSnapshotV5, records: readonly EffectiveOrderCsvOrderRecordV5[]): string {
  return serializeOrderCsv(snapshot, records, 5);
}
export function serializeEffectiveOrderLineCsvV5(snapshot: EffectiveOrderCsvSnapshotV5, records: readonly EffectiveOrderCsvOrderRecordV5[]): string {
  return serializeLineCsv(snapshot, records, 5);
}
