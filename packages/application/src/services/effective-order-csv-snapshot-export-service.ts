import {
  EffectiveOrderCsvOrderRecordV3Schema,
  EffectiveOrderCsvPaymentSummaryV3Schema,
  EffectiveOrderCsvSnapshotV3Schema,
  EffectiveOrderV1Schema,
  OrderCollectionRevisionVectorV1Schema,
  OrderCursorFiltersV1Schema,
  OrderCursorScopeV1Schema,
  type EffectiveOrderCsvOrderRecordV3,
  type EffectiveOrderCsvSnapshotV3,
  type EffectiveOrderV1,
  type OrderCursorFiltersV1,
  type OrderCursorScopeV1,
  type OrderCursorTupleV1,
} from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";
import type { EffectiveOrderProjectionBatchRequest } from "./effective-order-projection-service";
import {
  serializeEffectiveOrderLineCsvV3,
  serializeEffectiveOrderOrderCsvV3,
} from "./effective-order-csv-export-service";
import type {
  EffectiveOrderPagePaymentRequestV2,
  EffectiveOrderPagePaymentSummaryV2,
} from "./effective-order-page-service";
import {
  orderPageIdentityTupleV1,
  validateOrderPageIdentityRowsV1,
  type OrderPageIdentityRowV1,
  type OrderPageSnapshotTransactionV1,
} from "./order-page-snapshot-service";

export const EFFECTIVE_ORDER_CSV_SNAPSHOT_DEFAULT_BATCH_SIZE_V3 = 200;
export const EFFECTIVE_ORDER_CSV_SNAPSHOT_MAX_ORDERS_V3 = 10_000;

export class EffectiveOrderCsvAsyncExportRequiredError extends PlatformError {
  constructor(selectedOrderCount: number) {
    super(
      "async_export_required",
      `Selections above ${EFFECTIVE_ORDER_CSV_SNAPSHOT_MAX_ORDERS_V3} orders require asynchronous export`,
      413,
      {
        selectedOrderCount,
        maximumOrderCount: EFFECTIVE_ORDER_CSV_SNAPSHOT_MAX_ORDERS_V3,
      },
    );
    this.name = "EffectiveOrderCsvAsyncExportRequiredError";
  }
}

export type EffectiveOrderCsvSnapshotGrainV3 = "order" | "effective_line";

export interface EffectiveOrderCsvSnapshotTransactionV3
  extends OrderPageSnapshotTransactionV1 {
  readEffectiveOrders(input: EffectiveOrderProjectionBatchRequest): Promise<EffectiveOrderV1[]>;
  readPaymentSummaries(
    input: EffectiveOrderPagePaymentRequestV2,
  ): Promise<EffectiveOrderPagePaymentSummaryV2[]>;
}

export interface EffectiveOrderCsvSnapshotRepositoryV3 {
  withRepeatableReadSnapshot<T>(
    read: (snapshot: EffectiveOrderCsvSnapshotTransactionV3) => Promise<T>,
  ): Promise<T>;
}

export interface ExportEffectiveOrderSnapshotCsvRequestV3 {
  scope: OrderCursorScopeV1;
  filters: OrderCursorFiltersV1;
  grain: EffectiveOrderCsvSnapshotGrainV3;
  batchSize?: number;
}

export interface EffectiveOrderCsvSnapshotArtifactV3 {
  grain: EffectiveOrderCsvSnapshotGrainV3;
  snapshot: EffectiveOrderCsvSnapshotV3;
  orderCount: number;
  rowCount: number;
  csv: string;
}

function normalizedBatchSize(value: number | undefined): number {
  const batchSize = value ?? EFFECTIVE_ORDER_CSV_SNAPSHOT_DEFAULT_BATCH_SIZE_V3;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
    throw new Error("effective-order CSV batch size must be between 1 and 200");
  }
  return batchSize;
}

function normalizedAsOf(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("effective-order CSV snapshot asOf is invalid");
  }
  return new Date(value).toISOString();
}

