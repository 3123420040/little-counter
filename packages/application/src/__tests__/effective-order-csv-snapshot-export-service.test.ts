import { describe, expect, it } from "vitest";
import {
  ORDER_CSV_LINE_V3_HEADERS,
  ORDER_CSV_ORDER_V3_HEADERS,
  ORDER_CSV_ORDER_V4_HEADERS,
  type EffectiveOrderV1,
  type OrderCollectionRevisionVectorV1,
} from "@medusa-snus/contracts";
import { parseCsvRows } from "../services/csv-parse-service";
import {
  EFFECTIVE_ORDER_CSV_SNAPSHOT_MAX_ORDERS_V3,
  exportEffectiveOrderSnapshotCsvV3,
  type EffectiveOrderCsvSnapshotRepositoryV3,
  type EffectiveOrderCsvSnapshotTransactionV3,
} from "../services/effective-order-csv-snapshot-export-service";
import { normalizeOrderCursorFiltersV1 } from "../services/order-cursor-service";
import type { OrderPageIdentityRowV1 } from "../services/order-page-snapshot-service";
import { exportEffectiveOrderSnapshotCsvV4 } from "../services/effective-order-csv-v4-snapshot-export-service";

const scope = { merchantId: "merchant-a", storeIds: ["store-a"] };
const filters = normalizeOrderCursorFiltersV1({
  statusMode: "all",
  storeWindows: [{
    storeId: "store-a",
    startInclusive: "2026-08-01T00:00:00.000Z",
    endExclusive: "2026-08-06T00:00:00.000Z",
  }],
});

function numericOrderId(orderId: string): number {
  return Number(orderId.slice("order-".length));
}

function effectiveOrder(orderId: string): EffectiveOrderV1 {
  const index = numericOrderId(orderId);
  const merchandiseGrossMinor = 1_000 + index;
  const merchandiseNetMinor = merchandiseGrossMinor - 100;
  const totalMinor = merchandiseNetMinor + 50 + 100 + 25;
  return {
    schemaVersion: 1,
    orderId,
    currencyCode: "VND",
    minorUnitExponent: 0,
    effectiveRevision: 2,
    commercialState: "active",
    lines: [{
      lineId: `${orderId}:corrected-line`,
      productId: "product-corrected",
      variantId: "variant-corrected",
      skuSnapshot: "SKU-CORRECTED",
      titleSnapshot: "Corrected item",
      quantity: 1,
      unitPriceMinor: merchandiseGrossMinor,
      archivedVariant: false,
    }],
    components: {
      taxMode: "exclusive",
      merchandiseGrossMinor,
      discountMinor: 100,
      merchandiseNetMinor,
      shippingMinor: 50,
      merchandiseVatMinor: 100,
      shippingVatMinor: 0,
      vatMinor: 100,
      unclassifiedMinor: 25,
      totalMinor,
    },
    currentOrderGrossValueMinor: totalMinor,
    dataQuality: {
      status: "complete",
      costCoverage: { knownLines: 1, totalLines: 1 },
      warnings: [],
    },
  };
}

function makeRows(count: number): OrderPageIdentityRowV1[] {
  return Array.from({ length: count }, (_, index) => ({
    merchantId: "merchant-a",
    storeId: "store-a",
    orderId: `order-${String(index).padStart(5, "0")}`,
    orderNumber: `ORD-${String(index).padStart(5, "0")}`,
    status: "completed",
    currencyCode: "VND",
    createdAt: new Date(Date.parse("2026-08-04T00:00:00.000Z") + index).toISOString(),
  })).reverse();
}

function isAtOrBelow(row: OrderPageIdentityRowV1, bound: { createdAt: string; id: string }) {
  return row.createdAt < bound.createdAt
    || (row.createdAt === bound.createdAt && row.orderId <= bound.id);
}

function isStrictlyBelow(row: OrderPageIdentityRowV1, bound: { createdAt: string; id: string }) {
  return row.createdAt < bound.createdAt
    || (row.createdAt === bound.createdAt && row.orderId < bound.id);
}

class CsvSnapshotTransaction implements EffectiveOrderCsvSnapshotTransactionV3 {
  active = true;
  readLimits: number[] = [];
  projectionBatchSizes: number[] = [];
  paymentBatchSizes: number[] = [];
  rowReadCount = 0;
  countOverride: number | undefined;
  revisions: OrderCollectionRevisionVectorV1 = [{ storeId: "store-a", revision: 31 }];
  missingProjection = false;
  paymentCurrency = "VND";
  repeatPreviousRowOnSecondBatch = false;
  private previousLastRow: OrderPageIdentityRowV1 | undefined;

  constructor(readonly rows: OrderPageIdentityRowV1[]) {}

  private assertActive() {
    if (!this.active) throw new Error("CSV snapshot work escaped the transaction");
  }

