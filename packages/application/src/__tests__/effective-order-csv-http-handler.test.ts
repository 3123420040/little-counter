import { describe, expect, it } from "vitest";
import {
  ORDER_CSV_ORDER_V3_HEADERS,
  permissions,
  type EffectiveOrderV1,
} from "@medusa-snus/contracts";
import { parseCsvRows } from "../services/csv-parse-service";
import {
  handleEffectiveOrderCsvHttpV3,
  type EffectiveOrderCsvHttpHandlerDependenciesV3,
} from "../services/effective-order-csv-http-handler";
import type {
  EffectiveOrderCsvSnapshotRepositoryV3,
  EffectiveOrderCsvSnapshotTransactionV3,
} from "../services/effective-order-csv-snapshot-export-service";
import { normalizeOrderCursorFiltersV1 } from "../services/order-cursor-service";

const reportScope = {
  scopeKind: "report" as const,
  merchantId: "merchant-a",
  storeIds: ["store-a"],
};
const filters = normalizeOrderCursorFiltersV1({
  statusMode: "completed",
  search: "ord-1",
  storeWindows: [
    {
      storeId: "store-a",
      startInclusive: "2026-08-01T00:00:00.000Z",
      endExclusive: "2026-08-06T00:00:00.000Z",
    },
  ],
});
const correctedOrder: EffectiveOrderV1 = {
  schemaVersion: 1,
  orderId: "order-1",
  currencyCode: "VND",
  minorUnitExponent: 0,
  effectiveRevision: 3,
  commercialState: "active",
  lines: [
    {
      lineId: "line-corrected",
      productId: "product-corrected",
      variantId: "variant-corrected",
      skuSnapshot: "SKU-CORRECTED",
      titleSnapshot: "Corrected item",
      quantity: 1,
      unitPriceMinor: 1_000,
      archivedVariant: false,
    },
  ],
  components: {
    taxMode: "exclusive",
    merchandiseGrossMinor: 1_000,
    discountMinor: 0,
    merchandiseNetMinor: 1_000,
    shippingMinor: 50,
    merchandiseVatMinor: 200,
    shippingVatMinor: 0,
    vatMinor: 200,
    unclassifiedMinor: 15,
    totalMinor: 1_265,
  },
  currentOrderGrossValueMinor: 1_265,
  dataQuality: {
    status: "complete",
    costCoverage: { knownLines: 1, totalLines: 1 },
    warnings: [],
  },
};

class HttpSnapshotTransaction implements EffectiveOrderCsvSnapshotTransactionV3 {
  rowReads = 0;
  count = 1;

  async readAsOf() {
    return "2026-08-05T00:00:00.000Z";
  }

  async readStoreRevisionVector() {
    return [{ storeId: "store-a", revision: 44 }];
  }

  async countRows() {
    return this.count;
  }

  async readRows(
    input: Parameters<EffectiveOrderCsvSnapshotTransactionV3["readRows"]>[0],
  ) {
    this.rowReads += 1;
    if (input.after) return [];
    return [
      {
        merchantId: "merchant-a",
        storeId: "store-a",
        orderId: "order-1",
        orderNumber: "ORD-1",
        status: "completed",
        currencyCode: "VND",
        createdAt: "2026-08-04T00:00:00.000Z",
      },
    ];
  }

  async readEffectiveOrders() {
    return [correctedOrder];
  }

  async readPaymentSummaries() {
    return [
      {
        orderId: "order-1",
        currencyCode: "VND",
        recordedGrossCollectionsMinor: 1_265,
        refundsMinor: 0,
        reversalsMinor: 0,
        chargebacksMinor: 0,
        negativeCollectionsMinor: 0,
        netCollectionsMinor: 1_265,
      },
    ];
  }
}

class HttpSnapshotRepository implements EffectiveOrderCsvSnapshotRepositoryV3 {
  transactionCount = 0;
  readonly transaction = new HttpSnapshotTransaction();

  async withRepeatableReadSnapshot<T>(
    read: (snapshot: EffectiveOrderCsvSnapshotTransactionV3) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    return read(this.transaction);
  }
}

