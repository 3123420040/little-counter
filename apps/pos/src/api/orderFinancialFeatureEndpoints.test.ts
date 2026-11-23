import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  get: vi.fn(),
  rawGet: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({ api: client }));

import {
  fetchEffectiveOrderFeatureDetail,
  fetchEffectiveOrderFeatureDetailV3,
  fetchEffectiveOrderFeaturePage,
  fetchEffectiveOrderFeaturePageV5,
  fetchEffectiveOrderFeatureRecreatePrefill,
  fetchReceiptPdf,
  fetchReceiptText,
  refundOrderWithEvidence,
} from "./endpoints";

function emptyEffectiveSurface() {
  return {
    schemaVersion: 2,
    surfaceKind: "detail",
    orderId: "order-a",
    currencyCode: "USD",
    minorUnitExponent: 2,
    effectiveRevision: 1,
    commercialState: "active",
    effectiveItems: [],
    components: {
      taxMode: "inclusive",
      merchandiseGrossMinor: 0,
      discountMinor: 0,
      merchandiseNetMinor: 0,
      shippingMinor: 0,
      merchandiseVatMinor: 0,
      shippingVatMinor: 0,
      vatMinor: 0,
      unclassifiedMinor: 0,
      totalMinor: 0,
    },
    effectiveCommercialTotalMinor: 0,
    currentOrderGrossValueMinor: 0,
    effectiveItemQuantity: 0,
    dataQuality: {
      status: "complete",
      costCoverage: { knownLines: 0, totalLines: 0 },
      warnings: [],
    },
  };
}

