import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  client: { query: vi.fn() },
  ensurePlatformSchema: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock("../db/schema", () => ({ ensurePlatformSchema: db.ensurePlatformSchema }));
vi.mock("../db/query", () => ({ queryOne: db.queryOne }));
vi.mock("../db/transaction", () => ({
  withConnectedClient: vi.fn(async (handler: (client: typeof db.client) => Promise<unknown>) => handler(db.client)),
}));

import {
  getTelegramBotConfigReadModel,
  markTelegramBotHeartbeat,
  resolveTelegramWebhookConfig,
  upsertTelegramBotConfig,
} from "../services/telegram-bot-config-service";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "bot_a",
  merchant_id: "merchant_a",
  token_secret_ref: "secret://telegram/bot_a",
  webhook_path_secret_hash: sha256("path-secret"),
  telegram_secret_token_hash: sha256("telegram-secret"),
  default_store_id: "store_a",
  status: "active",
  allowed_commands: ["/sale", 42, "/cancel"],
  health: { ok: true },
  last_heartbeat_at: "2026-09-03T00:00:00.000Z",
  created_at: new Date("2026-09-01T00:00:00.000Z"),
  updated_at: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

describe("Telegram bot configuration service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.client.query.mockResolvedValue({ rows: [] });
  });

  it("returns a secret-free read model with normalized JSON and timestamps", async () => {
    db.queryOne.mockResolvedValue(row());

    const result = await getTelegramBotConfigReadModel("bot_a");

    expect(result.data).toEqual({
      id: "bot_a",
      merchantId: "merchant_a",
      tokenSecretRef: "secret://telegram/bot_a",
      defaultStoreId: "store_a",
      status: "active",
      allowedCommands: ["/sale", "/cancel"],
      health: { ok: true },
      lastHeartbeatAt: "2026-09-03T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(result.data).not.toHaveProperty("webhookPathSecretHash");
    expect(db.ensurePlatformSchema).toHaveBeenCalledOnce();
  });

  it("maps nullable/default fields and rejects unknown ids", async () => {
    db.queryOne.mockResolvedValueOnce(row({
      allowed_commands: null,
      health: null,
      last_heartbeat_at: null,
    }));
    await expect(getTelegramBotConfigReadModel("bot_a")).resolves.toMatchObject({
      data: { allowedCommands: [], health: {}, lastHeartbeatAt: null },
    });

    db.queryOne.mockResolvedValueOnce(null);
    await expect(getTelegramBotConfigReadModel("missing")).rejects.toMatchObject({
      code: "telegram_bot_config_not_found",
      statusCode: 404,
    });
  });

  it.each([
    [{ id: "", merchantId: "m", tokenSecretRef: "r", webhookPathSecret: "p", telegramSecretToken: "t" }, "id"],
    [{ id: "b", merchantId: "", tokenSecretRef: "r", webhookPathSecret: "p", telegramSecretToken: "t" }, "merchantId"],
    [{ id: "b", merchantId: "m", tokenSecretRef: "", webhookPathSecret: "p", telegramSecretToken: "t" }, "tokenSecretRef"],
    [{ id: "b", merchantId: "m", tokenSecretRef: "r", webhookPathSecret: "", telegramSecretToken: "t" }, "webhookPathSecret"],
    [{ id: "b", merchantId: "m", tokenSecretRef: "r", webhookPathSecret: "p", telegramSecretToken: "" }, "telegramSecretToken"],
  ])("rejects an empty required upsert field (%s)", async (input, field) => {
    await expect(upsertTelegramBotConfig(input)).rejects.toMatchObject({ code: "validation_error" });
    expect(db.client.query).not.toHaveBeenCalled();
    expect(String(field)).toBeTruthy();
  });

  it("hashes both presented secrets and applies safe defaults on upsert", async () => {
    db.client.query.mockResolvedValueOnce({ rows: [row({
      default_store_id: null,
      allowed_commands: [],
      health: {},
      last_heartbeat_at: null,
    })] });

    const result = await upsertTelegramBotConfig({
      id: "bot_a",
      merchantId: "merchant_a",
      tokenSecretRef: "secret://telegram/bot_a",
      webhookPathSecret: "path-secret",
      telegramSecretToken: "telegram-secret",
    });

    const params = db.client.query.mock.calls[0][1];
    expect(params).toEqual([
      "bot_a",
      "merchant_a",
      "secret://telegram/bot_a",
      sha256("path-secret"),
      sha256("telegram-secret"),
      null,
      "active",
      "[]",
      "{}",
    ]);
    expect(JSON.stringify(params)).not.toContain("path-secret");
    expect(JSON.stringify(params)).not.toContain("telegram-secret");
    expect(result.data.status).toBe("active");
  });

  it("fails closed for missing, inactive, or mismatched webhook credentials", async () => {
    await expect(resolveTelegramWebhookConfig("", "path", "token")).rejects.toMatchObject({
      code: "telegram_webhook_unauthorized",
    });
    await expect(resolveTelegramWebhookConfig("bot", "", "token")).rejects.toMatchObject({
      code: "telegram_webhook_unauthorized",
    });
    await expect(resolveTelegramWebhookConfig("bot", "path", "")).rejects.toMatchObject({
      code: "telegram_webhook_unauthorized",
    });

    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ status: "disabled" }));
    await expect(resolveTelegramWebhookConfig("bot", "path", "token")).rejects.toMatchObject({ statusCode: 401 });
    await expect(resolveTelegramWebhookConfig("bot", "path", "token")).rejects.toMatchObject({ statusCode: 401 });

    db.queryOne
      .mockResolvedValueOnce(row({ webhook_path_secret_hash: sha256("other") }))
      .mockResolvedValueOnce(row({ telegram_secret_token_hash: sha256("other") }));
    await expect(resolveTelegramWebhookConfig("bot", "path-secret", "telegram-secret")).rejects.toMatchObject({ statusCode: 401 });
    await expect(resolveTelegramWebhookConfig("bot", "path-secret", "telegram-secret")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("resolves active webhook credentials and updates heartbeat health", async () => {
    db.queryOne.mockResolvedValueOnce(row());

    const result = await resolveTelegramWebhookConfig("bot_a", "path-secret", "telegram-secret");

    expect(result).toMatchObject({
      id: "bot_a",
      webhookPathSecretHash: sha256("path-secret"),
      telegramSecretTokenHash: sha256("telegram-secret"),
    });

    await markTelegramBotHeartbeat("bot_a", { polling: "ok" });
    expect(db.client.query).toHaveBeenLastCalledWith(
      expect.stringContaining("last_heartbeat_at = now()"),
      ["bot_a", '{"polling":"ok"}'],
    );
    await markTelegramBotHeartbeat("bot_a");
    expect(db.client.query).toHaveBeenLastCalledWith(expect.any(String), ["bot_a", "{}"]);
  });
});
