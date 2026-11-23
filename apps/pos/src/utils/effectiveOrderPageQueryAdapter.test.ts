import { describe, expect, it, vi } from "vitest";
import type { EffectiveOrderPageV3 } from "@medusa-snus/contracts";
import {
  EffectiveOrderPageQueryAdapterErrorV2,
  createEffectiveOrderPageQueryTaskV2,
} from "./effectiveOrderPageQueryAdapter";

function page(overrides: Partial<EffectiveOrderPageV3> = {}): EffectiveOrderPageV3 {
  return {
    schemaVersion: 3,
    data: [{
      sourceOrder: {
        merchantId: "merchant-a",
        storeId: "store-a",
        orderId: "order-a",
        orderNumber: "ORD-A",
        status: "completed",
      },
      customerAttribution: "linked",
      customer: {
        id: "customer-a",
        firstName: "An",
        lastName: "Nguyen",
        phone: "0900000000",
      },
      order: {
        schemaVersion: 1,
        orderId: "order-a",
        currencyCode: "VND",
        minorUnitExponent: 0,
        effectiveRevision: 2,
        commercialState: "active",
        lines: [{
          lineId: "line-a",
          productId: "product-a",
          variantId: "variant-a",
          skuSnapshot: "SKU-A",
          titleSnapshot: "Corrected item",
          quantity: 1,
          unitPriceMinor: 10_000,
          archivedVariant: false,
        }],
        components: {
          taxMode: "exclusive" as const,
          merchandiseGrossMinor: 10_000,
          discountMinor: 0,
          merchandiseNetMinor: 10_000,
          shippingMinor: 1_000,
          merchandiseVatMinor: 900,
          shippingVatMinor: 0,
          vatMinor: 900,
          unclassifiedMinor: 100,
          totalMinor: 12_000,
        },
        currentOrderGrossValueMinor: 12_000,
        dataQuality: {
          status: "complete",
          costCoverage: { knownLines: 1, totalLines: 1 },
          warnings: [],
        },
      },
      createdAt: "2026-08-05T00:00:00.000Z",
      recordedGrossCollectionsMinor: 12_000,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      netCollectionsMinor: 12_000,
      customerRefundPayableMinor: 0,
    }],
    pagination: {
      limit: 50,
      hasMore: false,
      nextCursor: null,
      asOf: "2026-08-05T00:00:01.000Z",
      totalCount: 1,
    },
    currencies: [{
      currencyCode: "VND",
      minorUnitExponent: 0,
      orderCount: 1,
      activeOrderCount: 1,
      cancelledOrderCount: 0,
      currentOrderGrossValueMinor: 12_000,
      recordedGrossCollectionsMinor: 12_000,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      netCollectionsMinor: 12_000,
    }],
    ...overrides,
  };
}

const baseInput = {
  requestId: "request-1",
  mode: "first" as const,
  scope: {
    scopeKind: "report" as const,
    merchantId: "merchant-a",
    storeIds: ["store-a"],
  },
  filters: {
    search: "  ORD-A   ",
    statusMode: "completed" as const,
    storeWindows: [{
      storeId: "store-a",
      startInclusive: "2026-08-04T00:00:00.000Z",
      endExclusive: "2026-08-06T00:00:00.000Z",
    }],
  },
  nowEpochSeconds: 1_786_000_000,
};