function dependencies(enabled: boolean | undefined = true) {
  const repository = new HttpSnapshotRepository();
  const value: EffectiveOrderCsvHttpHandlerDependenciesV3 = {
    repository,
    ...(enabled === undefined ? {} : { config: { enabled } }),
  };
  return { repository, value };
}

function request() {
  return {
    authorization: {
      permission: permissions.ordersExport,
      scope: reportScope,
    },
    filters,
    grain: "order" as const,
  };
}

describe("CSV-03 default-off v3 HTTP application handler", () => {
  it("is disabled by default and never opens a repository snapshot", async () => {
    const repository = new HttpSnapshotRepository();
    const value: EffectiveOrderCsvHttpHandlerDependenciesV3 = { repository };

    await expect(
      handleEffectiveOrderCsvHttpV3(value, request()),
    ).rejects.toMatchObject({
      code: "feature_disabled",
      statusCode: 403,
    });
    expect(repository.transactionCount).toBe(0);
  });

  it("requires the exact orders:export authorization context before reading", async () => {
    const { repository, value } = dependencies();
    const invalid = request();
    invalid.authorization.permission = permissions.ordersRead as never;

    await expect(
      handleEffectiveOrderCsvHttpV3(value, invalid),
    ).rejects.toMatchObject({
      code: "forbidden",
      statusCode: 403,
    });
    expect(repository.transactionCount).toBe(0);
  });

  it("returns a safe no-store v3 download contract with corrected VAT-inclusive values", async () => {
    const { repository, value } = dependencies();
    const response = await handleEffectiveOrderCsvHttpV3(value, request());
    const [row] = parseCsvRows(response.body, ORDER_CSV_ORDER_V3_HEADERS);

    expect(repository.transactionCount).toBe(1);
    expect(response).toMatchObject({
      statusCode: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition":
          'attachment; filename="orders-effective-order-20260805T000000Z.csv"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Order-Export-Contract": "orders.effective-order.v3",
        "X-Order-Export-Grain": "order",
        "X-Order-Export-As-Of": "2026-08-05T00:00:00.000Z",
        "X-Order-Export-Order-Count": "1",
        "X-Order-Export-Row-Count": "1",
        "X-Order-Export-Content-Length": String(
          Buffer.byteLength(response.body),
        ),
      },
    });
    expect(response.headers["X-Order-Export-Revision-SHA256"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(response.headers["Content-Length"]).toBe(
      String(Buffer.byteLength(response.body)),
    );
    expect(row).toMatchObject({
      order_id: "order-1",
      effective_revision: "3",
      tax_mode: "exclusive",
      merchandise_vat_minor: "200",
      shipping_vat_minor: "0",
      vat_minor: "200",
      unclassified_minor: "15",
      effective_commercial_total_minor: "1265",
      recorded_gross_collections_minor: "1265",
    });
  });

  it("rejects filter/scope drift before opening a snapshot", async () => {
    const { repository, value } = dependencies();
    const invalid = request();
    invalid.filters = normalizeOrderCursorFiltersV1({
      statusMode: "completed",
      storeWindows: [
        {
          storeId: "store-other",
          startInclusive: "2026-08-01T00:00:00.000Z",
          endExclusive: "2026-08-06T00:00:00.000Z",
        },
      ],
    });

    await expect(
      handleEffectiveOrderCsvHttpV3(value, invalid),
    ).rejects.toMatchObject({
      code: "validation_error",
      statusCode: 400,
    });
    expect(repository.transactionCount).toBe(0);
  });

  it("maps the synchronous ceiling to an explicit 413 without partial row reads", async () => {
    const { repository, value } = dependencies();
    repository.transaction.count = 10_001;

    await expect(
      handleEffectiveOrderCsvHttpV3(value, request()),
    ).rejects.toMatchObject({
      code: "async_export_required",
      statusCode: 413,
      details: { selectedOrderCount: 10_001, maximumOrderCount: 10_000 },
    });
    expect(repository.transaction.rowReads).toBe(0);
  });
});
