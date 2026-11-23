import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import {
  getEffectiveOrderFeatureCsvV3,
  getEffectiveOrderFeatureDetailV2,
  getEffectiveOrderFeatureDetailV3,
  getEffectiveOrderFeaturePageV2,
  getEffectiveOrderFeaturePageV3,
  getEffectiveOrderFeaturePageV4,
  getEffectiveOrderFeaturePageV5,
  getEffectiveOrderFeatureReceiptTextV1,
  getEffectiveOrderFeatureRecreateV1,
  getEffectiveOrderFeatureRecreateV2,
  getEffectiveOrderFeatureRecreateV3,
  getPartialFinancialFeatureDashboardV1,
  ORDER_FINANCIAL_FEATURE_ROUTE_DEFAULT_CONFIG_V1,
} from "../services/order-financial-feature-route-service";

const scope = {
  scopeKind: "report" as const,
  merchantId: "merchant-a",
  storeIds: ["store-a"],
};

const client = {} as PoolClient;
const keyring = {
  current: {
    keyId: "current",
    keyBase64Url: Buffer.alloc(32, 1).toString("base64url"),
  },
};

const projection = {
  schemaVersion: 1 as const,
  orderId: "order-a",
  currencyCode: "VND",
  minorUnitExponent: 0,
  effectiveRevision: 2,
  commercialState: "active" as const,
  lines: [{
    lineId: "line-a",
    productId: "product-a",
    variantId: "variant-a",
    skuSnapshot: "SKU-A",
    titleSnapshot: "Corrected item",
    quantity: 2,
    unitPriceMinor: 60,
  }],
  components: {
    taxMode: "inclusive" as const,
    merchandiseGrossMinor: 120,
    discountMinor: 10,
    merchandiseNetMinor: 110,
    shippingMinor: 5,
    merchandiseVatMinor: 10,
    shippingVatMinor: 0,
    vatMinor: 10,
    unclassifiedMinor: 2,
    totalMinor: 117,
  },
  currentOrderGrossValueMinor: 117,
  dataQuality: {
    status: "complete" as const,
    costCoverage: { knownLines: 1, totalLines: 1 },
    warnings: [],
  },
};

function expectFeatureDisabled(error: unknown): boolean {
  expect(error).toBeInstanceOf(PlatformError);
  expect(error).toMatchObject({ code: "feature_disabled", statusCode: 403 });
  return true;
}