  async readAsOf() {
    this.assertActive();
    return "2026-08-05T00:00:00.000Z";
  }

  async readStoreRevisionVector() {
    this.assertActive();
    return this.revisions;
  }

  async countRows() {
    this.assertActive();
    return this.countOverride ?? this.rows.length;
  }

  async readRows(input: Parameters<EffectiveOrderCsvSnapshotTransactionV3["readRows"]>[0]) {
    this.assertActive();
    this.rowReadCount += 1;
    this.readLimits.push(input.limit);
    const matching = this.rows.filter((row) =>
      (!input.highWatermark || isAtOrBelow(row, input.highWatermark))
      && (!input.after || isStrictlyBelow(row, input.after)));
    const result = matching.slice(0, input.limit);
    if (
      this.repeatPreviousRowOnSecondBatch
      && this.rowReadCount === 2
      && this.previousLastRow
    ) {
      result.unshift(this.previousLastRow);
      result.splice(input.limit);
    }
    this.previousLastRow = result.at(-1);
    return result;
  }

  async readEffectiveOrders(
    input: Parameters<EffectiveOrderCsvSnapshotTransactionV3["readEffectiveOrders"]>[0],
  ) {
    this.assertActive();
    this.projectionBatchSizes.push(input.orderIds.length);
    const orderIds = this.missingProjection ? input.orderIds.slice(1) : input.orderIds;
    return orderIds.map((orderId) => effectiveOrder(orderId));
  }

  async readPaymentSummaries(
    input: Parameters<EffectiveOrderCsvSnapshotTransactionV3["readPaymentSummaries"]>[0],
  ) {
    this.assertActive();
    this.paymentBatchSizes.push(input.orderIds.length);
    return input.orderIds.map((orderId) => {
      const totalMinor = effectiveOrder(orderId).currentOrderGrossValueMinor;
      return {
        orderId,
        currencyCode: this.paymentCurrency,
        recordedGrossCollectionsMinor: totalMinor,
        refundsMinor: 0,
        reversalsMinor: 0,
        chargebacksMinor: 0,
        negativeCollectionsMinor: 0,
        netCollectionsMinor: totalMinor,
        customerRefundPayableMinor: 321,
      };
    });
  }
}

class CsvSnapshotRepository implements EffectiveOrderCsvSnapshotRepositoryV3 {
  transactionCount = 0;
  artifactBuiltInsideTransaction = false;
  readonly transaction: CsvSnapshotTransaction;

  constructor(rows: OrderPageIdentityRowV1[]) {
    this.transaction = new CsvSnapshotTransaction(rows);
  }

  async withRepeatableReadSnapshot<T>(
    read: (snapshot: EffectiveOrderCsvSnapshotTransactionV3) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    this.transaction.active = true;
    try {
      const result = await read(this.transaction);
      this.artifactBuiltInsideTransaction = Boolean(
        result
        && typeof result === "object"
        && "csv" in result
        && typeof result.csv === "string",
      );
      return result;
    } finally {
      this.transaction.active = false;
    }
  }
}

