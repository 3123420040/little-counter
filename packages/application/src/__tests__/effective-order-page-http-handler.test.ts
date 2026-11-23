import { describe, expect, it } from "vitest";
import {
  permissions,
  type EffectiveOrderPageCurrencyAggregateV2,
  type EffectiveOrderV1,
} from "@medusa-snus/contracts";
import {
  handleEffectiveOrderPageHttpV2,
  type EffectiveOrderPageHttpHandlerDependenciesV2,
} from "../services/effective-order-page-http-handler";
import type {
  EffectiveOrderPagePaymentSummaryV2,
  EffectiveOrderPageSnapshotRepositoryV2,
  EffectiveOrderPageSnapshotTransactionV2,
} from "../services/effective-order-page-service";
import { normalizeOrderCursorFiltersV1 } from "../services/order-cursor-service";

const reportScope = {
  scopeKind: "report" as const,
  merchantId: "merchant-a",
  storeIds: ["store-a"],
};
const filters = normalizeOrderCursorFiltersV1({
  statusMode: "all",
  storeWindows: [{
    storeId: "store-a",
    startInclusive: "2026-08-01T00:00:00.000Z",
    endExclusive: "2026-08-06T00:00:00.000Z",
  }],
});
const keyring = {
  current: {
    keyId: "page-http-current",
    keyBase64Url: Buffer.alloc(32, 28).toString("base64url"),
  },
};

function effectiveOrder(orderId: string, totalMinor: number): EffectiveOrderV1 {
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
      unitPriceMinor: totalMinor,
      archivedVariant: false,
    }],
    components: {
      taxMode: "exclusive",
      merchandiseGrossMinor: totalMinor,
      discountMinor: 0,
      merchandiseNetMinor: totalMinor,
      shippingMinor: 0,
      merchandiseVatMinor: 0,
      shippingVatMinor: 0,
      vatMinor: 0,
      unclassifiedMinor: 0,
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

const identityRows = [
  {
    merchantId: "merchant-a",
    storeId: "store-a",
    orderId: "order-b",
    orderNumber: "ORD-B",
    status: "completed",
    currencyCode: "VND",
    createdAt: "2026-08-04T12:00:00.000Z",
  },
  {
    merchantId: "merchant-a",
    storeId: "store-a",
    orderId: "order-a",
    orderNumber: "ORD-A",
    status: "completed",
    currencyCode: "VND",
    createdAt: "2026-08-04T11:00:00.000Z",
  },
];

class PageHttpTransaction implements EffectiveOrderPageSnapshotTransactionV2 {
  constructor(private readonly owner: PageHttpRepository) {}

  async readAsOf() {
    return "2026-08-05T00:00:00.000Z";
  }

  async readStoreRevisionVector() {
    return [{ storeId: "store-a", revision: this.owner.revision }];
  }

  async readRows(
    input: Parameters<EffectiveOrderPageSnapshotTransactionV2["readRows"]>[0],
  ) {
    const rows = identityRows.filter((row) => !input.after
      || row.createdAt < input.after.createdAt
      || (row.createdAt === input.after.createdAt && row.orderId < input.after.id));
    return rows.slice(0, input.limit);
  }

  async countRows() {
    return identityRows.length;
  }

  async readEffectiveOrders(
    input: Parameters<EffectiveOrderPageSnapshotTransactionV2["readEffectiveOrders"]>[0],
  ) {
    return input.orderIds.map((orderId) =>
      effectiveOrder(orderId, orderId === "order-b" ? 3_000 : 2_000));
  }

  async readPaymentSummaries(
    input: Parameters<EffectiveOrderPageSnapshotTransactionV2["readPaymentSummaries"]>[0],
  ): Promise<EffectiveOrderPagePaymentSummaryV2[]> {
    return input.orderIds.map((orderId) => {
      const gross = orderId === "order-b" ? 3_000 : 2_000;
      return {
        orderId,
        currencyCode: "VND",
        recordedGrossCollectionsMinor: gross,
        refundsMinor: 0,
        reversalsMinor: 0,
        chargebacksMinor: 0,
        negativeCollectionsMinor: 0,
        netCollectionsMinor: gross,
        customerRefundPayableMinor: 0,
      };
    });
  }

  async readCurrencyAggregates(): Promise<EffectiveOrderPageCurrencyAggregateV2[]> {
    return [{
      currencyCode: "VND",
      minorUnitExponent: 0,
      orderCount: 2,
      activeOrderCount: 2,
      cancelledOrderCount: 0,
      currentOrderGrossValueMinor: 5_000,
      recordedGrossCollectionsMinor: 5_000,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      netCollectionsMinor: 5_000,
    }];
  }
}

class PageHttpRepository implements EffectiveOrderPageSnapshotRepositoryV2 {
  transactionCount = 0;
  revision = 17;

  async withRepeatableReadSnapshot<T>(
    read: (snapshot: EffectiveOrderPageSnapshotTransactionV2) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    return read(new PageHttpTransaction(this));
  }
}

function dependencies(enabled = true) {
  const repository = new PageHttpRepository();
  const value: EffectiveOrderPageHttpHandlerDependenciesV2 = {
    repository,
    keyring,
    config: { enabled },
  };
  return { repository, value };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    authorization: {
      permission: permissions.ordersRead,
      scope: reportScope,
    },
    filters,
    limit: 50,
    nowEpochSeconds: 1_800_000_000,
    ...overrides,
  };
}

