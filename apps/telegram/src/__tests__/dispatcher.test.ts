import { describe, expect, it } from "vitest";
import { dispatchTelegramWebhookUpdate } from "../dispatcher";
import type { TelegramConfig } from "../config";
import type { RemoteOrderRequest } from "../backend-client";

const baseConfig: TelegramConfig = {
  enabled: true,
  runtimeMode: "webhook",
  mutationsEnabled: true,
  aiOrderingEnabled: true,
  botToken: "unused",
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

class FakeBackend {
  sessions = new Map<string, Record<string, unknown>>();

  async getSession(userId: string) {
    return { data: { channel: "telegram", channelUserId: userId, operatorId: "op_a", state: this.sessions.get(userId) || {}, expiresAt: null, updatedAt: null } };
  }

  async updateSession(userId: string, state: Record<string, unknown>) {
    this.sessions.set(userId, state);
    return { data: { channel: "telegram", channelUserId: userId, operatorId: "op_a", state, expiresAt: null, updatedAt: null } };
  }

  async draftAiOrder(_userId: string, text: string) {
    return {
      data: {
        items: [{ variantId: "var_a", quantity: 1, productName: "Merchant A Mint", sku: "A-MINT" }],
        paymentMethod: "cod",
        note: `AI Telegram draft: ${text}`,
        confidence: "medium" as const,
        parser: "test",
        queryText: "mint",
        clarification: null,
      },
    };
  }

  async draftTelegramSalesOrder(userId: string, text: string) {
    return this.draftAiOrder(userId, text);
  }

  async listTelegramSalesCatalog() {
    return {
      data: [{
        productId: "prod_a",
        variantId: "var_a",
        title: "Merchant A Mint",
        status: "published",
        imageUrl: "https://cdn.example.test/a-mint.jpg",
        categories: [{ id: "cat_a", name: "Mint", handle: "mint" }],
        categoryName: "Mint",
        categoryHandle: "mint",
        sku: "A-MINT",
        barcode: "",
        price: 250000,
        currencyCode: "vnd",
        availability: "available",
        canOrder: true,
      }],
    };
  }

  async createRemoteOrder(_userId: string, _input: RemoteOrderRequest, _idempotencyKey: string) {
    throw new Error("confirm should not run during draft dispatch");
  }
}

class FakeTelegram {
  messages: Array<{ chatId: number | string; text: string }> = [];
  async sendMessage(chatId: number | string, text: string) {
    this.messages.push({ chatId, text });
  }
  async answerCallbackQuery() {}
  async sendDocument() {}
}

describe("Telegram webhook dispatcher", () => {
  it("dispatches a merchant-scoped bot update without creating an order before confirmation", async () => {
    const backend = new FakeBackend();
    const telegram = new FakeTelegram();

    await dispatchTelegramWebhookUpdate({
      baseConfig,
      config: { id: "bot_a", merchantId: "merchant_a", tokenSecretRef: "env:BOT_A_TOKEN", defaultStoreId: "store_a" },
      update: { update_id: 10, message: { message_id: 10, text: "/order mint", chat: { id: 123 }, from: { id: 42 } } },
      tokenResolver: () => "bot-token-a",
      backend: backend as never,
      telegram: telegram as never,
    });

    expect(backend.sessions.get("42")?.cartItems).toEqual([
      expect.objectContaining({ variantId: "var_a", quantity: 1 }),
    ]);
    expect(telegram.messages.at(-1)?.text).toContain("Added the matched product to your cart.");

    await dispatchTelegramWebhookUpdate({
      baseConfig,
      config: { id: "bot_a", merchantId: "merchant_a", tokenSecretRef: "env:BOT_A_TOKEN", defaultStoreId: "store_a" },
      update: {
        update_id: 11,
        callback_query: {
          id: "cb_11",
          data: "sales_cart:checkout",
          message: { message_id: 11, text: "", chat: { id: 123 } },
          from: { id: 42 },
        },
      },
      tokenResolver: () => "bot-token-a",
      backend: backend as never,
      telegram: telegram as never,
    });

    const state = backend.sessions.get("42");
    expect(state?.binding).toEqual({ merchantId: "merchant_a", storeId: "store_a", telegramUserId: "42" });
    expect(state?.requestedStoreId).toBe("store_a");
    expect(state?.pendingAction).toBe("checkout_address");
    expect(telegram.messages.at(-1)?.text).toContain("Send your delivery address");
  });
});
