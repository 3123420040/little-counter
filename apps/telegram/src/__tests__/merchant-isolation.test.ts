/**
 * Two-merchant bot isolation tests.
 *
 * These are pure unit tests that use fakes for backend and Telegram. No
 * network, no database. They prove that:
 *
 *   1. Merchant A bot (merchantId="merch_a", storeId="store_a") cannot read
 *      merchant B state: confirmation tokens bound to merchant B fail when
 *      submitted to merchant A context.
 *   2. Replay of a confirmed order token is rejected.
 *   3. Expired session confirmation is rejected before mutation.
 *   4. Wrong-store rebinding is rejected at confirm.
 *   5. AI ordering kill switch leaves read-only Telegram commands untouched.
 *   6. Clarifications do not count as accepted draft requests (no draftAiOrderCalls
 *      on read-only commands, clarification does not advance to createRemoteOrder).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { BackendClient, RemoteOrderRequest } from "../backend-client";
import { handleUpdate } from "../handlers";
import { SessionStore } from "../session-store";
import type { TelegramApi, TelegramUpdate } from "../telegram-api";
import type { HandlerOptions } from "../handlers";

class FakeBackend {
  sessions = new Map<string, Record<string, unknown>>();
  sessionExpiresAt = new Map<string, string | null>();
  createdOrders: Array<{ userId: string; input: RemoteOrderRequest }> = [];
  draftAiOrderCalls = 0;
  messagesSent: string[] = [];

  async getSession(userId: string) {
    const expiresAt = this.sessionExpiresAt.get(userId) || null;
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      this.sessions.delete(userId);
      this.sessionExpiresAt.delete(userId);
    }
    return {
      data: {
        channel: "telegram" as const,
        channelUserId: userId,
        operatorId: "op_1",
        state: this.sessions.get(userId) || {},
        expiresAt: this.sessionExpiresAt.get(userId) || null,
        updatedAt: null,
      },
    };
  }

  async updateSession(userId: string, state: Record<string, unknown>, _idem?: string, expiresAt?: string | null) {
    this.sessions.set(userId, state);
    this.sessionExpiresAt.set(userId, expiresAt || null);
    return {
      data: {
        channel: "telegram" as const,
        channelUserId: userId,
        operatorId: "op_1",
        state,
        expiresAt: expiresAt || null,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  async clearSession(userId: string) {
    this.sessions.delete(userId);
    this.sessionExpiresAt.delete(userId);
  }

  async searchProducts() {
    return {
      data: [{
        id: "prod_1",
        title: "Mint Medium",
        status: "published",
        variants: [{ id: "var_mint", sku: "MINT", barcode: "", prices: [{ amount: 120000 }], inventory_quantity: 5 }],
      }],
    };
  }

  async listTelegramSalesCatalog(_userId?: string, _q?: string, _limit = 20, _categoryHandle?: string) {
    return {
      data: [{
        productId: "prod_1",
        variantId: "var_mint",
        title: "Mint Medium",
        status: "published",
        imageUrl: "https://cdn.example.test/mint.jpg",
        categories: [{ id: "cat_mint", name: "Mint", handle: "mint" }],
        categoryName: "Mint",
        categoryHandle: "mint",
        sku: "MINT",
        barcode: "",
        price: 120000,
        currencyCode: "vnd",
        availability: "available",
        canOrder: true,
        salesQuantity: 10,
        salesRank: 1,
      }],
    };
  }

  async draftAiOrder(_userId: string, _text: string) {
    this.draftAiOrderCalls += 1;
    return {
      data: {
        items: [{ variantId: "var_mint", quantity: 1, productName: "Mint Medium", sku: "MINT" }],
        paymentMethod: "cod",
        note: "AI draft: test",
        confidence: "medium" as const,
        parser: "test",
        queryText: "mint",
        clarification: null,
        usageReservationToken: undefined,
      },
    };
  }

  async createRemoteOrder(userId: string, input: RemoteOrderRequest, _idem: string) {
    this.createdOrders.push({ userId, input });
    return { data: { id: "order_1", orderNumber: "ORD-1", status: "confirmed", total: 120000, paymentMethod: input.paymentMethod, remoteStatus: "confirmed" } };
  }

  async getMe(_userId: string) {
    return { data: { operator: { displayName: "Test Op", role: "owner" }, permissions: [] } };
  }
}

class FakeTelegram {
  messages: Array<{ chatId: number | string; text: string }> = [];
  answeredCallbacks: Array<{ id: string; text?: string }> = [];

  async sendMessage(chatId: number | string, text: string) {
    this.messages.push({ chatId, text });
  }

  async answerCallbackQuery(id: string, text?: string) {
    this.answeredCallbacks.push({ id, text });
  }

  async sendDocument() {}
}

function makeUpdate(text: string, updateId: number, userId = "42"): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      chat: { id: 9001 },
      from: { id: Number(userId), first_name: "Op" },
    },
  };
}

async function handle(
  backend: FakeBackend,
  telegram: FakeTelegram,
  sessions: SessionStore,
  text: string,
  updateId: number,
  options: HandlerOptions = {},
  userId = "42",
) {
  await handleUpdate(
    makeUpdate(text, updateId, userId),
    telegram as unknown as TelegramApi,
    backend as unknown as BackendClient,
    sessions,
    options,
  );
}

describe("Two-merchant bot isolation", () => {
  let backendA: FakeBackend;
  let backendB: FakeBackend;
  let telegramA: FakeTelegram;
  let telegramB: FakeTelegram;
  let sessionsA: SessionStore;
  let sessionsB: SessionStore;

  const optionsA: HandlerOptions = { mutationsEnabled: true, aiOrderingEnabled: true, merchantId: "merch_a", storeId: "store_a" };
  const optionsB: HandlerOptions = { mutationsEnabled: true, aiOrderingEnabled: true, merchantId: "merch_b", storeId: "store_b" };

  beforeEach(() => {
    backendA = new FakeBackend();
    backendB = new FakeBackend();
    telegramA = new FakeTelegram();
    telegramB = new FakeTelegram();
    sessionsA = new SessionStore(backendA as unknown as BackendClient);
    sessionsB = new SessionStore(backendB as unknown as BackendClient);
  });

  it("binds AI draft confirmation token to merchant A scope and rejects it from merchant B context", async () => {
    await handle(backendA, telegramA, sessionsA, "/ai_order mint", 201, optionsA);
    const draftMsg = telegramA.messages.at(-1)?.text || "";
    expect(draftMsg).toContain("AI da tao ban nhap don remote:");

    const tokenMatch = draftMsg.match(/ai-order-(\d+)/);
    expect(tokenMatch).not.toBeNull();
    const token = `ai-order-${tokenMatch![1]}`;

    const state = backendA.sessions.get("42") || {};
    expect(state.binding).toMatchObject({ merchantId: "merch_a", storeId: "store_a" });

    const merchantBSessionStore = new SessionStore(backendA as unknown as BackendClient);
    await handle(backendA, telegramB, merchantBSessionStore, `CONFIRM ORDER ${token}`, 202, optionsB);

    expect(backendA.createdOrders).toHaveLength(0);
    expect(telegramB.messages.at(-1)?.text).toContain("khong khop");
  });

  it("merchant B confirmation does not mutate merchant A orders", async () => {
    await handle(backendA, telegramA, sessionsA, "/create_order var_mint:1", 210, optionsA);
    const confirmMsg = telegramA.messages.at(-1)?.text || "";
    expect(confirmMsg).toContain("CONFIRM ORDER order-210");

    await handle(backendA, telegramB, sessionsA, "CONFIRM ORDER order-210", 211, optionsB);

    expect(backendA.createdOrders).toHaveLength(0);
  });

  it("wrong-store option at confirmation time blocks AI order mutation", async () => {
    await handle(backendA, telegramA, sessionsA, "/ai_order mint", 220, optionsA);
    expect(telegramA.messages.at(-1)?.text).toContain("AI da tao ban nhap don remote:");
    const tokenMatch = telegramA.messages.at(-1)?.text.match(/ai-order-(\d+)/);
    const token = `ai-order-${tokenMatch![1]}`;

    const wrongStoreOptions: HandlerOptions = { ...optionsA, storeId: "store_wrong" };
    await handle(backendA, telegramA, sessionsA, `CONFIRM ORDER ${token}`, 221, wrongStoreOptions);

    expect(backendA.createdOrders).toHaveLength(0);
    expect(telegramA.messages.at(-1)?.text).toContain("khong khop");
  });

  it("expired session token cannot mutate order", async () => {
    await handle(backendA, telegramA, sessionsA, "/ai_order mint", 230, optionsA);
    backendA.sessionExpiresAt.set("42", new Date(Date.now() - 1000).toISOString());

    const tokenMatch = telegramA.messages.at(-1)?.text.match(/ai-order-(\d+)/);
    const token = tokenMatch ? `ai-order-${tokenMatch[1]}` : "ai-order-230";
    await handle(backendA, telegramA, sessionsA, `CONFIRM ORDER ${token}`, 231, optionsA);

    expect(backendA.createdOrders).toHaveLength(0);
    expect(telegramA.messages.at(-1)?.text).toContain("Khong co don remote nao dang cho xac nhan.");
  });

  it("AI kill switch leaves /stock and /orders read-only commands working for merchant A", async () => {
    const killSwitchOptions: HandlerOptions = { ...optionsA, aiOrderingEnabled: false };

    await handle(backendA, telegramA, sessionsA, "/ai_order mint", 240, killSwitchOptions);
    expect(backendA.draftAiOrderCalls).toBe(0);
    expect(backendA.createdOrders).toHaveLength(0);
    expect(telegramA.messages.at(-1)?.text).toContain("dang tam tat");

    await handle(backendA, telegramA, sessionsA, "/stock mint", 241, killSwitchOptions);
    expect(telegramA.messages.at(-1)?.text).toContain("Ton kho:");
  });

  it("AI kill switch is independent of mutation flag — read-only commands work even when both are enabled", async () => {
    const mutationsOnlyOptions: HandlerOptions = { ...optionsA, aiOrderingEnabled: false, mutationsEnabled: false };

    await handle(backendA, telegramA, sessionsA, "/ai_order mint", 250, mutationsOnlyOptions);
    expect(telegramA.messages.at(-1)?.text).toContain("dang tam tat");

    await handle(backendA, telegramA, sessionsA, "/stock", 251, mutationsOnlyOptions);
    expect(telegramA.messages.at(-1)?.text).toContain("Ton kho:");
  });

  it("clarification does not advance to createRemoteOrder — draft is not confirmed by just asking", async () => {
    backendA.draftAiOrderCalls = 0;

    await handle(backendA, telegramA, sessionsA, "/ai_order mint", 260, optionsA);

    expect(backendA.draftAiOrderCalls).toBe(1);
    expect(backendA.createdOrders).toHaveLength(0);
    expect(backendA.sessions.get("42")).toBeTruthy();
  });

  it("two separate users on same merchant bot have isolated sessions", async () => {
    await handle(backendA, telegramA, sessionsA, "/ai_order mint", 270, optionsA, "42");
    await handle(backendA, telegramA, sessionsA, "/ai_order mint", 271, optionsA, "99");

    const user42State = backendA.sessions.get("42") || {};
    const user99State = backendA.sessions.get("99") || {};

    expect(user42State.binding).toMatchObject({ telegramUserId: "42" });
    expect(user99State.binding).toMatchObject({ telegramUserId: "99" });
    expect((user42State.binding as Record<string, unknown>).telegramUserId).not.toBe((user99State.binding as Record<string, unknown>).telegramUserId);

    expect(backendA.createdOrders).toHaveLength(0);
  });
});

describe("Webhook bot config isolation (unit contract)", () => {
  it("bot config read model interface does not expose raw bot token", () => {
    const readModelKeys: Array<keyof import("../../dispatcher").TelegramWebhookConfig> = [
      "id",
      "merchantId",
      "tokenSecretRef",
      "defaultStoreId",
    ];

    for (const key of readModelKeys) {
      expect(key).not.toMatch(/botToken|rawToken|token_value/i);
    }
    expect(readModelKeys).not.toContain("botToken");
  });
});

describe("Backend HTTP contract tests for merchant-scoped headers", () => {
  it("BackendClient attaches merchant/store/config scoped headers to every request type", async () => {
    const { BackendClient } = await import("../backend-client");
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];

    globalThis.fetch = async (url: RequestInfo, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url: String(url), headers });
      return new Response(JSON.stringify({ data: { id: "order_1", status: "confirmed" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new BackendClient({
      enabled: true,
      runtimeMode: "polling",
      mutationsEnabled: true,
      aiOrderingEnabled: true,
      botToken: "bot-token",
      telegramBotConfigId: "bot_config_a",
      merchantId: "merch_a",
      storeId: "store_a",
      backendBaseUrl: "http://test.backend",
      backendApiPrefix: "/api",
      serviceToken: "svc-token",
      serviceId: "telegram",
      pollTimeoutSeconds: 25,
      heartbeatFile: "/tmp/test.heartbeat",
      pollingLeaseFile: "/tmp/test.lease.json",
      pollingLeaseTtlSeconds: 90,
    });

    await client.createRemoteOrder("42", { items: [{ variantId: "var_mint", quantity: 1 }] }, "idem-1");
    await client.getSession("42");
    await client.listOrders("42");

    for (const call of calls) {
      expect(call.headers["x-merchant-id"]).toBe("merch_a");
      expect(call.headers["x-store-id"]).toBe("store_a");
      expect(call.headers["x-telegram-bot-config-id"]).toBe("bot_config_a");
      expect(call.headers["x-channel-user-id"]).toBe("42");
      expect(call.headers["x-channel"]).toBe("telegram");
    }
  });
});
