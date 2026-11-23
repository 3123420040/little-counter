import { describe, expect, it } from "vitest";
import type { EffectiveOrderPageV3, EffectiveOrderV1 } from "@medusa-snus/contracts";
import {
  createEffectiveOrderPageStateV2,
  reduceEffectiveOrderPageStateV2,
} from "./effectiveOrderPageState";

function effectiveOrder(orderId: string, totalMinor: number): EffectiveOrderV1 {
  return {
    schemaVersion: 1,
    orderId,
    currencyCode: "VND",
    minorUnitExponent: 0,
    effectiveRevision: 2,
    commercialState: "active",
    lines: [{
      lineId: `${orderId}:line`,
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

function page(
  orderIds: string[],
  options: {
    totalCount?: number;
    asOf?: string;
    nextCursor?: string | null;
    aggregateGross?: number;
  } = {},
): EffectiveOrderPageV3 {
  const totalCount = options.totalCount ?? 2;
  const nextCursor = options.nextCursor ?? null;
  const aggregateGross = options.aggregateGross ?? 5_000;
  return {
    schemaVersion: 3,
    data: orderIds.map((orderId) => {
      const gross = orderId === "order-b" ? 3_000 : 2_000;
      return {
        sourceOrder: {
          merchantId: "merchant-a",
          storeId: "store-a",
          orderId,
          orderNumber: `ORD-${orderId}`,
          status: "completed",
        },
        customerAttribution: "unknown",
        customer: null,
        order: effectiveOrder(orderId, gross),
        createdAt: orderId === "order-b"
          ? "2026-08-04T12:00:00.000Z"
          : "2026-08-04T11:00:00.000Z",
        recordedGrossCollectionsMinor: gross,
        refundsMinor: 0,
        reversalsMinor: 0,
        chargebacksMinor: 0,
        negativeCollectionsMinor: 0,
        netCollectionsMinor: gross,
        customerRefundPayableMinor: 0,
      };
    }),
    pagination: {
      limit: 1,
      hasMore: nextCursor !== null,
      nextCursor,
      asOf: options.asOf ?? "2026-08-05T00:00:00.000Z",
      totalCount,
    },
    currencies: [{
      currencyCode: "VND",
      minorUnitExponent: 0,
      orderCount: totalCount,
      activeOrderCount: totalCount,
      cancelledOrderCount: 0,
      currentOrderGrossValueMinor: aggregateGross,
      recordedGrossCollectionsMinor: aggregateGross,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      netCollectionsMinor: aggregateGross,
    }],
  };
}

function beginFirst(queryKey = "scope/filter-a", requestId = "request-1") {
  return {
    type: "request_started" as const,
    requestId,
    queryKey,
    mode: "first" as const,
  };
}

describe("PAGE-02B inactive POS effective-order pagination state", () => {
  it("is disabled by default and requires an explicit enabled capability", () => {
    expect(createEffectiveOrderPageStateV2()).toMatchObject({ status: "disabled", rows: [] });
    expect(createEffectiveOrderPageStateV2({ enabled: true })).toMatchObject({
      status: "idle",
      rows: [],
    });
  });

  it("loads a corrected first page with explicit aggregate/snapshot state", () => {
    let state = createEffectiveOrderPageStateV2({ enabled: true });
    state = reduceEffectiveOrderPageStateV2(state, beginFirst());
    state = reduceEffectiveOrderPageStateV2(state, {
      type: "request_succeeded",
      requestId: "request-1",
      page: page(["order-b"], { nextCursor: "cursor-2" }),
    });

    expect(state).toMatchObject({
      status: "ready",
      queryKey: "scope/filter-a",
      snapshotAsOf: "2026-08-05T00:00:00.000Z",
      totalCount: 2,
      hasMore: true,
      nextCursor: "cursor-2",
      rows: [{
        sourceOrder: { orderId: "order-b" },
        order: { effectiveRevision: 2, currentOrderGrossValueMinor: 3_000 },
        recordedGrossCollectionsMinor: 3_000,
      }],
      currencies: [{
        currentOrderGrossValueMinor: 5_000,
        recordedGrossCollectionsMinor: 5_000,
      }],
    });
  });

  it("appends a terminal page exactly once without multiplying aggregates", () => {
    let state = createEffectiveOrderPageStateV2({ enabled: true });
    state = reduceEffectiveOrderPageStateV2(state, beginFirst());
    state = reduceEffectiveOrderPageStateV2(state, {
      type: "request_succeeded",
      requestId: "request-1",
      page: page(["order-b"], { nextCursor: "cursor-2" }),
    });
    state = reduceEffectiveOrderPageStateV2(state, {
      type: "request_started",
      requestId: "request-2",
      queryKey: "scope/filter-a",
      mode: "next",
    });
    state = reduceEffectiveOrderPageStateV2(state, {
      type: "request_succeeded",
      requestId: "request-2",
      page: page(["order-a"]),
    });

    expect(state.status).toBe("ready");
    expect(state.rows.map((row) => row.sourceOrder.orderId)).toEqual(["order-b", "order-a"]);
    expect(state.currencies).toHaveLength(1);
    expect(state.currencies[0]!.recordedGrossCollectionsMinor).toBe(5_000);
    expect(state).toMatchObject({ hasMore: false, nextCursor: null, totalCount: 2 });
  });

  it("clears old rows on filter change and ignores a superseded response", () => {
    let state = createEffectiveOrderPageStateV2({ enabled: true });
    state = reduceEffectiveOrderPageStateV2(state, beginFirst("filter-a", "request-old"));
    state = reduceEffectiveOrderPageStateV2(state, beginFirst("filter-b", "request-new"));
    state = reduceEffectiveOrderPageStateV2(state, {
      type: "refresh_required",
      requestId: "request-old",
      reason: "stale_cursor",
    });
    state = reduceEffectiveOrderPageStateV2(state, {
      type: "request_succeeded",
      requestId: "request-old",
      page: page(["order-b"], { nextCursor: "cursor-old" }),
    });

    expect(state).toMatchObject({
      status: "loading",
      queryKey: "filter-b",
      rows: [],
      activeRequest: { requestId: "request-new" },
    });
  });

  it("discards every accumulated page for invalid/expired/stale cursor refresh", () => {
    for (const reason of ["invalid_cursor", "expired_cursor", "stale_cursor"] as const) {
      let state = createEffectiveOrderPageStateV2({ enabled: true });
      state = reduceEffectiveOrderPageStateV2(state, beginFirst());
      state = reduceEffectiveOrderPageStateV2(state, {
        type: "request_succeeded",
        requestId: "request-1",
        page: page(["order-b"], { nextCursor: "cursor-2" }),
      });
      state = reduceEffectiveOrderPageStateV2(state, {
        type: "request_started",
        requestId: "request-2",
        queryKey: "scope/filter-a",
        mode: "next",
      });
      state = reduceEffectiveOrderPageStateV2(state, {
        type: "refresh_required",
        requestId: "request-2",
        reason,
      });

      expect(state).toMatchObject({
        status: "refresh_required",
        refreshReason: reason,
        rows: [],
        currencies: [],
        nextCursor: null,
        snapshotAsOf: null,
      });
    }
  });

  it("fails closed and clears pages on duplicate/snapshot/aggregate/terminal drift", () => {
    const mutations: Array<(value: EffectiveOrderPageV3) => EffectiveOrderPageV3> = [
      (value) => ({ ...value, data: page(["order-b"]).data }),
      (value) => ({ ...value, pagination: { ...value.pagination, asOf: "2026-08-05T00:00:01.000Z" } }),
      (value) => ({
        ...value,
        currencies: value.currencies.map((item) => ({
          ...item,
          currentOrderGrossValueMinor: 5_001,
          recordedGrossCollectionsMinor: 5_001,
          netCollectionsMinor: 5_001,
        })),
      }),
      (value) => ({ ...value, pagination: { ...value.pagination, totalCount: 3 } }),
    ];

    for (const mutate of mutations) {
      let state = createEffectiveOrderPageStateV2({ enabled: true });
      state = reduceEffectiveOrderPageStateV2(state, beginFirst());
      state = reduceEffectiveOrderPageStateV2(state, {
        type: "request_succeeded",
        requestId: "request-1",
        page: page(["order-b"], { nextCursor: "cursor-2" }),
      });
      state = reduceEffectiveOrderPageStateV2(state, {
        type: "request_started",
        requestId: "request-2",
        queryKey: "scope/filter-a",
        mode: "next",
      });
      state = reduceEffectiveOrderPageStateV2(state, {
        type: "request_succeeded",
        requestId: "request-2",
        page: mutate(page(["order-a"])),
      });

      expect(state).toMatchObject({
        status: "refresh_required",
        refreshReason: "snapshot_drift",
        rows: [],
        currencies: [],
      });
    }
  });

  it("keeps an explicitly partial page on next-page network failure", () => {
    let state = createEffectiveOrderPageStateV2({ enabled: true });
    state = reduceEffectiveOrderPageStateV2(state, beginFirst());
    state = reduceEffectiveOrderPageStateV2(state, {
      type: "request_succeeded",
      requestId: "request-1",
      page: page(["order-b"], { nextCursor: "cursor-2" }),
    });
    state = reduceEffectiveOrderPageStateV2(state, {
      type: "request_started",
      requestId: "request-2",
      queryKey: "scope/filter-a",
      mode: "next",
    });
    state = reduceEffectiveOrderPageStateV2(state, {
      type: "request_failed",
      requestId: "request-2",
      message: "Network unavailable",
    });

    expect(state).toMatchObject({
      status: "error",
      error: "Network unavailable",
      rows: [{ sourceOrder: { orderId: "order-b" } }],
      hasMore: true,
    });
  });
});
