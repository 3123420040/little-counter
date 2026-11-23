import { describe, expect, it, vi } from "vitest";
import type { EffectiveOrderPageV3 } from "@medusa-snus/contracts";
import {
  EffectiveOrderPageControllerErrorV2,
  createEffectiveOrderPageControllerV2,
} from "./effectiveOrderPageController";

function row(orderId: string, amount: number, status = "completed") {
  return {
    sourceOrder: {
      merchantId: "merchant-a",
      storeId: "store-a",
      orderId,
      orderNumber: `ORD-${orderId}`,
      status,
    },
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
    customerAttribution: "unknown" as const,
    customer: null,
  };
}

function page(
  orderId: string,
  amount: number,
  options: {
    totalCount?: number;
    aggregate?: number;
    nextCursor?: string | null;
    status?: string;
  } = {},
): EffectiveOrderPageV3 {
  const totalCount = options.totalCount ?? 1;
  const aggregate = options.aggregate ?? amount;
  const nextCursor = options.nextCursor ?? null;
  return {
    schemaVersion: 3,
    data: [row(orderId, amount, options.status)],
    pagination: {
      limit: 1,
      hasMore: nextCursor !== null,
      nextCursor,
      asOf: "2026-08-05T00:00:01.000Z",
      totalCount,
    },
    currencies: [{
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
  };
}

const firstInput = {
  scope: {
    scopeKind: "report" as const,
    merchantId: "merchant-a",
    storeIds: ["store-a"],
  },
  filters: {
    statusMode: "all" as const,
    storeWindows: [{
      storeId: "store-a",
      startInclusive: "2026-08-04T00:00:00.000Z",
      endExclusive: "2026-08-06T00:00:00.000Z",
    }],
  },
  limit: 1,
  nowEpochSeconds: 1_786_000_000,
};

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `request-${index}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("PAGE-02D inactive POS effective-order controller", () => {
  it("is disabled by default without issuing IDs or transport calls", async () => {
    const transport = vi.fn();
    const nextRequestId = vi.fn();
    const controller = createEffectiveOrderPageControllerV2({ transport, nextRequestId });

    await expect(controller.loadFirst(firstInput)).resolves.toMatchObject({ status: "disabled" });
    expect(nextRequestId).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("loads first and terminal next pages through one state machine", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(page("order-a", 2_000, {
        totalCount: 2,
        aggregate: 5_000,
        nextCursor: "cursor-2",
      }))
      .mockResolvedValueOnce(page("order-b", 3_000, {
        totalCount: 2,
        aggregate: 5_000,
      }));
    const controller = createEffectiveOrderPageControllerV2({
      config: { enabled: true },
      transport,
      nextRequestId: ids("request-1", "request-2"),
    });

    await controller.loadFirst(firstInput);
    const finalState = await controller.loadNext(1_786_000_001);

    expect(finalState).toMatchObject({ status: "ready", totalCount: 2, hasMore: false });
    expect(finalState.rows.map((item) => item.sourceOrder.orderId)).toEqual([
      "order-a",
      "order-b",
    ]);
    expect(finalState.currencies[0]!.recordedGrossCollectionsMinor).toBe(5_000);
  });

  it("serializes next-page execution and rejects a second in-flight next", async () => {
    const pending = deferred<EffectiveOrderPageV3>();
    const transport = vi.fn()
      .mockResolvedValueOnce(page("order-a", 2_000, {
        totalCount: 2,
        aggregate: 5_000,
        nextCursor: "cursor-2",
      }))
      .mockReturnValueOnce(pending.promise);
    const controller = createEffectiveOrderPageControllerV2({
      config: { enabled: true },
      transport,
      nextRequestId: ids("request-1", "request-2", "request-3"),
    });
    await controller.loadFirst(firstInput);

    const active = controller.loadNext(1_786_000_001);
    await expect(controller.loadNext(1_786_000_002)).rejects.toMatchObject({ code: "busy" });
    expect(transport).toHaveBeenCalledTimes(2);
    pending.resolve(page("order-b", 3_000, { totalCount: 2, aggregate: 5_000 }));
    await active;
  });

  it("allows a new first-page filter to supersede an older response", async () => {
    const oldRequest = deferred<EffectiveOrderPageV3>();
    const newRequest = deferred<EffectiveOrderPageV3>();
    const transport = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    const controller = createEffectiveOrderPageControllerV2({
      config: { enabled: true },
      transport,
      nextRequestId: ids("request-old", "request-new"),
    });

    const oldLoad = controller.loadFirst(firstInput);
    const newLoad = controller.loadFirst({
      ...firstInput,
      filters: { ...firstInput.filters, statusMode: "other" },
    });
    newRequest.resolve(page("order-new", 4_000, { status: "pending" }));
    await newLoad;
    oldRequest.resolve(page("order-old", 2_000));
    await oldLoad;

    expect(controller.getState()).toMatchObject({
      status: "ready",
      rows: [{ sourceOrder: { orderId: "order-new", status: "pending" } }],
    });
  });

  it("retries an explicitly partial next-page failure with the same cursor", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(page("order-a", 2_000, {
        totalCount: 2,
        aggregate: 5_000,
        nextCursor: "cursor-2",
      }))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(page("order-b", 3_000, { totalCount: 2, aggregate: 5_000 }));
    const controller = createEffectiveOrderPageControllerV2({
      config: { enabled: true },
      transport,
      nextRequestId: ids("request-1", "request-2", "request-3"),
    });
    await controller.loadFirst(firstInput);
    const partial = await controller.loadNext(1_786_000_001);
    expect(partial).toMatchObject({ status: "error", hasMore: true, rows: [{ sourceOrder: { orderId: "order-a" } }] });

    const recovered = await controller.retryNext(1_786_000_002);
    expect(recovered.rows).toHaveLength(2);
    expect(transport.mock.calls[1]![0]).toMatchObject({ cursor: "cursor-2" });
    expect(transport.mock.calls[2]![0]).toMatchObject({ cursor: "cursor-2" });
  });

  it("requires explicit first-page refresh after a stale cursor clears state", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(page("order-a", 2_000, {
        totalCount: 2,
        aggregate: 5_000,
        nextCursor: "cursor-2",
      }))
      .mockRejectedValueOnce({
        status: 409,
        code: "stale_cursor",
        details: { refreshFromStart: true },
      })
      .mockResolvedValueOnce(page("order-current", 5_000));
    const controller = createEffectiveOrderPageControllerV2({
      config: { enabled: true },
      transport,
      nextRequestId: ids("request-1", "request-2", "request-3"),
    });
    await controller.loadFirst(firstInput);
    const refresh = await controller.loadNext(1_786_000_001);
    expect(refresh).toMatchObject({ status: "refresh_required", rows: [], currencies: [] });

    const refreshFromStart = controller.refreshFromStart;
    const current = await refreshFromStart(1_786_000_002);
    expect(current).toMatchObject({ status: "ready", rows: [{ sourceOrder: { orderId: "order-current" } }] });
    expect(transport.mock.calls[2]![0]).not.toHaveProperty("cursor");
  });

  it("rejects reused request IDs and returns defensive state snapshots", async () => {
    const transport = vi.fn().mockResolvedValue(page("order-a", 2_000));
    const controller = createEffectiveOrderPageControllerV2({
      config: { enabled: true },
      transport,
      nextRequestId: () => "request-reused",
    });
    await controller.loadFirst(firstInput);
    const snapshot = controller.getState();
    snapshot.rows.splice(0);
    expect(controller.getState().rows).toHaveLength(1);

    await expect(controller.loadFirst(firstInput)).rejects.toBeInstanceOf(
      EffectiveOrderPageControllerErrorV2,
    );
    expect(controller.getState().rows).toHaveLength(1);

    controller.disable();
    await expect(controller.loadFirst(firstInput)).resolves.toMatchObject({ status: "disabled" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
