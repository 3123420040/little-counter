import { describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";
import { normalizeOrderCursorFiltersV1, OrderCursorError } from "../services/order-cursor-service";

const page = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../services/effective-order-page-service", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readEffectiveOrderPageV3: page.read,
}));

import { handleEffectiveOrderPageHttpV3 } from "../services/effective-order-page-v3-http-handler";

const scope = { scopeKind: "report" as const, merchantId: "merchant-a", storeIds: ["store-a"] };
const filters = {
  ...normalizeOrderCursorFiltersV1({
  statusMode: "all",
  storeWindows: [{
    storeId: "store-a",
    startInclusive: "2026-08-01T00:00:00.000Z",
    endExclusive: "2026-08-06T00:00:00.000Z",
  }],
  }),
  searchMode: "order_or_customer_identity" as const,
};
const repository = { withRepeatableReadSnapshot: vi.fn() } as never;
const keyring = { current: { keyId: "current", keyBase64Url: Buffer.alloc(32, 12).toString("base64url") } };
const dependencies = { repository, keyring, config: { enabled: true } };
const request = (overrides: Record<string, unknown> = {}) => ({
  authorization: { permission: permissions.ordersRead, scope },
  filters,
  limit: 25,
  nowEpochSeconds: 1_800_000_000,
  ...overrides,
});

describe("effective order page v3 HTTP handler", () => {
  it("rejects authorization and feature configuration before data access", async () => {
    await expect(handleEffectiveOrderPageHttpV3(
      { repository, keyring }, request(),
    )).rejects.toMatchObject({ code: "feature_disabled", statusCode: 403 });

    await expect(handleEffectiveOrderPageHttpV3(
      dependencies,
      request({ authorization: { permission: permissions.ordersExport, scope } }),
    )).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    expect(page.read).not.toHaveBeenCalled();
  });

  it("requires a valid unique report scope and exact filter windows", async () => {
    await expect(handleEffectiveOrderPageHttpV3(
      dependencies,
      request({ authorization: { permission: permissions.ordersRead, scope: { ...scope, storeIds: ["store-a", "store-a"] } } }),
    )).rejects.toMatchObject({ code: "scope_required", statusCode: 409 });

    const otherFilters = {
      ...normalizeOrderCursorFiltersV1({
        statusMode: "all",
        storeWindows: [{ storeId: "store-b", startInclusive: "2026-08-01T00:00:00.000Z", endExclusive: "2026-08-06T00:00:00.000Z" }],
      }),
      searchMode: "order_or_customer_identity" as const,
    };
    await expect(handleEffectiveOrderPageHttpV3(dependencies, request({ filters: otherFilters })))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    await expect(handleEffectiveOrderPageHttpV3(dependencies, request({ filters: { ...filters, searchMode: "order_only" } })))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
  });

  it("rejects malformed query and cursor key configuration", async () => {
    await expect(handleEffectiveOrderPageHttpV3(dependencies, request({ limit: 0 })))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    await expect(handleEffectiveOrderPageHttpV3(dependencies, request({ nowEpochSeconds: -1 })))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    await expect(handleEffectiveOrderPageHttpV3(
      { ...dependencies, keyring: { current: { keyId: "weak", keyBase64Url: "bad" } } },
      request(),
    )).rejects.toMatchObject({ code: "feature_unavailable", statusCode: 503 });
  });

  it("returns the v3 contract with non-cacheable count headers", async () => {
    page.read.mockResolvedValueOnce({
      schemaVersion: 3,
      data: [{ sourceOrder: { orderId: "order-a" } }],
      pagination: {
        asOf: "2026-08-05T00:00:00.000Z",
        totalCount: 7,
        hasMore: true,
        nextCursor: "cursor",
      },
      currencies: [],
    });

    const response = await handleEffectiveOrderPageHttpV3(dependencies, request({ cursor: "cursor-in" }));

    expect(page.read).toHaveBeenCalledWith(repository, expect.objectContaining({
      scope: { merchantId: "merchant-a", storeIds: ["store-a"] },
      filters,
      limit: 25,
      cursor: "cursor-in",
      nowEpochSeconds: 1_800_000_000,
    }), keyring);
    expect(response).toMatchObject({
      statusCode: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Order-List-Contract": "orders.effective-page.v3",
        "X-Order-List-As-Of": "2026-08-05T00:00:00.000Z",
        "X-Order-List-Total-Count": "7",
        "X-Order-List-Row-Count": "1",
        "X-Order-List-Has-More": "true",
      },
    });
  });

  it.each([
    ["invalid_cursor", 400],
    ["expired_cursor", 410],
    ["stale_cursor", 409],
  ] as const)("maps %s to the public refresh contract", async (code, statusCode) => {
    page.read.mockRejectedValueOnce(new OrderCursorError(code, { refreshFromStart: true }));

    await expect(handleEffectiveOrderPageHttpV3(dependencies, request()))
      .rejects.toMatchObject({ code, statusCode, details: { refreshFromStart: true } });
  });

  it("preserves unexpected repository failures", async () => {
    const failure = new Error("database unavailable");
    page.read.mockRejectedValueOnce(failure);
    await expect(handleEffectiveOrderPageHttpV3(dependencies, request())).rejects.toBe(failure);
  });
});
