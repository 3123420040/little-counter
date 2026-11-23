// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, buildScopeHeaders, getClientScopeSnapshot, getToken, hasClientOperatingScope, setToken } from "./client";
import { completeSale } from "./endpoints";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("POS API scope headers", () => {
  it("binds an explicit report snapshot and AbortSignal even after the selected scope changes", async () => {
    const controller = new AbortController(), fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.get("/api/platform/admin/orders/effective-v5", { "x-report-merchant-id": "captured-merchant", "x-report-store-ids": "captured-store" }, controller.signal);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal,
      headers: { "x-report-merchant-id": "captured-merchant", "x-report-store-ids": "captured-store", Authorization: "Bearer token_test" } });
  });
  it("binds an explicit report snapshot and AbortSignal for raw CSV fetches", async () => {
    const controller = new AbortController(), fetchMock = vi.fn().mockResolvedValue(new Response("csv", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.rawGet("/api/platform/admin/orders/export-effective-v5", { "x-report-merchant-id": "captured-merchant", "x-report-store-ids": "captured-store" }, controller.signal);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ signal: controller.signal,
      headers: { "x-report-merchant-id": "captured-merchant", "x-report-store-ids": "captured-store", Authorization: "Bearer token_test" } });
  });
  it("forwards an optional credential-command AbortSignal without retrying", async () => {
    const controller = new AbortController(), fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.post("/api/platform/admin/merchants/m/mcp-connections", {}, "same-attempt", {}, controller.signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal, headers: { "Idempotency-Key": "same-attempt", Authorization: "Bearer token_test" } });
  });
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    setToken("token_test");
    sessionStorage.setItem("snus_operating_merchant_id", "merchant_a");
    sessionStorage.setItem("snus_operating_store_id", "store_a");
    sessionStorage.setItem("snus_report_merchant_id", "merchant_a");
    sessionStorage.setItem("snus_report_store_ids", JSON.stringify(["store_a", "store_b"]));
  });

  afterEach(() => {
    setToken(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds operating and report scope headers from the selected session scope", () => {
    expect(buildScopeHeaders("/api/sync/bootstrap")).toEqual({
      "x-operating-merchant-id": "merchant_a",
      "x-operating-store-id": "store_a",
      "x-report-merchant-id": "merchant_a",
      "x-report-store-ids": "store_a,store_b",
    });
  });

  it("exposes the selected client scope and operating-scope readiness", () => {
    expect(getClientScopeSnapshot()).toEqual({
      operatingMerchantId: "merchant_a",
      operatingStoreId: "store_a",
      reportMerchantId: "merchant_a",
      reportStoreIds: ["store_a", "store_b"],
    });
    expect(hasClientOperatingScope()).toBe(true);

    sessionStorage.removeItem("snus_operating_store_id");

    expect(hasClientOperatingScope()).toBe(false);
  });

  it("does not attach stale scope headers to login, public signup, or me bootstrap requests", () => {
    expect(buildScopeHeaders("/api/pos/login")).toEqual({});
    expect(buildScopeHeaders("/api/public/request")).toEqual({});
    expect(buildScopeHeaders("/api/me")).toEqual({});
  });

  it("does not attach scope headers without an authenticated token", () => {
    setToken(null);

    expect(buildScopeHeaders("/api/orders")).toEqual({});
  });

  it("keeps bearer state in session storage and purges the legacy durable key", () => {
    localStorage.setItem("snus_token", "legacy-token");

    setToken("session-token");

    expect(getToken()).toBe("session-token");
    expect(sessionStorage.getItem("snus_token")).toBe("session-token");
    expect(localStorage.getItem("snus_token")).toBeNull();

    setToken(null);
    expect(sessionStorage.getItem("snus_token")).toBeNull();
  });

  it("sends selected scope headers with authenticated JSON requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.post("/api/orders", { items: [] }, "order-1");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token_test",
      "Content-Type": "application/json",
      "Idempotency-Key": "order-1",
      "x-operating-merchant-id": "merchant_a",
      "x-operating-store-id": "store_a",
      "x-report-merchant-id": "merchant_a",
      "x-report-store-ids": "store_a,store_b",
    });
  });

  it("replays the captured checkout body and store even if session selection has changed", async () => {
    sessionStorage.setItem("snus_operating_store_id", "store_b");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const payload = { idempotencyKey: "saved-sale", paymentMethod: "cash", amountReceived: 690000,
      items: [{ variantId: "variant_a", quantity: 1 }], shiftAttribution: "online_open_shift" as const };
    await completeSale(payload, { merchantId: "merchant_a", storeId: "store_a" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(payload);
    expect(init.headers).toMatchObject({ "Idempotency-Key": "saved-sale",
      "x-operating-merchant-id": "merchant_a", "x-operating-store-id": "store_a" });
  });
});
