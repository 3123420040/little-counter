import { describe, expect, it } from "vitest";
import type { EffectiveOrderPageStateV2 } from "./effectiveOrderPageState";
import { createEffectiveOrderPageStateV2 } from "./effectiveOrderPageState";
import { presentEffectiveOrderPageV2 } from "./effectiveOrderPagePresentation";

function orderRow(orderId: string, amount: number) {
  return {
    sourceOrder: {
      merchantId: "merchant-a",
      storeId: "store-a",
      orderId,
      orderNumber: `ORD-${orderId}`,
      status: "completed",
    },
    customerAttribution: "unknown" as const,
    customer: null,
    order: {
      schemaVersion: 1 as const,
      orderId,
      currencyCode: "VND",
      minorUnitExponent: 0,
      effectiveRevision: 2,
      commercialState: "active" as const,
      lines: [{
        lineId: `${orderId}:line`,
        productId: `${orderId}:product`,
        variantId: `${orderId}:variant`,
        skuSnapshot: `SKU-${orderId}`,
        titleSnapshot: "Corrected item",
        quantity: 1,
        unitPriceMinor: amount,
        archivedVariant: false,
      }],
      components: {
        taxMode: "exclusive" as const,
        merchandiseGrossMinor: amount,
        discountMinor: 0,
        merchandiseNetMinor: amount,
        shippingMinor: 0,
        merchandiseVatMinor: 0,
        shippingVatMinor: 0,
        vatMinor: 0,
        unclassifiedMinor: 0,
        totalMinor: amount,
      },
      currentOrderGrossValueMinor: amount,
      dataQuality: {
        status: "complete" as const,
        costCoverage: { knownLines: 1, totalLines: 1 },
        warnings: [],
      },
    },
    createdAt: "2026-08-05T00:00:00.000Z",
    recordedGrossCollectionsMinor: amount,
    refundsMinor: 0,
    reversalsMinor: 0,
    chargebacksMinor: 0,
    negativeCollectionsMinor: 0,
    netCollectionsMinor: amount,
    customerRefundPayableMinor: 0,
  };
}

function state(
  status: EffectiveOrderPageStateV2["status"],
  options: {
    rows?: ReturnType<typeof orderRow>[];
    totalCount?: number;
    hasMore?: boolean;
    nextCursor?: string | null;
    activeMode?: "first" | "next";
    refreshReason?: EffectiveOrderPageStateV2["refreshReason"];
  } = {},
): EffectiveOrderPageStateV2 {
  const rows = options.rows ?? [];
  const totalCount = options.totalCount ?? rows.length;
  const aggregate = totalCount === 2 ? 5_000 : rows.reduce(
    (sum, item) => sum + item.recordedGrossCollectionsMinor,
    0,
  );
  return {
    status,
    queryKey: status === "disabled" || status === "idle" ? null : "query-a",
    rows,
    currencies: totalCount === 0 ? [] : [{
      currencyCode: "VND",
      minorUnitExponent: 0,
      orderCount: totalCount,
      activeOrderCount: totalCount,
      cancelledOrderCount: 0,
      currentOrderGrossValueMinor: aggregate,
      recordedGrossCollectionsMinor: aggregate,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      netCollectionsMinor: aggregate,
    }],
    snapshotAsOf: rows.length > 0 || status === "empty"
      ? "2026-08-05T00:00:01.000Z"
      : null,
    totalCount,
    hasMore: options.hasMore ?? false,
    nextCursor: options.nextCursor ?? null,
    activeRequest: options.activeMode ? {
      requestId: "request-active",
      queryKey: "query-a",
      mode: options.activeMode,
    } : null,
    refreshReason: options.refreshReason ?? null,
    error: status === "error" ? "Network unavailable" : null,
  };
}