describe("effective-order feature endpoints", () => {
  it("binds V5 paging to captured report scope and rejects malformed creators before sending", async () => {
    const scope = { scopeKind: "report" as const, merchantId: "m-a", storeIds: ["s-a"] };
    const controller = new AbortController();
    const page = { schemaVersion: 5, creatorSelection: { mode: "selected", creatorOperatorIds: ["staff-a", "staff-b"] },
      data: [], currencies: [], pagination: { limit: 20, hasMore: false, nextCursor: null, asOf: "2026-10-27T12:00:00.000Z", totalCount: 0 } };
    client.get.mockResolvedValueOnce(page);
    await expect(fetchEffectiveOrderFeaturePageV5({ from: "2026-10-26", to: "2026-10-26", status: "all",
      creatorOperatorIds: ["staff-b", "staff-a"] }, scope, controller.signal)).resolves.toMatchObject({ schemaVersion: 5 });
    expect(client.get).toHaveBeenCalledExactlyOnceWith(
      "/api/platform/admin/orders/effective-v5?from=2026-10-26&to=2026-10-26&status=all&creatorOperatorId=staff-a&creatorOperatorId=staff-b",
      { "x-report-merchant-id": "m-a", "x-report-store-ids": "s-a" }, controller.signal);
    client.get.mockClear();
    await expect(fetchEffectiveOrderFeaturePageV5({ from: "2026-10-26", to: "2026-10-26", status: "all", creatorOperatorIds: [""] }, scope)).rejects.toThrow();
    expect(client.get).not.toHaveBeenCalled();
    client.get.mockResolvedValueOnce({ ...page, schemaVersion: 4 });
    await expect(fetchEffectiveOrderFeaturePageV5({ from: "2026-10-26", to: "2026-10-26", status: "all" }, scope)).rejects.toThrow();
    client.get.mockResolvedValueOnce(page);
    await expect(fetchEffectiveOrderFeaturePageV5({ from: "2026-10-26", to: "2026-10-26", status: "all" }, scope)).rejects.toThrow();
    expect(client.get).toHaveBeenCalledTimes(2);
    const zero = emptyEffectiveSurface();
    client.get.mockResolvedValueOnce({ ...page, creatorSelection: { mode: "all", creatorOperatorIds: [] },
      pagination: { ...page.pagination, totalCount: 1 },
      data: [{ sourceOrder: { merchantId: "foreign", storeId: "foreign", orderId: "o-foreign", orderNumber: "ORD-F", status: "completed" },
        customerAttribution: "walk_in", customer: null, createdAt: page.pagination.asOf,
        order: { schemaVersion: 2, componentVersion: 1, orderId: "o-foreign", currencyCode: "VND", minorUnitExponent: 0,
          effectiveRevision: 0, commercialState: "active", lines: [], components: { ...zero.components, paymentFeeMinor: 0, paymentFeeVatMinor: 0 },
          currentOrderGrossValueMinor: 0, dataQuality: zero.dataQuality },
        recordedGrossCollectionsMinor: 0, refundsMinor: 0, reversalsMinor: 0, chargebacksMinor: 0, negativeCollectionsMinor: 0, netCollectionsMinor: 0, customerRefundPayableMinor: 0 }],
      currencies: [{ currencyCode: "VND", minorUnitExponent: 0, orderCount: 1, activeOrderCount: 1, cancelledOrderCount: 0,
        currentOrderGrossValueMinor: 0, effectiveItemQuantity: 0, recordedGrossCollectionsMinor: 0, refundsMinor: 0, reversalsMinor: 0,
        chargebacksMinor: 0, negativeCollectionsMinor: 0, netCollectionsMinor: 0, paymentFeeMinor: 0, paymentFeeVatMinor: 0, paymentFeeCustomerTotalMinor: 0 }] });
    await expect(fetchEffectiveOrderFeaturePageV5({ from: "2026-10-26", to: "2026-10-26", status: "all" }, scope)).rejects.toThrow("không khớp");
  });
  it("uses the explicit fee-aware detail route and refuses a V2 or foreign-order response without fallback", async () => {
    const order = { ...emptyEffectiveSurface(), schemaVersion: 3, componentVersion: 2, orderId: "order/a", currencyCode: "VND", minorUnitExponent: 0,
      components: { ...emptyEffectiveSurface().components, paymentFeeMinor: 300, paymentFeeVatMinor: 0, totalMinor: 300 },
      effectiveCommercialTotalMinor: 300, currentOrderGrossValueMinor: 300 };
    client.get.mockResolvedValueOnce({ order });
    await expect(fetchEffectiveOrderFeatureDetailV3("order/a")).resolves.toMatchObject({ schemaVersion: 3, components: { paymentFeeMinor: 300 } });
    expect(client.get).toHaveBeenLastCalledWith("/api/platform/admin/orders/order%2Fa/effective-v3");
    client.get.mockResolvedValueOnce({ order: emptyEffectiveSurface() });
    await expect(fetchEffectiveOrderFeatureDetailV3("order/a")).rejects.toThrow();
    client.get.mockResolvedValueOnce({ order: { ...order, orderId: "foreign-order" } });
    await expect(fetchEffectiveOrderFeatureDetailV3("order/a")).rejects.toThrow();
    expect(client.get).toHaveBeenCalledTimes(3);
  });
  beforeEach(() => {
    client.get.mockReset();
    client.rawGet.mockReset();
    client.post.mockReset();
  });

  it("uses the additive page URL and rejects malformed response data", async () => {
    client.get.mockResolvedValueOnce({
      schemaVersion: 4,
      creatorSelection: { mode: "all", creatorOperatorIds: [] },
      data: [],
      pagination: {
        limit: 200,
        hasMore: false,
        nextCursor: null,
        asOf: "2026-08-06T08:00:00.000Z",
        totalCount: 0,
      },
      currencies: [],
    });
    await expect(fetchEffectiveOrderFeaturePage({
      from: "2026-08-01",
      to: "2026-08-06",
      status: "completed",
      search: "ORD/A",
      limit: 200,
    })).resolves.toMatchObject({ schemaVersion: 4 });
    expect(client.get).toHaveBeenCalledWith(
      "/api/platform/admin/orders/effective-v4?from=2026-08-01&to=2026-08-06&status=completed&search=ORD%2FA&limit=200",
    );

    client.get.mockResolvedValueOnce({ schemaVersion: 3 });
    await expect(fetchEffectiveOrderFeaturePage({
      from: "2026-08-01",
      to: "2026-08-06",
      status: "all",
    })).rejects.toThrow();
  });

  it("runtime-validates effective detail instead of trusting a TypeScript cast", async () => {
    client.get.mockResolvedValueOnce({ order: emptyEffectiveSurface() });
    await expect(fetchEffectiveOrderFeatureDetail("order/a")).resolves.toMatchObject({
      orderId: "order-a",
      currencyCode: "USD",
    });
    expect(client.get).toHaveBeenCalledWith(
      "/api/platform/admin/orders/order%2Fa/effective",
    );

    client.get.mockResolvedValueOnce({ order: { schemaVersion: 2 } });
    await expect(fetchEffectiveOrderFeatureDetail("order-a")).rejects.toThrow();
  });

  it("rejects malformed recreate prefill before adapting it for the cart", async () => {
    client.get.mockResolvedValueOnce({ prefill: {} });
    await expect(fetchEffectiveOrderFeatureRecreatePrefill("order/a")).rejects.toThrow();
    expect(client.get).toHaveBeenCalledWith(
      "/api/orders/order%2Fa/effective-recreate-prefill-v2",
    );
  });

  it("uses canonical effective receipt endpoints by default", async () => {
    client.rawGet
      .mockResolvedValueOnce(new Response("legacy receipt"))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));

    await expect(fetchReceiptText("order/a")).resolves.toBe("legacy receipt");
    await expect(fetchReceiptPdf("order/a")).resolves.toBeInstanceOf(Blob);
    expect(client.rawGet.mock.calls).toEqual([
      ["/api/orders/order%2Fa/effective-receipt.txt"],
      ["/api/orders/order%2Fa/effective-receipt.pdf"],
    ]);
  });

  it("sends explicit payout evidence with the caller-owned stable intent key", async () => {
    client.post.mockResolvedValueOnce({ data: { status: "refunded" } });
    await refundOrderWithEvidence("order/a", {
      amount: 125_000,
      method: "cash",
      reason: "Đã trả tiền mặt cho khách",
      confirmationToken: "ORD-1",
    }, "customer-refund-payout-stable-intent");
    expect(client.post).toHaveBeenCalledWith(
      "/api/orders/order%2Fa/refund",
      {
        amount: 125_000,
        method: "cash",
        reason: "Đã trả tiền mặt cho khách",
        confirmationToken: "ORD-1",
        restock: false,
      },
      "customer-refund-payout-stable-intent",
    );
  });
});
