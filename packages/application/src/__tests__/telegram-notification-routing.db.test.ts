import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { claimTelegramNotifications, shutdownPlatformDb } from "../platform-db";
import { routeTelegramNotificationEvent } from "../services/telegram-notification-router-service";
import {
  updateTelegramNotificationRecipient,
  updateTelegramNotificationRule,
} from "../services/telegram-notification-settings-service";

const originalToken = process.env.TELEGRAM_SERVICE_TOKEN;
const serviceToken = "db-test-telegram-notification-router-token";
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const runKey = runId.replace(/[^a-zA-Z0-9_]/g, "_");
const organizationId = `org_notify_${runKey}`;
const wrongOrganizationId = `org_notify_wrong_${runKey}`;
const merchantId = `merchant_notify_${runKey}`;
const wrongMerchantId = `merchant_notify_wrong_${runKey}`;
const storeId = `store_notify_${runKey}`;
const stockLocationId = `sloc_notify_${runKey}`;
const ownerTelegramUserId = `notify_owner_${runId}`;
const salesTelegramUserId = `notify_sales_${runId}`;

let client: PoolClient;
let ownerRecipientId = "";
let salesRecipientId = "";
let ownerRuleId = "";
let salesRuleId = "";

const serviceHeaders = {
  authorization: `Bearer ${serviceToken}`,
  "x-channel": "telegram",
  "x-merchant-id": merchantId,
  "x-store-id": storeId,
  "x-request-id": `db-test-notify-${runId}`,
};
const ownerActor = { operatorId: "op_owner", role: "owner", organizationId };
const merchantScope = { scopeKind: "merchant_target" as const, merchantId };

beforeAll(async () => {
  process.env.TELEGRAM_SERVICE_TOKEN = serviceToken;
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id, status)
    VALUES ($1, $2, $3, 'active')
    ON CONFLICT (id) DO UPDATE SET status = 'active', updated_at = now()
  `, [merchantId, `DB Test ${runId} Merchant`, organizationId]);
  await client.query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id, status)
    VALUES ($1, $2, $3, 'active')
    ON CONFLICT (id) DO UPDATE SET status = 'active', updated_at = now()
  `, [wrongMerchantId, `DB Test ${runId} Wrong Merchant`, wrongOrganizationId]);
  await client.query(`
    INSERT INTO public.stock_location (id, name)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, deleted_at = NULL, updated_at = now()
  `, [stockLocationId, `DB Test ${runId} Stock`]);
  await client.query(`
    INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status)
    VALUES ($1, $2, $3, $4, true, 'active')
    ON CONFLICT (id) DO UPDATE SET status = 'active', updated_at = now()
  `, [storeId, merchantId, `DB Test ${runId} Store`, stockLocationId]);
  await client.query("DELETE FROM notification.telegram_notifications WHERE source_event_id LIKE $1", [`db-test-notify:${runId}:%`]);
  await client.query("DELETE FROM notification.telegram_notification_rules WHERE merchant_id = $1 AND name LIKE $2", [merchantId, `DB Test ${runId}%`]);
  await client.query("DELETE FROM notification.telegram_recipients WHERE merchant_id = $1 AND display_name LIKE $2", [merchantId, `DB Test ${runId}%`]);

  const owner = await client.query<{ id: string }>(`
    INSERT INTO notification.telegram_recipients (
      merchant_id, store_id, telegram_user_id, telegram_chat_id, telegram_username,
      display_name, recipient_kind, status, created_by
    )
    VALUES ($1, NULL, $2, $2, 'notify_owner_test', $3, 'owner', 'active', 'op_owner')
    RETURNING id::text
  `, [merchantId, ownerTelegramUserId, `DB Test ${runId} Owner`]);
  ownerRecipientId = owner.rows[0].id;

  const sales = await client.query<{ id: string }>(`
    INSERT INTO notification.telegram_recipients (
      merchant_id, store_id, telegram_user_id, telegram_chat_id, telegram_username,
      display_name, recipient_kind, status, created_by
    )
    VALUES ($1, $2, $3, $3, 'notify_sales_test', $4, 'sales_staff', 'active', 'op_owner')
    RETURNING id::text
  `, [merchantId, storeId, salesTelegramUserId, `DB Test ${runId} Sales`]);
  salesRecipientId = sales.rows[0].id;

  const ownerRule = await client.query<{ id: string }>(`
    INSERT INTO notification.telegram_notification_rules (
      merchant_id, store_id, recipient_id, name, enabled, event_scope, channel_filter, event_types, template_profile, created_by
    )
    VALUES (
      $1,
      NULL,
      $2,
      $3,
      true,
      'orders',
      'all',
      ARRAY[
        'sale.created',
        'telegram_sales_request_created',
        'refund.created',
        'sale.cancelled',
        'order.shipping_adjusted',
        'order.corrected'
      ],
      'owner_all_order_tracking',
      'op_owner'
    )
    RETURNING id::text
  `, [merchantId, ownerRecipientId, `DB Test ${runId} Owner all orders`]);
  ownerRuleId = ownerRule.rows[0].id;

  const salesRule = await client.query<{ id: string }>(`
    INSERT INTO notification.telegram_notification_rules (
      merchant_id, store_id, recipient_id, name, enabled, event_scope, channel_filter, event_types, template_profile, created_by
    )
    VALUES ($1, $2, $3, $4, true, 'telegram_sales', 'telegram', ARRAY['telegram_sales_request_created','sale.created'], 'sales_telegram_only', 'op_owner')
    RETURNING id::text
  `, [merchantId, storeId, salesRecipientId, `DB Test ${runId} Telegram sales`]);
  salesRuleId = salesRule.rows[0].id;
});