describe("PAGE-02C inactive POS effective-order query adapter", () => {
  it("is default-off before input validation and never calls transport", async () => {
    const transport = vi.fn();
    const task = createEffectiveOrderPageQueryTaskV2({ transport }, {
      ...baseInput,
      requestId: "",
    });

    expect(task).toEqual({
      enabled: false,
      initialEvent: { type: "capability_disabled" },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("normalizes exact filters into a deterministic first-page task", async () => {
    const transport = vi.fn().mockResolvedValue(page());
    const task = createEffectiveOrderPageQueryTaskV2(
      { config: { enabled: true }, transport },
      baseInput,
    );
    if (!task.enabled) throw new Error("expected enabled task");

    expect(task.queryKey).toBe(
      "orders.effective-page.v3:{\"merchantId\":\"merchant-a\",\"storeIds\":[\"store-a\"],\"filters\":{\"searchMode\":\"order_or_customer_identity\",\"search\":\"ord-a\",\"statusMode\":\"completed\",\"storeWindows\":[{\"storeId\":\"store-a\",\"startInclusive\":\"2026-08-04T00:00:00.000Z\",\"endExclusive\":\"2026-08-06T00:00:00.000Z\"}]},\"limit\":50}",
    );
    expect(task.initialEvent).toEqual({
      type: "request_started",
      requestId: "request-1",
      queryKey: task.queryKey,
      mode: "first",
    });
    await expect(task.execute()).resolves.toMatchObject({
      type: "request_succeeded",
      requestId: "request-1",
      page: { data: [{ order: { effectiveRevision: 2 } }] },
    });
    expect(transport).toHaveBeenCalledWith({
      scope: { scopeKind: "report", merchantId: "merchant-a", storeIds: ["store-a"] },
      filters: {
        searchMode: "order_or_customer_identity",
        search: "ord-a",
        statusMode: "completed",
        storeWindows: baseInput.filters.storeWindows,
      },
      limit: 50,
      nowEpochSeconds: 1_786_000_000,
    });
  });

  it("creates a next-page task only with a non-empty cursor", async () => {
    const transport = vi.fn().mockResolvedValue(page());
    const task = createEffectiveOrderPageQueryTaskV2(
      { config: { enabled: true }, transport },
      { ...baseInput, mode: "next", cursor: "cursor-2", limit: 50 },
    );
    if (!task.enabled) throw new Error("expected enabled task");

    expect(task.initialEvent).toMatchObject({ mode: "next" });
    await task.execute();
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ cursor: "cursor-2" }));

    expect(() => createEffectiveOrderPageQueryTaskV2(
      { config: { enabled: true }, transport },
      { ...baseInput, mode: "next" },
    )).toThrow(EffectiveOrderPageQueryAdapterErrorV2);
  });

  it("maps only exact invalid/expired/stale server contracts to refresh", async () => {
    const cases = [
      { status: 400, code: "invalid_cursor", reason: "invalid_cursor" },
      { status: 410, code: "expired_cursor", reason: "expired_cursor" },
      { status: 409, code: "stale_cursor", reason: "stale_cursor" },
    ] as const;
    for (const item of cases) {
      const transport = vi.fn().mockRejectedValue({
        status: item.status,
        code: item.code,
        details: { refreshFromStart: true, secret: "must-not-propagate" },
      });
      const task = createEffectiveOrderPageQueryTaskV2(
        { config: { enabled: true }, transport },
        { ...baseInput, mode: "next", cursor: "cursor-2" },
      );
      if (!task.enabled) throw new Error("expected enabled task");

      await expect(task.execute()).resolves.toEqual({
        type: "refresh_required",
        requestId: "request-1",
        reason: item.reason,
      });
    }
  });

  it("fails closed for malformed or cross-scope success payloads", async () => {
    const forged = page({
      data: [{
        ...page().data[0]!,
        sourceOrder: { ...page().data[0]!.sourceOrder, merchantId: "merchant-b" },
      }],
    });
    for (const response of [{ schemaVersion: 1 }, forged]) {
      const task = createEffectiveOrderPageQueryTaskV2(
        { config: { enabled: true }, transport: vi.fn().mockResolvedValue(response) },
        baseInput,
      );
      if (!task.enabled) throw new Error("expected enabled task");
      await expect(task.execute()).resolves.toEqual({
        type: "request_failed",
        requestId: "request-1",
        message: "Unable to load orders",
      });
    }
  });

  it("rejects scope/filter drift and invalid clocks before transport", () => {
    const transport = vi.fn();
    const badInputs = [
      { ...baseInput, scope: { ...baseInput.scope, storeIds: ["store-a", "store-a"] } },
      { ...baseInput, scope: { ...baseInput.scope, storeIds: ["store-b"] } },
      { ...baseInput, nowEpochSeconds: -1 },
    ];
    for (const input of badInputs) {
      expect(() => createEffectiveOrderPageQueryTaskV2(
        { config: { enabled: true }, transport },
        input,
      )).toThrow(EffectiveOrderPageQueryAdapterErrorV2);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("sanitizes unknown transport errors instead of trusting server text", async () => {
    const task = createEffectiveOrderPageQueryTaskV2(
      {
        config: { enabled: true },
        transport: vi.fn().mockRejectedValue({
          status: 409,
          code: "stale_cursor",
          details: { refreshFromStart: false },
          message: "merchant-b secret",
        }),
      },
      { ...baseInput, mode: "next", cursor: "cursor-2" },
    );
    if (!task.enabled) throw new Error("expected enabled task");

    await expect(task.execute()).resolves.toEqual({
      type: "request_failed",
      requestId: "request-1",
      message: "Unable to load orders",
    });
  });
});
