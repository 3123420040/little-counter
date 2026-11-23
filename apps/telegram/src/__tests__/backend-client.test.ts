import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendApiError, BackendClient, type RemoteOrderRequest } from "../backend-client";
import type { TelegramConfig } from "../config";

interface FetchCall {
  url: string;
  init: RequestInit;
}

const config: TelegramConfig = {
  enabled: true,
  runtimeMode: "polling",
  mutationsEnabled: true,
  aiOrderingEnabled: true,
  botToken: "bot-token",
  telegramBotConfigId: "",
  merchantId: "",
  storeId: "",
  backendBaseUrl: "http://backend.test",
  backendApiPrefix: "/api",
  serviceToken: "service-token",
  serviceId: "telegram",
  pollTimeoutSeconds: 25,
  heartbeatFile: "/tmp/telegram-test.heartbeat",
  pollingLeaseFile: "/tmp/telegram-test.lease.json",
  pollingLeaseTtlSeconds: 90,
};

describe("Telegram BackendClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends channel identity and idempotency headers for remote order mutations", async () => {
    const calls = stubFetch([jsonResponse({ data: { id: "order_1", status: "confirmed" } })]);
    const client = new BackendClient(config);
    const input: RemoteOrderRequest = {
      customerId: "cus_1",
      items: [{ variantId: "var_mint", quantity: 2 }],
      paymentMethod: "cod",
      amountReceived: 120000,
      note: "smoke order",
    };

    await client.createRemoteOrder("123456", input, "telegram:order:idem-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://backend.test/api/orders",
      init: {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "x-channel": "telegram",
          "x-channel-user-id": "123456",
          "x-channel-service-id": "telegram",
          "idempotency-key": "telegram:order:idem-1",
        },
      },
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      ...input,
      status: "confirmed",
    });
  });

  it("sends merchant bot config and store scope headers when configured", async () => {
    const calls = stubFetch([jsonResponse({ data: { id: "order_1", status: "confirmed" } })]);
    const client = new BackendClient({ ...config, telegramBotConfigId: "tbc_a", merchantId: "merchant_a", storeId: "store_a" });

    await client.createRemoteOrder("123456", { items: [{ variantId: "var_mint", quantity: 1 }] }, "idem-a");

    expect(calls[0].init.headers).toMatchObject({
      "x-telegram-bot-config-id": "tbc_a",
      "x-merchant-id": "merchant_a",
      "x-store-id": "store_a",
      "x-channel-user-id": "123456",
    });
  });

  it("uses customer-safe Telegram sales endpoints for catalog and draft requests", async () => {
    const calls = stubFetch([
      jsonResponse({ data: [{ variantId: "var_mint", title: "Mint", availability: "available", canOrder: true }] }),
      jsonResponse({ data: { id: "tsd_1", status: "needs_review" } }),
      jsonResponse({ data: [{ id: "tsd_1", status: "needs_review" }], count: 1, limit: 5, offset: 0 }),
    ]);
    const client = new BackendClient({ ...config, merchantId: "merchant_default", storeId: "store_default" });

    await client.listTelegramSalesCatalog("123456", "mint", 10);
    await client.createTelegramSalesDraft("123456", {
      profile: { telegramUserId: "123456", telegramChatId: "123456", language: "en" },
      items: [{ variantId: "var_mint", quantity: 2 }],
      customerMessage: "mint x2",
    }, "telegram:sales:draft-1");
    await client.listTelegramSalesDrafts("123456", 5, 0);

    expect(calls.map((call) => call.url)).toEqual([
      "http://backend.test/api/channel/telegram-sales/catalog?limit=10&q=mint",
      "http://backend.test/api/channel/telegram-sales/drafts",
      "http://backend.test/api/channel/telegram-sales/drafts?limit=5&offset=0",
    ]);
    expect(calls[1].init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer service-token",
        "x-channel": "telegram",
        "x-channel-user-id": "123456",
        "x-merchant-id": "merchant_default",
        "x-store-id": "store_default",
        "idempotency-key": "telegram:sales:draft-1",
      },
    });
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({
      items: [{ variantId: "var_mint", quantity: 2 }],
      customerMessage: "mint x2",
    });
    expect(calls[2].init.headers).toMatchObject({
      authorization: "Bearer service-token",
      "x-channel": "telegram",
      "x-channel-user-id": "123456",
      "x-merchant-id": "merchant_default",
      "x-store-id": "store_default",
    });
  });

  it("uses the public Telegram sales session endpoint for customer session state", async () => {
    const calls = stubFetch([
      jsonResponse({ data: { channel: "telegram", channelUserId: "123456", actorType: "telegram_customer", state: {}, expiresAt: null, updatedAt: null } }),
      jsonResponse({ data: { channel: "telegram", channelUserId: "123456", actorType: "telegram_customer", state: { lastCommand: "start" }, expiresAt: null, updatedAt: "2026-07-04T00:00:00.000Z" } }),
      jsonResponse({ data: { channel: "telegram", channelUserId: "123456", actorType: "telegram_customer", cleared: true } }),
    ]);
    const client = new BackendClient({ ...config, merchantId: "merchant_default", storeId: "store_default" });

    await client.getSession("123456");
    await client.updateSession("123456", { lastCommand: "start" }, "telegram:session:1");
    await client.clearSession("123456");

    expect(calls.map((call) => call.url)).toEqual([
      "http://backend.test/api/channel/telegram-sales/session",
      "http://backend.test/api/channel/telegram-sales/session",
      "http://backend.test/api/channel/telegram-sales/session",
    ]);
    expect(calls[1].init).toMatchObject({
      method: "PATCH",
      headers: {
        authorization: "Bearer service-token",
        "x-channel": "telegram",
        "x-channel-user-id": "123456",
        "x-merchant-id": "merchant_default",
        "x-store-id": "store_default",
        "idempotency-key": "telegram:session:1",
      },
    });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      state: { lastCommand: "start" },
    });
    expect(calls[2].init.method).toBe("DELETE");
  });

  it("uses the service-scoped Telegram sales AI draft endpoint", async () => {
    const calls = stubFetch([
      jsonResponse({
        data: {
          items: [{ variantId: "var_mint", quantity: 2, productName: "Mint", sku: "MINT" }],
          paymentMethod: "cod",
          note: "Telegram sales AI draft: mint x2",
          confidence: "medium",
          parser: "deterministic-sales",
          queryText: "mint",
          clarification: null,
        },
      }),
    ]);
    const client = new BackendClient({ ...config, merchantId: "merchant_default", storeId: "store_default" });

    await client.draftTelegramSalesOrder("123456", "mint x2");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://backend.test/ai/telegram-sales/order-draft",
      init: {
        method: "POST",
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "x-channel": "telegram",
          "x-channel-user-id": "123456",
          "x-merchant-id": "merchant_default",
          "x-store-id": "store_default",
        },
      },
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: "mint x2" });
  });

  it("uses service-scoped headers for notification claim and acknowledgement calls", async () => {
    const calls = stubFetch([
      jsonResponse({ data: [{ id: "notif_1", telegramUserId: "123456", text: "ready" }] }),
      jsonResponse({ data: { id: "notif_1", status: "sent" } }),
      jsonResponse({ data: { id: "notif/2", status: "failed" } }),
    ]);
    const client = new BackendClient(config);

    await client.claimNotifications(7);
    await client.markNotificationSent("notif_1");
    await client.markNotificationFailed("notif/2", "send failed");

    expect(calls.map((call) => call.url)).toEqual([
      "http://backend.test/api/channel/notifications?limit=7",
      "http://backend.test/api/channel/notifications/notif_1",
      "http://backend.test/api/channel/notifications/notif%2F2",
    ]);
    for (const call of calls) {
      expect(call.init.headers).toMatchObject({
        authorization: "Bearer service-token",
        "content-type": "application/json",
        "x-channel": "telegram",
        "x-channel-service-id": "telegram",
      });
      expect(call.init.headers).not.toHaveProperty("x-channel-user-id");
    }
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ status: "sent" });
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ status: "failed", error: "send failed" });
  });

  it("requests accounting reports through user-scoped channel headers", async () => {
    const calls = stubFetch([
      jsonResponse({ data: { revenue: 500000, netIncome: 130000 } }),
    ]);
    const client = new BackendClient(config);

    const report = await client.getAccountingReport("123456", "income-statement", {
      from: "2026-06-01",
      to: "2026-06-15",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://backend.test/api/accounting/reports/income-statement?from=2026-06-01&to=2026-06-15",
      init: {
        headers: {
          authorization: "Bearer service-token",
          "content-type": "application/json",
          "x-channel": "telegram",
          "x-channel-user-id": "123456",
          "x-channel-service-id": "telegram",
        },
      },
    });
    expect(report.data).toEqual({ revenue: 500000, netIncome: 130000 });
  });

  it("preserves backend error code, message, details, and status", async () => {
    stubFetch([
      jsonResponse({
        error: {
          code: "channel_forbidden",
          message: "Operator cannot access Telegram channel",
          details: { permission: "orders:write" },
        },
      }, 403),
    ]);
    const client = new BackendClient(config);

    await expect(client.listOrders("123456")).rejects.toMatchObject({
      name: "BackendApiError",
      status: 403,
      code: "channel_forbidden",
      message: "Operator cannot access Telegram channel",
      details: { permission: "orders:write" },
    } satisfies Partial<BackendApiError>);
  });

  it("returns receipt PDF bytes with response metadata and fallback filename", async () => {
    const calls = stubFetch([
      binaryResponse(new Uint8Array([1, 2, 3]), {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename=\"ORD-1.pdf\"",
      }),
      binaryResponse(new Uint8Array([4, 5]), {
        "content-type": "application/octet-stream",
      }),
    ]);
    const client = new BackendClient(config);

    const namedPdf = await client.getReceiptPdf("123456", "ORD-1");
    const fallbackPdf = await client.getReceiptPdf("123456", "ORD 2");

    expect(calls.map((call) => call.url)).toEqual([
      "http://backend.test/api/orders/ORD-1/receipt.pdf",
      "http://backend.test/api/orders/ORD%202/receipt.pdf",
    ]);
    expect(calls[0].init.headers).toMatchObject({
      accept: "application/pdf",
      "x-channel-user-id": "123456",
    });
    expect(namedPdf).toMatchObject({
      contentType: "application/pdf",
      filename: "ORD-1.pdf",
    });
    expect([...new Uint8Array(namedPdf.data)]).toEqual([1, 2, 3]);
    expect(fallbackPdf).toMatchObject({
      contentType: "application/octet-stream",
      filename: "ORD 2-receipt.pdf",
    });
    expect([...new Uint8Array(fallbackPdf.data)]).toEqual([4, 5]);
  });

  it("can call direct Medusa routes without the Caddy /api prefix", async () => {
    const calls = stubFetch([jsonResponse({ data: { operatorId: "op_owner" } })]);
    const client = new BackendClient({ ...config, backendBaseUrl: "http://localhost:9000", backendApiPrefix: "" });

    await client.getMe("123456");

    expect(calls[0].url).toBe("http://localhost:9000/channel/me");
  });
});

function stubFetch(responses: Response[]): FetchCall[] {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected fetch call to ${String(input)}`);
    return response;
  });

  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function binaryResponse(body: Uint8Array, headers: Record<string, string>): Response {
  return new Response(body, { status: 200, headers });
}