afterAll(async () => {
  await client?.query("DELETE FROM notification.telegram_notifications WHERE source_event_id LIKE $1", [`db-test-notify:${runId}:%`]).catch(() => undefined);
  await client?.query("DELETE FROM notification.telegram_notification_rules WHERE id = ANY($1::uuid[])", [[ownerRuleId, salesRuleId].filter(Boolean)]).catch(() => undefined);
  await client?.query("DELETE FROM notification.telegram_recipients WHERE id = ANY($1::uuid[])", [[ownerRecipientId, salesRecipientId].filter(Boolean)]).catch(() => undefined);
  await client?.query("DELETE FROM app.stores WHERE id = $1", [storeId]).catch(() => undefined);
  await client?.query("DELETE FROM public.stock_location WHERE id = $1", [stockLocationId]).catch(() => undefined);
  await client?.query("DELETE FROM app.merchants WHERE id = $1", [wrongMerchantId]).catch(() => undefined);
  await client?.query("DELETE FROM app.merchants WHERE id = $1", [merchantId]).catch(() => undefined);
  client?.release();
  if (originalToken === undefined) delete process.env.TELEGRAM_SERVICE_TOKEN;
  else process.env.TELEGRAM_SERVICE_TOKEN = originalToken;
  await shutdownPlatformDb().catch(() => undefined);
});