function assertExactSnapshotScope(
  scope: OrderCursorScopeV1,
  filters: OrderCursorFiltersV1,
  revisions: EffectiveOrderCsvSnapshotV3["storeRevisions"],
): void {
  const filterStoreIds = filters.storeWindows.map((window) => window.storeId);
  const revisionStoreIds = revisions.map((revision) => revision.storeId);
  if (
    filterStoreIds.length !== scope.storeIds.length
    || revisionStoreIds.length !== scope.storeIds.length
    || scope.storeIds.some((storeId, index) =>
      filterStoreIds[index] !== storeId || revisionStoreIds[index] !== storeId)
  ) {
    throw new Error("effective-order CSV filters/revisions must cover the exact scope");
  }
}

function exactMap<T extends { orderId: string }>(
  values: readonly T[],
  expectedOrderIds: readonly string[],
  label: string,
): Map<string, T> {
  const expected = new Set(expectedOrderIds);
  const byOrderId = new Map<string, T>();
  for (const value of values) {
    if (!expected.has(value.orderId) || byOrderId.has(value.orderId)) {
      throw new Error(`effective-order CSV ${label} identity drift`);
    }
    byOrderId.set(value.orderId, value);
  }
  if (byOrderId.size !== expectedOrderIds.length) {
    throw new Error(`effective-order CSV ${label} coverage is incomplete`);
  }
  return byOrderId;
}

async function hydrateCsvBatch(
  snapshot: EffectiveOrderCsvSnapshotTransactionV3,
  scope: OrderCursorScopeV1,
  rows: readonly OrderPageIdentityRowV1[],
  asOf: string,
): Promise<EffectiveOrderCsvOrderRecordV3[]> {
  const rowsByCurrency = new Map<string, OrderPageIdentityRowV1[]>();
  for (const row of rows) {
    const currencyRows = rowsByCurrency.get(row.currencyCode) || [];
    currencyRows.push(row);
    rowsByCurrency.set(row.currencyCode, currencyRows);
  }

  const projections: EffectiveOrderV1[] = [];
  for (const [currencyCode, currencyRows] of rowsByCurrency) {
    const batch = await snapshot.readEffectiveOrders({
      scope: {
        scopeKind: "report",
        merchantId: scope.merchantId,
        storeIds: [...scope.storeIds],
      },
      orderIds: currencyRows.map((row) => row.orderId),
      currencyCode,
      asOf,
    });
    projections.push(...batch.map((projection) => EffectiveOrderV1Schema.parse(projection)));
  }

  const orderIds = rows.map((row) => row.orderId);
  const projectionByOrder = exactMap(projections, orderIds, "projection");
  const paymentInputs = await snapshot.readPaymentSummaries({ scope, orderIds, asOf });
  const payments = paymentInputs.map((payment) => {
    const {
      orderId,
      currencyCode,
      recordedGrossCollectionsMinor,
      refundsMinor,
      reversalsMinor,
      chargebacksMinor,
      negativeCollectionsMinor,
      netCollectionsMinor,
    } = payment;
    return {
      orderId,
      ...EffectiveOrderCsvPaymentSummaryV3Schema.parse({
        currencyCode,
        recordedGrossCollectionsMinor,
        refundsMinor,
        reversalsMinor,
        chargebacksMinor,
        negativeCollectionsMinor,
        netCollectionsMinor,
      }),
    };
  });
  const paymentByOrder = exactMap(payments, orderIds, "payment");

  return rows.map((row) => {
    const effectiveOrder = projectionByOrder.get(row.orderId);
    const paymentSummary = paymentByOrder.get(row.orderId);
    if (
      !effectiveOrder
      || !paymentSummary
      || effectiveOrder.currencyCode !== row.currencyCode
      || paymentSummary.currencyCode !== row.currencyCode
    ) {
      throw new Error("effective-order CSV identity/currency hydration mismatch");
    }
    const { orderId: paymentOrderId, ...csvPaymentSummary } = paymentSummary;
    if (paymentOrderId !== row.orderId) {
      throw new Error("effective-order CSV payment identity mismatch");
    }
    return EffectiveOrderCsvOrderRecordV3Schema.parse({
      sourceOrder: {
        merchantId: row.merchantId,
        storeId: row.storeId,
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        createdAt: row.createdAt,
      },
      customerAttribution: row.customerAttribution
        ?? (row.customer ? "linked" : "unknown"),
      customer: row.customer ?? null,
      effectiveOrder,
      paymentSummary: csvPaymentSummary,
    });
  });
}

