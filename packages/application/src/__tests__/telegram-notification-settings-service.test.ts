import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  client: { query: vi.fn() },
  ensurePlatformSchema: vi.fn(),
  queryOne: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("../db/schema", () => ({ ensurePlatformSchema: deps.ensurePlatformSchema }));
vi.mock("../db/query", () => ({ queryOne: deps.queryOne }));
vi.mock("../db/transaction", () => ({
  withConnectedTransaction: vi.fn(async (handler: (client: typeof deps.client) => Promise<unknown>) => handler(deps.client)),
}));
vi.mock("../repositories/audit-repository", () => ({ recordAuditEntry: deps.audit }));
vi.mock("../services/telegram-notification-service", () => ({
  enqueueTelegramNotificationForClient: deps.enqueue,
}));
vi.mock("../services/business-lifecycle-service", () => ({
  lockActiveBusinessScopeForClient: vi.fn().mockResolvedValue(undefined),
}));

import {
  createTelegramNotificationRecipient,
  createTelegramNotificationRule,
  getTelegramNotificationSettings,
  sendTelegramNotificationRecipientTest,
  updateTelegramNotificationRecipient,
  updateTelegramNotificationRule,
} from "../services/telegram-notification-settings-service";

const scope = { scopeKind: "merchant_target" as const, merchantId: "merchant_a" };
const actor = { operatorId: "owner_a", role: "owner" as const, organizationId: "org_a" };
const recipient = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  merchant_id: "merchant_a",
  store_id: "store_a",
  store_name: "Main store",
  telegram_user_id: "tg-user",
  telegram_chat_id: "tg-chat",
  telegram_username: "owner",
  linked_operator_id: "owner_a",
  display_name: "Owner",
  recipient_kind: "owner",
  status: "active",
  created_at: new Date("2026-09-01T00:00:00.000Z"),
  updated_at: "2026-09-02T00:00:00.000Z",
  ...overrides,
});
const rule = (overrides: Record<string, unknown> = {}) => ({
  id: "22222222-2222-4222-8222-222222222222",
  merchant_id: "merchant_a",
  store_id: "store_a",
  store_name: "Main store",
  recipient_id: "11111111-1111-4111-8111-111111111111",
  recipient_display_name: "Owner",
  name: "Sales created",
  enabled: true,
  event_scope: "sales",
  channel_filter: "all",
  event_types: ["sale.created"],
  template_profile: "default",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: new Date("2026-09-02T00:00:00.000Z"),
  ...overrides,
});