describe("telegram notification routing PostgreSQL integration", () => {
  it("fans out Telegram sales request events per matching recipient and dedupes per recipient", async () => {
    const eventId = `db-test-notify:${runId}:draft-created`;
    await routeTelegramNotificationEvent(client, {
      id: eventId,
      eventType: "telegram_sales_request_created",
      payload: {
        merchantId,
        storeId,
        channel: "telegram",
        draftId: `draft_${runId}`,
        telegramUserId: `customer_${runId}`,
        telegramUsername: "customer_test",
        total: 500000,
        currencyCode: "vnd",
        portalPath: "/telegram-sales",
      },
    });
    await routeTelegramNotificationEvent(client, {
      id: eventId,
      eventType: "telegram_sales_request_created",
      payload: {
        merchantId,
        storeId,
        channel: "telegram",
        draftId: `draft_${runId}`,
        total: 500000,
      },
    });

    const rows = await client.query<{
      recipient_id: string;
      rule_id: string;
      telegram_chat_id: string;
      recipient_operator_id: string | null;
      dedupe_key: string;
      template: string;
    }>(`
      SELECT recipient_id::text, rule_id::text, telegram_chat_id, recipient_operator_id, dedupe_key, template
      FROM notification.telegram_notifications
      WHERE source_event_id = $1
      ORDER BY recipient_id::text ASC
    `, [eventId]);

    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((row) => row.recipient_id).sort()).toEqual([ownerRecipientId, salesRecipientId].sort());
    expect(rows.rows.map((row) => row.rule_id).sort()).toEqual([ownerRuleId, salesRuleId].sort());
    expect(rows.rows.every((row) => row.recipient_operator_id === null)).toBe(true);
    expect(rows.rows.map((row) => row.dedupe_key).sort()).toEqual([
      `${eventId}:${ownerRecipientId}`,
      `${eventId}:${salesRecipientId}`,
    ].sort());
    expect(rows.rows.every((row) => row.template === "telegram_sales_request_created")).toBe(true);

    const claimed = await claimTelegramNotifications(serviceHeaders, 10);
    const routed = claimed.data.filter((notification) => rows.rows.some((row) => row.recipient_id === notification.recipientId));
    expect(routed.map((notification) => notification.telegramUserId).sort()).toEqual([ownerTelegramUserId, salesTelegramUserId].sort());
    expect(routed.every((notification) => notification.recipientOperatorId === null)).toBe(true);
    expect(routed.every((notification) => notification.text.includes("Telegram sales request moi"))).toBe(true);
  });

  it("does not send POS sale notifications to Telegram-sales-only rules", async () => {
    const eventId = `db-test-notify:${runId}:pos-sale`;
    await routeTelegramNotificationEvent(client, {
      id: eventId,
      eventType: "sale.created",
      payload: {
        merchantId,
        storeId,
        channel: "pos",
        salesChannel: "pos",
        orderId: `order_${runId}`,
        orderNumber: "ORD-POS-1",
        total: 320000,
        paymentMethod: "cod",
      },
    });

    const rows = await client.query<{ recipient_id: string; template: string }>(`
      SELECT recipient_id::text, template
      FROM notification.telegram_notifications
      WHERE source_event_id = $1
    `, [eventId]);

    expect(rows.rows).toEqual([
      {
        recipient_id: ownerRecipientId,
        template: "order_created",
      },
    ]);
  });

  it("routes owner all-channel lifecycle events and does not leak them to another merchant claim", async () => {
    const cases = [
      {
        suffix: "refund",
        eventType: "refund.created",
        template: "refund_created",
        payload: { orderNumber: "ORD-REF-1", amount: 42000, reason: "customer requested" },
      },
      {
        suffix: "cancel",
        eventType: "sale.cancelled",
        template: "order_cancelled",
        payload: { orderNumber: "ORD-CAN-1", reason: "customer cancelled" },
      },
      {
        suffix: "shipping-adjusted",
        eventType: "order.shipping_adjusted",
        template: "order_shipping_adjusted",
        payload: { orderNumber: "ORD-SHIP-1", shippingFee: 50000 },
      },
      {
        suffix: "corrected",
        eventType: "order.corrected",
        template: "order_corrected",
        payload: { orderNumber: "ORD-COR-1", totalDelta: -30000 },
      },
    ];

    for (const item of cases) {
      await routeTelegramNotificationEvent(client, {
        id: `db-test-notify:${runId}:${item.suffix}`,
        eventType: item.eventType,
        payload: {
          merchantId,
          storeId,
          channel: "pos",
          ...item.payload,
        },
      });
    }

    const rows = await client.query<{ id: string; source_event_id: string; recipient_id: string; template: string; text_payload: string }>(`
      SELECT id::text, source_event_id, recipient_id::text, template, payload::text AS text_payload
      FROM notification.telegram_notifications
      WHERE source_event_id = ANY($1::text[])
      ORDER BY source_event_id ASC
    `, [cases.map((item) => `db-test-notify:${runId}:${item.suffix}`)]);

    expect(rows.rows).toHaveLength(cases.length);
    expect(rows.rows.every((row) => row.recipient_id === ownerRecipientId)).toBe(true);
    expect(rows.rows.map((row) => row.template).sort()).toEqual(cases.map((item) => item.template).sort());
    expect(rows.rows.every((row) => row.text_payload.includes('"channel": "pos"'))).toBe(true);

    const wrongMerchantClaim = await claimTelegramNotifications({
      ...serviceHeaders,
      "x-merchant-id": wrongMerchantId,
      "x-request-id": `db-test-notify-${runId}-wrong-merchant`,
    }, 25);
    const lifecycleNotificationIds = new Set(rows.rows.map((row) => row.id));
    expect(wrongMerchantClaim.data.some((notification) => lifecycleNotificationIds.has(notification.id))).toBe(false);
  });

  it("updates recipients and rules without locking nullable joined store rows", async () => {
    const disabledRecipient = await updateTelegramNotificationRecipient(
      merchantId,
      salesRecipientId,
      { status: "disabled" },
      ownerActor,
      merchantScope,
    );
    expect(disabledRecipient.data.status).toBe("disabled");

    const enabledRecipient = await updateTelegramNotificationRecipient(
      merchantId,
      salesRecipientId,
      { status: "active" },
      ownerActor,
      merchantScope,
    );
    expect(enabledRecipient.data.status).toBe("active");

    const disabledRule = await updateTelegramNotificationRule(
      merchantId,
      salesRuleId,
      { enabled: false },
      ownerActor,
      merchantScope,
    );
    expect(disabledRule.data.enabled).toBe(false);

    const enabledRule = await updateTelegramNotificationRule(
      merchantId,
      salesRuleId,
      { enabled: true },
      ownerActor,
      merchantScope,
    );
    expect(enabledRule.data.enabled).toBe(true);
  });
});