function safeEffectiveLineCount(records: readonly EffectiveOrderCsvOrderRecordV3[]): number {
  let count = 0;
  for (const record of records) {
    count += record.effectiveOrder.lines.length;
    if (!Number.isSafeInteger(count)) {
      throw new Error("effective-order CSV line count exceeds safe integer");
    }
  }
  return count;
}

export async function exportEffectiveOrderSnapshotCsvV3(
  repository: EffectiveOrderCsvSnapshotRepositoryV3,
  requestInput: ExportEffectiveOrderSnapshotCsvRequestV3,
): Promise<EffectiveOrderCsvSnapshotArtifactV3> {
  const scope = OrderCursorScopeV1Schema.parse(requestInput.scope);
  const filters = OrderCursorFiltersV1Schema.parse(requestInput.filters);
  const batchSize = normalizedBatchSize(requestInput.batchSize);
  if (requestInput.grain !== "order" && requestInput.grain !== "effective_line") {
    throw new Error("effective-order CSV grain is invalid");
  }

  return repository.withRepeatableReadSnapshot(async (transaction) => {
    const asOf = normalizedAsOf(await transaction.readAsOf());
    const storeRevisions = OrderCollectionRevisionVectorV1Schema.parse(
      await transaction.readStoreRevisionVector(scope),
    );
    assertExactSnapshotScope(scope, filters, storeRevisions);
    const exportSnapshot = EffectiveOrderCsvSnapshotV3Schema.parse({
      contractVersion: "orders.effective-order.v3",
      merchantId: scope.merchantId,
      storeRevisions,
      asOf,
    });

    const totalCount = await transaction.countRows({ scope, filters });
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      throw new Error("effective-order CSV total count is invalid");
    }
    if (totalCount > EFFECTIVE_ORDER_CSV_SNAPSHOT_MAX_ORDERS_V3) {
      throw new EffectiveOrderCsvAsyncExportRequiredError(totalCount);
    }

    const records: EffectiveOrderCsvOrderRecordV3[] = [];
    const seenOrderIds = new Set<string>();
    let highWatermark: OrderCursorTupleV1 | undefined;
    let after: OrderCursorTupleV1 | undefined;

    while (records.length < totalCount) {
      const rowsRequest = {
        scope,
        filters,
        ...(highWatermark ? { highWatermark } : {}),
        ...(after ? { after } : {}),
        limit: batchSize,
      };
      const rows = validateOrderPageIdentityRowsV1(
        await transaction.readRows(rowsRequest),
        rowsRequest,
      );
      if (rows.length === 0) {
        throw new Error("effective-order CSV traversal ended before exact count coverage");
      }
      if (records.length + rows.length > totalCount) {
        throw new Error("effective-order CSV traversal exceeds exact count");
      }
      for (const row of rows) {
        if (seenOrderIds.has(row.orderId)) {
          throw new Error("effective-order CSV traversal repeated an order");
        }
        seenOrderIds.add(row.orderId);
      }

      records.push(...await hydrateCsvBatch(transaction, scope, rows, asOf));
      highWatermark ||= orderPageIdentityTupleV1(rows[0]!);
      after = orderPageIdentityTupleV1(rows.at(-1)!);
    }

    const sentinelRequest = {
      scope,
      filters,
      ...(highWatermark ? { highWatermark } : {}),
      ...(after ? { after } : {}),
      limit: 1,
    };
    const sentinel = validateOrderPageIdentityRowsV1(
      await transaction.readRows(sentinelRequest),
      sentinelRequest,
    );
    if (sentinel.length !== 0 || records.length !== totalCount) {
      throw new Error("effective-order CSV count/traversal mismatch");
    }

    const rowCount = requestInput.grain === "order"
      ? records.length
      : safeEffectiveLineCount(records);
    const csv = requestInput.grain === "order"
      ? serializeEffectiveOrderOrderCsvV3(exportSnapshot, records)
      : serializeEffectiveOrderLineCsvV3(exportSnapshot, records);
    return {
      grain: requestInput.grain,
      snapshot: exportSnapshot,
      orderCount: records.length,
      rowCount,
      csv,
    };
  });
}