describe("Telegram notification settings service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.client.query.mockResolvedValue({ rows: [] });
    deps.audit.mockResolvedValue(undefined);
    deps.enqueue.mockResolvedValue(undefined);
  });

  it("enforces the selected merchant before opening a database transaction", async () => {
    await expect(getTelegramNotificationSettings("merchant_a", { ...scope, merchantId: "merchant_b" }))
      .rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    expect(deps.ensurePlatformSchema).not.toHaveBeenCalled();
  });

  it("maps recipient and rule rows into the owner settings contract", async () => {
    deps.client.query
      .mockResolvedValueOnce({ rows: [recipient()] })
      .mockResolvedValueOnce({ rows: [rule({ event_types: null })] });

    const result = await getTelegramNotificationSettings("merchant_a", scope);

    expect(result.data.recipients[0]).toMatchObject({
      merchantId: "merchant_a",
      storeName: "Main store",
      telegramUserId: "tg-user",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(result.data.rules[0]).toMatchObject({
      recipientDisplayName: "Owner",
      eventTypes: [],
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
  });

  it("creates a normalized recipient and records a secret-free audit", async () => {
    deps.queryOne
      .mockResolvedValueOnce({ id: "store_a" })
      .mockResolvedValueOnce(recipient({ store_name: null, telegram_username: "owner_name", status: "disabled" }));

    const result = await createTelegramNotificationRecipient("merchant_a", {
      storeId: " store_a ",
      telegramUserId: " tg-user ",
      telegramUsername: " @owner_name ",
      displayName: " Owner ",
      recipientKind: "owner",
      status: "disabled",
    }, actor, scope);

    expect(deps.queryOne.mock.calls[1][2]).toEqual(expect.arrayContaining([
      "merchant_a", "store_a", "tg-user", "tg-user", "owner_name", "Owner", "owner", "disabled", "owner_a",
    ]));
    expect(result.data).toMatchObject({ status: "disabled", storeName: null });
    expect(deps.audit).toHaveBeenCalledWith(
      deps.client,
      actor,
      "settings.telegram_recipient.created",
      "telegram_recipient",
      recipient().id,
      expect.objectContaining({ merchantId: "merchant_a", storeId: "store_a" }),
    );
  });

  it("validates recipient fields and store ownership", async () => {
    deps.queryOne.mockResolvedValueOnce(null);
    await expect(createTelegramNotificationRecipient("merchant_a", {
      storeId: "store_other", telegramUserId: "u", displayName: "Owner", recipientKind: "owner",
    }, actor, scope)).rejects.toMatchObject({ code: "validation_error" });

    const invalidInputs = [
      { telegramUserId: "", displayName: "Owner", recipientKind: "owner" },
      { telegramUserId: "u", displayName: "", recipientKind: "owner" },
      { telegramUserId: "u", displayName: "Owner", recipientKind: "invalid" },
      { telegramUserId: "u".repeat(81), displayName: "Owner", recipientKind: "owner" },
    ];
    for (const input of invalidInputs) {
      deps.queryOne.mockReset();
      await expect(createTelegramNotificationRecipient("merchant_a", input as never, actor, scope))
        .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    }
  });

  it("updates every mutable recipient field and preserves omitted fields", async () => {
    deps.queryOne
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce({ id: "store_b" })
      .mockResolvedValueOnce(recipient({
        store_id: "store_b",
        store_name: null,
        telegram_user_id: "new-user",
        telegram_chat_id: null,
        telegram_username: null,
        linked_operator_id: null,
        display_name: "New owner",
        recipient_kind: "ops",
        status: "disabled",
      }));

    const result = await updateTelegramNotificationRecipient("merchant_a", recipient().id, {
      storeId: "store_b",
      telegramUserId: "new-user",
      telegramChatId: null,
      telegramUsername: null,
      linkedOperatorId: null,
      displayName: "New owner",
      recipientKind: "ops",
      status: "disabled",
    }, actor, scope);
    expect(result.data).toMatchObject({ displayName: "New owner", recipientKind: "ops", status: "disabled" });

    deps.queryOne.mockReset();
    deps.queryOne.mockResolvedValueOnce(recipient({ store_id: null })).mockResolvedValueOnce(recipient({ store_id: null }));
    await updateTelegramNotificationRecipient("merchant_a", recipient().id, {}, actor, scope);
    expect(deps.queryOne.mock.calls[1][2]).toEqual(expect.arrayContaining([
      "tg-user", "tg-chat", "owner", "owner_a", "Owner", "owner", "active",
    ]));
  });

  it("reports missing recipients and failed update writes", async () => {
    deps.queryOne.mockResolvedValueOnce(null);
    await expect(updateTelegramNotificationRecipient("merchant_a", recipient().id, {}, actor, scope))
      .rejects.toMatchObject({ code: "resource_not_found", statusCode: 404 });

    deps.queryOne.mockReset();
    deps.queryOne.mockResolvedValueOnce(recipient()).mockResolvedValueOnce({ id: "store_a" }).mockResolvedValueOnce(null);
    await expect(updateTelegramNotificationRecipient("merchant_a", recipient().id, {}, actor, scope))
      .rejects.toMatchObject({ code: "settings_update_failed", statusCode: 500 });
  });

  it("creates a rule with normalized defaults and de-duplicated events", async () => {
    deps.queryOne
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce(recipient())
      .mockResolvedValueOnce(rule({ store_id: null, store_name: null, channel_filter: "all", event_types: ["sale.created"] }));

    const result = await createTelegramNotificationRule("merchant_a", {
      recipientId: recipient().id,
      name: " Sales created ",
      eventScope: " sales ",
      channelFilter: undefined,
      eventTypes: ["sale.created", " sale.created ", ""],
    }, actor, scope);

    expect(deps.queryOne.mock.calls[2][2]).toEqual(expect.arrayContaining([
      "merchant_a", null, recipient().id, "Sales created", true, "sales", "all", ["sale.created"], "default", "owner_a", "Owner",
    ]));
    expect(result.data.eventTypes).toEqual(["sale.created"]);
  });

  it("rejects invalid rule channels, event arrays, and failed inserts", async () => {
    for (const bad of [
      { channelFilter: "email" },
      { eventTypes: "sale.created" },
      { eventTypes: ["x".repeat(121)] },
    ]) {
      deps.queryOne.mockReset();
      deps.queryOne.mockResolvedValue(recipient());
      await expect(createTelegramNotificationRule("merchant_a", {
        recipientId: recipient().id, name: "Rule", eventScope: "sales", ...bad,
      } as never, actor, scope)).rejects.toMatchObject({ code: "validation_error" });
    }

    deps.queryOne.mockReset();
    deps.queryOne.mockResolvedValueOnce(recipient()).mockResolvedValueOnce(recipient()).mockResolvedValueOnce(null);
    await expect(createTelegramNotificationRule("merchant_a", {
      recipientId: recipient().id, name: "Rule", eventScope: "sales",
    }, actor, scope)).rejects.toMatchObject({ code: "settings_update_failed" });
  });

  it("updates rule routing fields and maps a null event list", async () => {
    deps.queryOne
      .mockResolvedValueOnce(rule())
      .mockResolvedValueOnce({ id: "store_b" })
      .mockResolvedValueOnce(recipient({ id: "33333333-3333-4333-8333-333333333333", display_name: "Manager" }))
      .mockResolvedValueOnce(rule({
        store_id: "store_b",
        recipient_id: "33333333-3333-4333-8333-333333333333",
        recipient_display_name: "Manager",
        name: "Updated",
        enabled: false,
        event_scope: "inventory",
        channel_filter: "telegram",
        event_types: null,
        template_profile: "compact",
      }));

    const result = await updateTelegramNotificationRule("merchant_a", rule().id, {
      storeId: "store_b",
      recipientId: "33333333-3333-4333-8333-333333333333",
      name: "Updated",
      enabled: false,
      eventScope: "inventory",
      channelFilter: "TELEGRAM",
      eventTypes: [],
      templateProfile: "compact",
    }, actor, scope);
    expect(result.data).toMatchObject({
      recipientDisplayName: "Manager", enabled: false, channelFilter: "telegram", eventTypes: [],
    });
  });

  it("preserves omitted rule fields and reports missing/failed updates", async () => {
    deps.queryOne.mockResolvedValueOnce(rule({ store_id: null })).mockResolvedValueOnce(recipient()).mockResolvedValueOnce(rule({ store_id: null }));
    await expect(updateTelegramNotificationRule("merchant_a", rule().id, {}, actor, scope)).resolves.toMatchObject({
      data: { name: "Sales created" },
    });

    deps.queryOne.mockReset();
    deps.queryOne.mockResolvedValueOnce(null);
    await expect(updateTelegramNotificationRule("merchant_a", rule().id, {}, actor, scope))
      .rejects.toMatchObject({ code: "resource_not_found" });

    deps.queryOne.mockReset();
    deps.queryOne.mockResolvedValueOnce(rule({ store_id: null })).mockResolvedValueOnce(recipient()).mockResolvedValueOnce(null);
    await expect(updateTelegramNotificationRule("merchant_a", rule().id, {}, actor, scope))
      .rejects.toMatchObject({ code: "settings_update_failed" });
  });

  it("queues a test message only for an active recipient", async () => {
    deps.queryOne.mockResolvedValueOnce(recipient({ status: "disabled" }));
    await expect(sendTelegramNotificationRecipientTest("merchant_a", recipient().id, actor, scope))
      .rejects.toMatchObject({ code: "validation_error" });
    expect(deps.enqueue).not.toHaveBeenCalled();

    deps.queryOne.mockResolvedValueOnce(recipient({ telegram_chat_id: null, store_id: null }));
    await expect(sendTelegramNotificationRecipientTest("merchant_a", recipient().id, { ...actor, organizationId: undefined }, scope))
      .resolves.toEqual({ data: { queued: true, recipientId: recipient().id } });
    expect(deps.enqueue).toHaveBeenCalledWith(
      deps.client,
      expect.stringMatching(/^telegram-test:merchant_a:/),
      expect.objectContaining({
        organizationId: "org_default",
        telegramChatId: "tg-user",
        payload: { text: expect.stringContaining("Recipient: Owner") },
      }),
    );
  });
});