describe("order financial feature-only route integration", () => {
  it("refuses malformed V5 creators before opening a reporting transaction", async () => {
    const withClient = vi.fn();
    await expect(getEffectiveOrderFeaturePageV5({ scope, from: "2026-10-26", to: "2026-10-26",
      creatorOperatorIds: [""], nowEpochSeconds: 1_800_000_000 }, { orderCursorKeyring: keyring }, { withClient }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(withClient).not.toHaveBeenCalled();
  });
  it("binds detail V3 to the same scoped persisted identity/asOf without changing V2", async () => {
    const withClient = vi.fn(async (read: (value: PoolClient) => Promise<unknown>) => read(client));
    const readDetailIdentity = vi.fn(async () => ({ orderId: "order-a", currencyCode: "VND", asOf: "2026-08-06T08:00:00.000Z" }));
    const readDetailSurfaceV3 = vi.fn(async () => ({ schemaVersion: 3 as const, componentVersion: 2 as const,
      surfaceKind: "detail" as const, orderId: "order-a", currencyCode: "VND", minorUnitExponent: 0,
      effectiveRevision: 2, commercialState: "active" as const,
      effectiveItems: projection.lines.map((line) => ({ ...line, archivedVariant: false, lineTotalMinor: line.quantity * line.unitPriceMinor })),
      components: { ...projection.components, paymentFeeMinor: 10, paymentFeeVatMinor: 1, vatMinor: 11, totalMinor: 127 },
      effectiveCommercialTotalMinor: 127, currentOrderGrossValueMinor: 127, effectiveItemQuantity: 2, dataQuality: projection.dataQuality }));
    const result = await getEffectiveOrderFeatureDetailV3({ scope, orderId: "order-a" }, undefined,
      { withClient, readDetailIdentity, readDetailSurfaceV3 });
    expect(result).toMatchObject({ schemaVersion: 3, components: { paymentFeeMinor: 10 }, currentOrderGrossValueMinor: 127 });
    expect(readDetailSurfaceV3).toHaveBeenCalledExactlyOnceWith(client, {
      surfaceKind: "detail", scope, orderId: "order-a", currencyCode: "VND", asOf: "2026-08-06T08:00:00.000Z" });
    withClient.mockClear();
    await expect(getEffectiveOrderFeatureDetailV3({ scope, orderId: "order-a" }, { effectiveOrderDetailEnabled: false }, { withClient }))
      .rejects.toMatchObject({ code: "feature_disabled" });
    expect(withClient).not.toHaveBeenCalled();
  });
  it("uses the fee-aware persisted projection for the existing raw receipt transport", async () => {
    const withClient = vi.fn(async (read: (value: PoolClient) => Promise<unknown>) => read(client));
    const readReceiptIdentity = vi.fn(async () => ({
      sourceOrder: { orderId: "order-a", orderNumber: "ORD-A", createdAt: "2026-08-01T01:00:00.000Z", storeTimeZone: "Asia/Ho_Chi_Minh" },
      currencyCode: "VND", asOf: "2026-08-06T08:00:00.000Z", storeName: "Store A", customer: null,
    }));
    const readReceiptProjection = vi.fn(async () => ({ ...projection, schemaVersion: 2 as const, componentVersion: 2 as const,
      components: { ...projection.components, paymentFeeMinor: 10, paymentFeeVatMinor: 1,
        vatMinor: 11, totalMinor: 127 }, currentOrderGrossValueMinor: 127 }));
    const text = await getEffectiveOrderFeatureReceiptTextV1({ scope, orderId: "order-a" }, undefined,
      { withClient, readReceiptIdentity, readReceiptProjection });
    expect(text).toContain("Payment surcharge: 10 VND");
    expect(text).toContain("Order commercial total (VAT/fees included): 127 VND");
    expect(readReceiptProjection).toHaveBeenCalledExactlyOnceWith(client, {
      scope, orderId: "order-a", currencyCode: "VND", asOf: "2026-08-06T08:00:00.000Z",
    });
  });
  it.each([[""], ["   "], ["a".repeat(161)], [123], [null]])("rejects malformed creator IDs instead of widening to all: %j", async (value) => {
    const withClient = vi.fn();
    await expect(getEffectiveOrderFeaturePageV4({ scope, from: "2026-08-01", to: "2026-08-02",
      creatorOperatorIds: [value] as string[], nowEpochSeconds: 1785888000,
    }, { orderCursorKeyring: keyring }, { withClient })).rejects.toMatchObject({ statusCode: 400 });
    expect(withClient).not.toHaveBeenCalled();
  });
  it("selects every canonical live route by default and retains an explicit fail-closed policy seam", async () => {
    expect(ORDER_FINANCIAL_FEATURE_ROUTE_DEFAULT_CONFIG_V1).toEqual({
      effectiveOrderPageEnabled: true,
      effectiveOrderDetailEnabled: true,
      effectiveOrderReceiptEnabled: true,
      effectiveOrderRecreateEnabled: true,
      effectiveOrderCsvEnabled: true,
      partialFinancialDashboardEnabled: true,
      statementTimeoutMs: 5_000,
    });
    expect(Object.isFrozen(ORDER_FINANCIAL_FEATURE_ROUTE_DEFAULT_CONFIG_V1)).toBe(true);
    const withClient = vi.fn();
    const disabled = {
      effectiveOrderPageEnabled: false,
      effectiveOrderCsvEnabled: false,
      partialFinancialDashboardEnabled: false,
    };

    await expect(getEffectiveOrderFeaturePageV2({
      scope,
      from: "2026-08-01",
      to: "2026-08-02",
      nowEpochSeconds: 1,
    }, disabled, { withClient })).rejects.toSatisfy(expectFeatureDisabled);
    await expect(getEffectiveOrderFeatureCsvV3({
      scope,
      from: "2026-08-01",
      to: "2026-08-02",
      grain: "order",
    }, disabled, { withClient })).rejects.toSatisfy(expectFeatureDisabled);
    await expect(getPartialFinancialFeatureDashboardV1({
      scope,
      from: "2026-08-01",
      to: "2026-08-02",
    }, disabled, { withClient })).rejects.toSatisfy(expectFeatureDisabled);

    expect(withClient).not.toHaveBeenCalled();
  });

  it("fails page activation closed before DB access when the cursor keyring is absent", async () => {
    const withClient = vi.fn();
    await expect(getEffectiveOrderFeaturePageV2({
      scope,
      from: "2026-08-01",
      to: "2026-08-02",
      nowEpochSeconds: 1,
    }, { effectiveOrderPageEnabled: true }, { withClient })).rejects.toMatchObject({
      code: "feature_unavailable",
      statusCode: 503,
    });
    expect(withClient).not.toHaveBeenCalled();
  });

  it("keeps an explicit detail deny policy and composes the default canonical projection on one client", async () => {
    const withClient = vi.fn(async (read: (value: PoolClient) => Promise<unknown>) => read(client));
    await expect(getEffectiveOrderFeatureDetailV2({
      scope,
      orderId: "order-a",
    }, { effectiveOrderDetailEnabled: false }, { withClient })).rejects.toSatisfy(expectFeatureDisabled);
    expect(withClient).not.toHaveBeenCalled();

    const readDetailIdentity = vi.fn(async () => ({
      orderId: "order-a",
      currencyCode: "VND",
      asOf: "2026-08-06T08:00:00.000Z",
    }));
    const detail = { schemaVersion: 2, orderId: "order-a" };
    const readDetailSurface = vi.fn(async () => detail) as never;
    const result = await getEffectiveOrderFeatureDetailV2({
      scope,
      orderId: "order-a",
    }, undefined, {
      withClient,
      readDetailIdentity,
      readDetailSurface,
    });
    expect(result).toBe(detail);
    expect(readDetailIdentity).toHaveBeenCalledWith(client, { scope, orderId: "order-a" });
    expect(readDetailSurface).toHaveBeenCalledWith(client, {
      surfaceKind: "detail",
      scope,
      orderId: "order-a",
      currencyCode: "VND",
      asOf: "2026-08-06T08:00:00.000Z",
    });
  });

  it("composes the enabled page request from authorized scope and per-store local windows", async () => {
    const handlePage = vi.fn(async (_dependencies, request) => ({
      statusCode: 200 as const,
      headers: { "X-Order-List-Contract": "orders.effective-page.v2" },
      body: { request },
    })) as never;
    const resolveStoreWindows = vi.fn(async () => [{
      storeId: "store-a",
      timeZone: "Asia/Ho_Chi_Minh",
      startInclusive: "2026-07-31T17:00:00.000Z",
      endExclusive: "2026-08-02T17:00:00.000Z",
    }]);
    const createRepository = vi.fn(() => ({} as never));
    const withClient = vi.fn(async (read: (value: PoolClient) => Promise<unknown>) => read(client));

    const response = await getEffectiveOrderFeaturePageV2({
      scope,
      from: "2026-08-01",
      to: "2026-08-02",
      search: "  ORD-9  ",
      statusMode: "completed",
      limit: 75,
      cursor: "cursor-1",
      nowEpochSeconds: 1_785_974_400,
    }, {
      effectiveOrderPageEnabled: true,
      orderCursorKeyring: keyring,
      statementTimeoutMs: 4_000,
    }, {
      withClient,
      resolveStoreWindows,
      createRepository,
      handlePage,
    });

    expect(response.statusCode).toBe(200);
    expect(withClient).toHaveBeenCalledOnce();
    expect(createRepository).toHaveBeenCalledWith(client, 4_000);
    expect(handlePage).toHaveBeenCalledWith(expect.objectContaining({
      keyring,
      config: { enabled: true },
    }), {
      authorization: { permission: "orders:read", scope },
      filters: {
        searchMode: "order_identity",
        search: "ord-9",
        statusMode: "completed",
        storeWindows: [{
          storeId: "store-a",
          startInclusive: "2026-07-31T17:00:00.000Z",
          endExclusive: "2026-08-02T17:00:00.000Z",
        }],
      },
      limit: 75,
      cursor: "cursor-1",
      nowEpochSeconds: 1_785_974_400,
    });

    const handlePageV3 = vi.fn(async (_dependencies, request) => ({
      statusCode: 200 as const,
      headers: { "X-Order-List-Contract": "orders.effective-page.v3" },
      body: { request },
    })) as never;
    await getEffectiveOrderFeaturePageV3({
      scope,
      from: "2026-08-01",
      to: "2026-08-02",
      search: "  Nguyen   An  ",
      statusMode: "completed",
      nowEpochSeconds: 1_785_974_400,
    }, {
      effectiveOrderPageEnabled: true,
      orderCursorKeyring: keyring,
    }, {
      withClient,
      resolveStoreWindows,
      createRepository,
      handlePageV3,
    });
    expect(handlePageV3).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      filters: expect.objectContaining({
        searchMode: "order_or_customer_identity",
        search: "nguyen an",
      }),
    }));
  });

  it("composes CSV and dashboard readers only after their independent gates are enabled", async () => {
    const withClient = vi.fn(async (read: (value: PoolClient) => Promise<unknown>) => read(client));
    const resolveStoreWindows = vi.fn(async () => [{
      storeId: "store-a",
      timeZone: "Asia/Ho_Chi_Minh",
      startInclusive: "2026-07-31T17:00:00.000Z",
      endExclusive: "2026-08-02T17:00:00.000Z",
    }]);
    const handleCsv = vi.fn(async () => ({
      statusCode: 200 as const,
      headers: { "X-Order-Export-Contract": "orders.effective.v3" },
      body: "csv",
    })) as never;
    const handleDashboard = vi.fn(async () => ({
      statusCode: 200 as const,
      headers: { "X-Dashboard-Contract": "dashboard.partial-financial.v1" },
      body: { schemaVersion: 1 },
    })) as never;

    await getEffectiveOrderFeatureCsvV3({
      scope,
      from: "2026-08-01",
      to: "2026-08-02",
      statusMode: "other",
      grain: "line",
      batchSize: 125,
    }, {
      effectiveOrderCsvEnabled: true,
      statementTimeoutMs: 3_000,
    }, {
      withClient,
      resolveStoreWindows,
      createRepository: () => ({} as never),
      handleCsv,
    });
    await getPartialFinancialFeatureDashboardV1({
      scope,
      from: "2026-08-01",
      to: "2026-08-02",
    }, {
      partialFinancialDashboardEnabled: true,
      statementTimeoutMs: 2_500,
    }, { withClient, handleDashboard });

    expect(handleCsv).toHaveBeenCalledWith(expect.objectContaining({
      config: { enabled: true },
    }), expect.objectContaining({
      authorization: { permission: "orders:export", scope },
      grain: "line",
      batchSize: 125,
    }));
    expect(handleDashboard).toHaveBeenCalledWith({
      client,
      config: { enabled: true, statementTimeoutMs: 2_500 },
    }, {
      authorization: { permission: "reports:read", scope },
      range: { from: "2026-08-01", to: "2026-08-02" },
    });
  });

  it("retains explicit receipt/recreate deny policy and hydrates default canonical projections", async () => {
    const withClient = vi.fn(async (read: (value: PoolClient) => Promise<unknown>) => read(client));
    const receiptRequest = { scope, orderId: "order-a" };
    await expect(getEffectiveOrderFeatureReceiptTextV1(
      receiptRequest,
      { effectiveOrderReceiptEnabled: false },
      { withClient },
    )).rejects.toSatisfy(expectFeatureDisabled);
    await expect(getEffectiveOrderFeatureRecreateV1({
      scope: {
        scopeKind: "operating",
        merchantId: "merchant-a",
        storeId: "store-a",
        stockLocationId: "stock-a",
      },
      orderId: "order-a",
    }, { effectiveOrderRecreateEnabled: false }, { withClient })).rejects.toSatisfy(expectFeatureDisabled);
    expect(withClient).not.toHaveBeenCalled();

    const readReceiptIdentity = vi.fn(async () => ({
      sourceOrder: {
        orderId: "order-a",
        orderNumber: "ORD-A",
        createdAt: "2026-08-01T01:00:00.000Z",
        storeTimeZone: "Asia/Ho_Chi_Minh",
      },
      currencyCode: "VND",
      asOf: "2026-08-06T08:00:00.000Z",
      storeName: "Store A",
      customer: {
        id: "customer-a",
        firstName: "An",
        lastName: "Nguyen",
        phone: "0900000000",
      },
    }));
    const readProjection = vi.fn(async () => projection);
    const readReceiptProjection = vi.fn(async () => ({ ...projection, schemaVersion: 2 as const, componentVersion: 1 as const,
      components: { ...projection.components, paymentFeeMinor: 0, paymentFeeVatMinor: 0 } }));
    const receipt = await getEffectiveOrderFeatureReceiptTextV1(receiptRequest, undefined, { withClient, readReceiptIdentity, readReceiptProjection });
    expect(receipt).toContain("Corrected item x2");
    expect(receipt).toContain("Order commercial total (VAT/fees included): 117 VND");
    expect(receipt).toContain("Not a payment collection statement");

    const readRecreateCandidates = vi.fn(async () => [{
      productId: "product-a",
      variantId: "variant-a",
      currentTitle: "Current item",
      currentSku: "SKU-A",
      currentUnitPriceMinor: 70,
      stockAvailableQuantity: 5,
      published: true,
      archived: false,
    }]);
    const recreate = await getEffectiveOrderFeatureRecreateV1({
      scope: {
        scopeKind: "operating",
        merchantId: "merchant-a",
        storeId: "store-a",
        stockLocationId: "stock-a",
      },
      orderId: "order-a",
    }, undefined, {
      withClient,
      readReceiptIdentity,
      readProjection,
      readRecreateCandidates,
    });
    expect(recreate).toMatchObject({
      effectiveRevision: 2,
      cartReadiness: "ready",
      items: [{
        sourceLineId: "line-a",
        effectiveUnitPriceMinor: 60,
        mapping: {
          status: "available",
          currentUnitPriceMinor: 70,
          cartUnitPriceMinor: 70,
          priceChanged: true,
        },
      }],
    });

    const recreateV2 = await getEffectiveOrderFeatureRecreateV2({
      scope: {
        scopeKind: "operating",
        merchantId: "merchant-a",
        storeId: "store-a",
        stockLocationId: "stock-a",
      },
      orderId: "order-a",
    }, undefined, {
      withClient,
      readReceiptIdentity,
      readProjection,
      readRecreateCandidates,
    });
    expect(recreateV2).toMatchObject({
      schemaVersion: 2,
      customer: { id: "customer-a", phone: "0900000000" },
      commercialPrefill: { sourceOrder: { orderId: "order-a" } },
    });
    const feeProjection = vi.fn(async () => ({ ...projection, schemaVersion: 2 as const, componentVersion: 2 as const,
      components: { ...projection.components, paymentFeeMinor: 10, paymentFeeVatMinor: 1, vatMinor: 11, totalMinor: 127 }, currentOrderGrossValueMinor: 127 }));
    const request = { scope: { scopeKind: "operating" as const, merchantId: "merchant-a", storeId: "store-a", stockLocationId: "stock-a" }, orderId: "order-a" };
    const recreateV3 = await getEffectiveOrderFeatureRecreateV3(request, undefined,
      { withClient, readReceiptIdentity, readReceiptProjection: feeProjection, readRecreateCandidates });
    expect(recreateV3).toEqual({ ...recreateV2, schemaVersion: 3 });
    expect(feeProjection).toHaveBeenCalledWith(client, { scope, orderId: "order-a", currencyCode: "VND", asOf: expect.any(String) });
    withClient.mockClear();
    await expect(getEffectiveOrderFeatureRecreateV3(request, { effectiveOrderRecreateEnabled: false }, { withClient })).rejects.toMatchObject({ code: "feature_disabled" });
    expect(withClient).not.toHaveBeenCalled();
  });

  it("defaults a missing receipt-store timezone for recreate while rejecting an invalid configured timezone", async () => {
    const recreateRequest = {
      scope: {
        scopeKind: "operating" as const,
        merchantId: "merchant-a",
        storeId: "store-a",
        stockLocationId: "stock-a",
      },
      orderId: "order-a",
    };
    const readProjection = vi.fn(async () => projection);
    const readRecreateCandidates = vi.fn(async () => []);
    const identityRow = {
      order_id: "order-a",
      order_number: "ORD-A",
      created_at: new Date("2026-08-01T01:00:00.000Z"),
      currency_code: "VND",
      store_name: "Store A",
      customer_attribution: "unknown",
      projection_as_of: new Date("2026-08-06T08:00:00.000Z"),
    };
    const missingTimezoneClient = {
      query: vi.fn(async () => ({ rows: [{ ...identityRow, store_time_zone: null }] })),
    } as unknown as PoolClient;
    const withMissingTimezoneClient = vi.fn(async (read: (value: PoolClient) => Promise<unknown>) =>
      read(missingTimezoneClient));

    const recreated = await getEffectiveOrderFeatureRecreateV2(recreateRequest, undefined, {
      withClient: withMissingTimezoneClient,
      readProjection,
      readRecreateCandidates,
    });

    expect(recreated.commercialPrefill.sourceOrder.storeTimeZone)
      .toBe(DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE);
    expect(readProjection).toHaveBeenCalledOnce();

    const blankTimezoneClient = {
      query: vi.fn(async () => ({ rows: [{ ...identityRow, store_time_zone: "   " }] })),
    } as unknown as PoolClient;
    const recreatedWithBlankTimezone = await getEffectiveOrderFeatureRecreateV2(recreateRequest, undefined, {
      withClient: async (read) => read(blankTimezoneClient),
      readProjection,
      readRecreateCandidates,
    });
    expect(recreatedWithBlankTimezone.commercialPrefill.sourceOrder.storeTimeZone)
      .toBe(DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE);

    const invalidTimezoneClient = {
      query: vi.fn(async () => ({ rows: [{ ...identityRow, store_time_zone: "Invalid/Timezone" }] })),
    } as unknown as PoolClient;
    const withInvalidTimezoneClient = vi.fn(async (read: (value: PoolClient) => Promise<unknown>) =>
      read(invalidTimezoneClient));

    await expect(getEffectiveOrderFeatureRecreateV2(recreateRequest, undefined, {
      withClient: withInvalidTimezoneClient,
      readProjection,
      readRecreateCandidates,
    })).rejects.toMatchObject({ code: "store_timezone_invalid", statusCode: 422 });
  });
});
