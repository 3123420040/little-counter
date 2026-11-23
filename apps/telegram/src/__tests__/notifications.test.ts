import { describe, expect, it } from "vitest";
import type { BackendClient } from "../backend-client";
import {
  dispatchPendingNotifications,
  dispatchPendingNotificationsSafely,
  pollTelegramUpdatesSafely,
  processTelegramUpdates,
} from "../index";
import { SessionStore } from "../session-store";
import type { TelegramApi, TelegramUpdate } from "../telegram-api";

class FakeBackend {
  sent: string[] = [];
  failed: Array<{ id: string; error: string }> = [];
  clearedSessions: string[] = [];
  failSessionRead = false;

  constructor(private notifications: Array<{ id: string; telegramUserId: string; text: string }>) {}

  async claimNotifications() {
    return {
      data: this.notifications.map((notification) => ({
        ...notification,
        recipientOperatorId: "op_owner",
        template: "daily_summary",
        payload: {},
        attempts: 1,
      })),
    };
  }

  async markNotificationSent(id: string) {
    this.sent.push(id);
  }

  async markNotificationFailed(id: string, error: string) {
    this.failed.push({ id, error });
  }

  async getSession(_userId: string) {
    if (this.failSessionRead) throw new Error("session backend unavailable");
    return {
      data: {
        channel: "telegram" as const,
        channelUserId: "42",
        operatorId: "op_owner",
        state: {},
        expiresAt: null,
        updatedAt: null,
      },
    };
  }

  async clearSession(userId: string) {
    this.clearedSessions.push(userId);
  }
}

class FakeTelegram {
  messages: Array<{ chatId: number | string; text: string }> = [];
  failForChatId?: string;
  failPolling = false;

  async sendMessage(chatId: number | string, text: string) {
    if (String(chatId) === this.failForChatId) {
      throw new Error("telegram unavailable");
    }
    this.messages.push({ chatId, text });
  }

  async answerCallbackQuery() {
    return undefined;
  }

  async getUpdates() {
    if (this.failPolling) throw new Error("telegram polling unavailable");
    return [update("/cancel", 20)];
  }
}

function update(text: string, updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      chat: { id: 9001 },
      from: { id: 42 },
    },
  };
}

function callback(data: string, updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback_${updateId}`,
      data,
      message: {
        message_id: updateId,
        text: "",
        chat: { id: 9001 },
      },
      from: { id: 42 },
    },
  };
}

describe("Telegram notification dispatch", () => {
  it("sends claimed notifications and marks them sent", async () => {
    const backend = new FakeBackend([
      { id: "notif_1", telegramUserId: "123456", text: "Bao cao ngay" },
    ]);
    const telegram = new FakeTelegram();

    await dispatchPendingNotifications(telegram, backend);

    expect(telegram.messages).toEqual([{ chatId: "123456", text: "Bao cao ngay" }]);
    expect(backend.sent).toEqual(["notif_1"]);
    expect(backend.failed).toEqual([]);
  });

  it("marks notification failed when Telegram delivery fails", async () => {
    const backend = new FakeBackend([
      { id: "notif_2", telegramUserId: "999999", text: "Canh bao ton kho" },
    ]);
    const telegram = new FakeTelegram();
    telegram.failForChatId = "999999";

    await dispatchPendingNotifications(telegram, backend);

    expect(telegram.messages).toEqual([]);
    expect(backend.sent).toEqual([]);
    expect(backend.failed).toEqual([{ id: "notif_2", error: "telegram unavailable" }]);
  });

  it("logs notification claim failures without throwing", async () => {
    const backend = {
      async claimNotifications() {
        throw new Error("backend unavailable");
      },
      async markNotificationSent() {
        throw new Error("unexpected sent");
      },
      async markNotificationFailed() {
        throw new Error("unexpected failed");
      },
    };
    const telegram = new FakeTelegram();
    const errors: unknown[][] = [];

    await dispatchPendingNotificationsSafely(
      telegram,
      backend,
      { error: (...args: unknown[]) => errors.push(args) },
    );

    expect(errors[0][0]).toBe("Telegram notification dispatch failed:");
    expect(telegram.messages).toEqual([]);
  });

  it("logs Telegram polling failures and keeps the previous offset", async () => {
    const telegram = new FakeTelegram();
    telegram.failPolling = true;
    const errors: unknown[][] = [];

    const result = await pollTelegramUpdatesSafely(
      telegram as unknown as Pick<TelegramApi, "getUpdates">,
      12,
      25,
      { error: (...args: unknown[]) => errors.push(args) },
    );

    expect(result).toEqual({ updates: [], offset: 12 });
    expect(errors[0][0]).toBe("Telegram update polling failed:");
  });

  it("logs a failed update and continues processing later updates", async () => {
    const backend = new FakeBackend([]);
    backend.failSessionRead = true;
    const telegram = new FakeTelegram();
    const sessions = new SessionStore(backend as unknown as BackendClient);
    const errors: unknown[][] = [];

    const nextOffset = await processTelegramUpdates(
      [
        callback("confirm:create_order:order-1", 10),
        update("/cancel", 11),
      ],
      undefined,
      telegram as unknown as TelegramApi,
      backend as unknown as BackendClient,
      sessions,
      {},
      { error: (...args: unknown[]) => errors.push(args) },
    );

    expect(nextOffset).toBe(12);
    expect(errors[0][0]).toBe("Telegram update handling failed:");
    expect(backend.clearedSessions).toEqual(["42"]);
    expect(telegram.messages).toEqual([{ chatId: 9001, text: "Current action cleared." }]);
  });
});