describe("PAGE-02A default-off effective order list HTTP handler", () => {
  it("is disabled by default before repository/key use", async () => {
    const repository = new PageHttpRepository();
    const value: EffectiveOrderPageHttpHandlerDependenciesV2 = { repository, keyring };

    await expect(handleEffectiveOrderPageHttpV2(value, request())).rejects.toMatchObject({
      code: "feature_disabled",
      statusCode: 403,
    });
    expect(repository.transactionCount).toBe(0);
  });

  it("requires exact orders:read authorization before repository access", async () => {
    const { repository, value } = dependencies();
    const invalid = request();
    invalid.authorization.permission = permissions.ordersExport as never;

    await expect(handleEffectiveOrderPageHttpV2(value, invalid)).rejects.toMatchObject({
      code: "forbidden",
      statusCode: 403,
    });
    expect(repository.transactionCount).toBe(0);
  });

  it("rejects filter/store mismatch before repository access", async () => {
    const { repository, value } = dependencies();
    const invalidFilters = normalizeOrderCursorFiltersV1({
      statusMode: "all",
      storeWindows: [{
        storeId: "store-other",
        startInclusive: "2026-08-01T00:00:00.000Z",
        endExclusive: "2026-08-06T00:00:00.000Z",
      }],
    });

    await expect(handleEffectiveOrderPageHttpV2(value, request({ filters: invalidFilters })))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    expect(repository.transactionCount).toBe(0);
  });

  it("rejects an empty cursor and invalid key configuration before repository access", async () => {
    const invalidQuery = dependencies();
    await expect(handleEffectiveOrderPageHttpV2(
      invalidQuery.value,
      request({ cursor: "" }),
    )).rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    expect(invalidQuery.repository.transactionCount).toBe(0);

    const invalidKey = dependencies();
    invalidKey.value.keyring = {
      current: {
        keyId: "weak-key",
        keyBase64Url: Buffer.alloc(16).toString("base64url"),
      },
    };
    await expect(handleEffectiveOrderPageHttpV2(invalidKey.value, request()))
      .rejects.toMatchObject({ code: "feature_unavailable", statusCode: 503 });
    expect(invalidKey.repository.transactionCount).toBe(0);
  });

  it("returns corrected orders and explicit commercial/collection aggregates", async () => {
    const { repository, value } = dependencies();
    const response = await handleEffectiveOrderPageHttpV2(value, request());

    expect(repository.transactionCount).toBe(1);
    expect(response).toMatchObject({
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Order-List-Contract": "orders.effective-page.v2",
        "X-Order-List-As-Of": "2026-08-05T00:00:00.000Z",
        "X-Order-List-Total-Count": "2",
        "X-Order-List-Row-Count": "2",
      },
      body: {
        schemaVersion: 2,
        pagination: { hasMore: false, nextCursor: null, totalCount: 2 },
        currencies: [{
          currentOrderGrossValueMinor: 5_000,
          recordedGrossCollectionsMinor: 5_000,
          netCollectionsMinor: 5_000,
        }],
      },
    });
    expect(response.body.data[0]).toMatchObject({
      sourceOrder: { orderId: "order-b" },
      order: { effectiveRevision: 2, currentOrderGrossValueMinor: 3_000 },
      recordedGrossCollectionsMinor: 3_000,
    });
  });

  it("maps malformed cursors to a non-leaking refresh response", async () => {
    const { value } = dependencies();

    await expect(handleEffectiveOrderPageHttpV2(value, request({ cursor: "not-a-cursor" })))
      .rejects.toMatchObject({
        code: "invalid_cursor",
        statusCode: 400,
        details: { refreshFromStart: true },
      });
  });

  it("maps a changed selected-store revision to stale_cursor", async () => {
    const { repository, value } = dependencies();
    const first = await handleEffectiveOrderPageHttpV2(value, request({ limit: 1 }));
    repository.revision += 1;

    try {
      await handleEffectiveOrderPageHttpV2(value, request({
        limit: 1,
        cursor: first.body.pagination.nextCursor,
        nowEpochSeconds: 1_800_000_001,
      }));
      throw new Error("expected stale cursor");
    } catch (error) {
      expect(error).toMatchObject({
        code: "stale_cursor",
        statusCode: 409,
        details: { refreshFromStart: true },
      });
      expect(JSON.stringify(error)).not.toContain("merchant-a");
    }
  });
});