describe("CSV-02 immutable effective-order snapshot export", () => {
  it("keeps V4 bounded at 10,000 complete orders and rejects 10,001 before hydration", async () => {
    const repository = new CsvSnapshotRepository(makeRows(10_000));
    const artifact = await exportEffectiveOrderSnapshotCsvV4(repository, { scope, filters, grain: "order", batchSize: 137 });
    const rows = parseCsvRows(artifact.csv, ORDER_CSV_ORDER_V4_HEADERS);
    expect(artifact.orderCount).toBe(10_000);
    expect(new Set(rows.map((row) => row.order_id)).size).toBe(10_000);
    expect(rows.every((row) => row.payment_methods === "unknown")).toBe(true);
    expect(Math.max(...repository.transaction.projectionBatchSizes)).toBeLessThanOrEqual(137);
    const oversized = new CsvSnapshotRepository([]);
    oversized.transaction.countOverride = 10_001;
    await expect(exportEffectiveOrderSnapshotCsvV4(oversized, { scope, filters, grain: "order" }))
      .rejects.toMatchObject({ code: "async_export_required", statusCode: 413 });
    expect(oversized.transaction.rowReadCount).toBe(0);
  }, 20_000);

  it("rejects V4 incomplete hydration, currency, duplicate traversal and count drift", async () => {
    for (const mutate of [
      (repository: CsvSnapshotRepository) => { repository.transaction.missingProjection = true; },
      (repository: CsvSnapshotRepository) => { repository.transaction.paymentCurrency = "USD"; },
      (repository: CsvSnapshotRepository) => { repository.transaction.repeatPreviousRowOnSecondBatch = true; },
      (repository: CsvSnapshotRepository) => { repository.transaction.countOverride = 3; },
    ]) {
      const repository = new CsvSnapshotRepository(makeRows(2));
      mutate(repository);
      await expect(exportEffectiveOrderSnapshotCsvV4(repository, { scope, filters, grain: "order", batchSize: 1 })).rejects.toThrow();
    }
  });
  it("exports 10,000 corrected orders exactly once from one bounded repeatable-read snapshot", async () => {
    const repository = new CsvSnapshotRepository(makeRows(10_000));
    const artifact = await exportEffectiveOrderSnapshotCsvV3(repository, {
      scope,
      filters,
      grain: "order",
      batchSize: 137,
    });
    const rows = parseCsvRows(artifact.csv, ORDER_CSV_ORDER_V3_HEADERS);

    expect(repository.transactionCount).toBe(1);
    expect(repository.artifactBuiltInsideTransaction).toBe(true);
    expect(repository.transaction.readLimits.slice(0, -1).every((limit) => limit === 137))
      .toBe(true);
    expect(repository.transaction.readLimits.at(-1)).toBe(1);
    expect(Math.max(...repository.transaction.projectionBatchSizes)).toBeLessThanOrEqual(137);
    expect(Math.max(...repository.transaction.paymentBatchSizes)).toBeLessThanOrEqual(137);
    expect(artifact).toMatchObject({
      grain: "order",
      orderCount: 10_000,
      rowCount: 10_000,
      snapshot: {
        contractVersion: "orders.effective-order.v3",
        merchantId: "merchant-a",
        storeRevisions: [{ storeId: "store-a", revision: 31 }],
        asOf: "2026-08-05T00:00:00.000Z",
      },
    });
    expect(rows).toHaveLength(10_000);
    expect(rows[0]).toMatchObject({
      order_id: "order-09999",
      effective_revision: "2",
      merchandise_gross_minor: "10999",
      vat_minor: "100",
      unclassified_minor: "25",
      effective_commercial_total_minor: "11074",
      recorded_gross_collections_minor: "11074",
    });
    expect(rows.at(-1)!.order_id).toBe("order-00000");
    expect(new Set(rows.map((row) => row.order_id)).size).toBe(10_000);
    expect(rows.some((row) => row.effective_items_json.includes("REMOVED-OLD-SKU"))).toBe(false);
    expect(ORDER_CSV_ORDER_V3_HEADERS).not.toContain("customer_refund_payable_minor");
  }, 20_000);

  it("supports the effective-line grain without repeating order/payment aggregates", async () => {
    const artifact = await exportEffectiveOrderSnapshotCsvV3(
      new CsvSnapshotRepository(makeRows(2)),
      { scope, filters, grain: "effective_line", batchSize: 1 },
    );
    const rows = parseCsvRows(artifact.csv, ORDER_CSV_LINE_V3_HEADERS);

    expect(artifact).toMatchObject({ grain: "effective_line", orderCount: 2, rowCount: 2 });
    expect(rows.map((row) => row.order_id)).toEqual(["order-00001", "order-00000"]);
    expect(rows.every((row) => row.sku_snapshot === "SKU-CORRECTED")).toBe(true);
    expect(ORDER_CSV_LINE_V3_HEADERS).not.toContain("recorded_gross_collections_minor");
  });

  it("rejects an oversized selection before reading or hydrating any order", async () => {
    const repository = new CsvSnapshotRepository([]);
    repository.transaction.countOverride = EFFECTIVE_ORDER_CSV_SNAPSHOT_MAX_ORDERS_V3 + 1;

    await expect(exportEffectiveOrderSnapshotCsvV3(repository, {
      scope,
      filters,
      grain: "order",
    })).rejects.toThrow(/asynchronous export/i);
    expect(repository.transaction.rowReadCount).toBe(0);
    expect(repository.transaction.projectionBatchSizes).toEqual([]);
    expect(repository.transaction.paymentBatchSizes).toEqual([]);
  });

  it("fails closed on incomplete hydration, currency, traversal, count or revision drift", async () => {
    const cases: Array<(repository: CsvSnapshotRepository) => void> = [
      (repository) => { repository.transaction.missingProjection = true; },
      (repository) => { repository.transaction.paymentCurrency = "USD"; },
      (repository) => { repository.transaction.repeatPreviousRowOnSecondBatch = true; },
      (repository) => { repository.transaction.countOverride = 3; },
      (repository) => { repository.transaction.revisions = [{ storeId: "store-other", revision: 1 }]; },
    ];

    for (const mutate of cases) {
      const repository = new CsvSnapshotRepository(makeRows(2));
      mutate(repository);
      await expect(exportEffectiveOrderSnapshotCsvV3(repository, {
        scope,
        filters,
        grain: "order",
        batchSize: 1,
      })).rejects.toThrow();
    }
  });
});