describe("PAGE-02E inactive effective-order presentation selector", () => {
  it("presents disabled state with no rows, money or actions", () => {
    expect(presentEffectiveOrderPageV2(createEffectiveOrderPageStateV2())).toEqual({
      status: "disabled",
      completeness: "unavailable",
      loadedCount: 0,
      totalCount: 0,
      rows: [],
      headlines: [],
      issue: null,
      actions: { canLoadNext: false, canRetryNext: false, mustRefreshFromStart: false },
    });
  });

  it("presents an exact empty result as complete", () => {
    expect(presentEffectiveOrderPageV2(state("empty"))).toMatchObject({
      status: "empty",
      completeness: "complete",
      loadedCount: 0,
      totalCount: 0,
      issue: null,
    });
  });

  it("keeps loaded count separate from total and copies aggregate money once", () => {
    const view = presentEffectiveOrderPageV2(state("ready", {
      rows: [orderRow("order-a", 2_000)],
      totalCount: 2,
      hasMore: true,
      nextCursor: "cursor-2",
    }));

    expect(view).toMatchObject({
      completeness: "partial",
      loadedCount: 1,
      totalCount: 2,
      actions: { canLoadNext: true, canRetryNext: false, mustRefreshFromStart: false },
      headlines: [{
        currencyCode: "VND",
        currentOrderValue: {
          label: "Current order value (includes VAT and charged components)",
          minor: 5_000,
        },
        grossRecordedCollection: {
          label: "Gross recorded collection (includes VAT and charged components)",
          minor: 5_000,
        },
        negativeCollection: { minor: 0 },
        netRecordedCollection: { minor: 5_000 },
      }],
    });
  });

  it("marks an exact terminal page complete without page-level multiplication", () => {
    const view = presentEffectiveOrderPageV2(state("ready", {
      rows: [orderRow("order-a", 2_000), orderRow("order-b", 3_000)],
      totalCount: 2,
    }));
    expect(view).toMatchObject({
      completeness: "complete",
      loadedCount: 2,
      totalCount: 2,
      headlines: [{ grossRecordedCollection: { minor: 5_000 } }],
      actions: { canLoadNext: false },
    });
  });

  it("labels in-flight and failed next pages as partial with exact actions", () => {
    const rows = [orderRow("order-a", 2_000)];
    const loading = presentEffectiveOrderPageV2(state("loading", {
      rows,
      totalCount: 2,
      hasMore: true,
      nextCursor: "cursor-2",
      activeMode: "next",
    }));
    expect(loading).toMatchObject({ completeness: "partial", actions: { canLoadNext: false, canRetryNext: false } });

    const failed = presentEffectiveOrderPageV2(state("error", {
      rows,
      totalCount: 2,
      hasMore: true,
      nextCursor: "cursor-2",
    }));
    expect(failed).toMatchObject({
      completeness: "partial",
      issue: "page_load_failed",
      actions: { canLoadNext: false, canRetryNext: true },
    });
  });

  it("shows refresh-required as unavailable and never exposes discarded money", () => {
    expect(presentEffectiveOrderPageV2(state("refresh_required", {
      refreshReason: "stale_cursor",
    }))).toMatchObject({
      completeness: "unavailable",
      rows: [],
      headlines: [],
      issue: "stale_cursor",
      actions: { mustRefreshFromStart: true },
    });
  });

  it("fails closed for forged duplicate rows or aggregate totals", () => {
    const duplicate = state("ready", {
      rows: [orderRow("order-a", 2_000), orderRow("order-a", 2_000)],
      totalCount: 2,
    });
    const aggregateDrift = state("ready", {
      rows: [orderRow("order-a", 2_000)],
      totalCount: 1,
    });
    aggregateDrift.currencies[0]!.orderCount = 2;

    for (const forged of [duplicate, aggregateDrift]) {
      expect(presentEffectiveOrderPageV2(forged)).toMatchObject({
        completeness: "unavailable",
        loadedCount: 0,
        rows: [],
        headlines: [],
        issue: "state_invariant_violation",
      });
    }
  });
});
