import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import {
  claimTelegramNotifications,
  markTelegramNotificationSent,
  processOutboxEvent,
  shutdownPlatformDb,
} from "../platform-db";
import { createRemoteOrder, refundOrder } from "../services/order-service";
import { resolveChannelActor } from "../services/channel-auth-service";
import { queryOne } from "../db/query";

const originalTelegramToken = process.env.TELEGRAM_SERVICE_TOKEN;
const serviceToken = "db-test-telegram-service-token-32-chars";
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const runKey = runId.replace(/[^a-zA-Z0-9_]/g, "_");
const telegramUserId = `db_test_${runId}`;
const notificationOrganizationId = `org_channel_notify_${runKey}`;
const notificationMerchantId = `merchant_channel_notify_${runKey}`;
const notificationOperatorId = `op_channel_notify_${runKey}`;
const notificationProviderUserId = `channel_notify_${runId}`;
const variantId = "var_mint_20";

let client: PoolClient;
let baselineStock = 0;

async function stockForVariant(): Promise<number> {
  const row = await queryOne<{ stocked_quantity: string }>(client, `
    SELECT il.stocked_quantity::numeric AS stocked_quantity
    FROM public.product_variant_inventory_item vii
    JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id AND il.deleted_at IS NULL
    WHERE vii.variant_id = $1 AND vii.deleted_at IS NULL
      AND il.location_id = 'sloc_default'
    LIMIT 1
  `, [variantId]);
  return Number(row?.stocked_quantity || 0);
}

beforeAll(async () => {
  process.env.TELEGRAM_SERVICE_TOKEN = serviceToken;
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  baselineStock = await stockForVariant();
  if (baselineStock < 3) {
    await client.query(`
      UPDATE public.inventory_level il
      SET stocked_quantity = 10, updated_at = now()
      FROM public.product_variant_inventory_item vii
      WHERE vii.inventory_item_id = il.inventory_item_id
        AND vii.variant_id = $1
        AND il.location_id = 'sloc_default'
        AND il.deleted_at IS NULL
        AND vii.deleted_at IS NULL
    `, [variantId]);
    baselineStock = await stockForVariant();
  }

  await client.query(
    "DELETE FROM app.operator_identities WHERE provider = 'telegram' AND operator_id = 'op_owner'",
  );
  await client.query(`
    INSERT INTO app.operator_identities (provider, provider_user_id, operator_id, display_name, is_active, verified_at)
    VALUES ('telegram', $1, 'op_owner', 'DB Test Owner', true, now())
    ON CONFLICT (organization_id, provider, provider_user_id) WHERE merchant_id IS NULL DO UPDATE SET
      operator_id = EXCLUDED.operator_id,
      display_name = EXCLUDED.display_name,
      is_active = true,
      verified_at = now(),
      updated_at = now()
  `, [telegramUserId]);
  await client.query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id, status)
    VALUES ($1, $2, $3, 'active')
    ON CONFLICT (id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      legacy_organization_id = EXCLUDED.legacy_organization_id,
      status = 'active',
      updated_at = now()
  `, [notificationMerchantId, `DB Test ${runId} Notification Merchant`, notificationOrganizationId]);
  await client.query(`
    DELETE FROM app.operator_identities
    WHERE provider = 'telegram'
      AND (provider_user_id = $1 OR operator_id = $2)
  `, [notificationProviderUserId, notificationOperatorId]);
  await client.query(`
    INSERT INTO app.operator_identities (
      organization_id,
      merchant_id,
      provider,
      provider_user_id,
      operator_id,
      display_name,
      is_active,
      verified_at
    )
    VALUES ($1, $2, 'telegram', $3, $4, 'DB Test Notification Operator', true, now())
  `, [notificationOrganizationId, notificationMerchantId, notificationProviderUserId, notificationOperatorId]);
  await client.query("DELETE FROM notification.telegram_notifications WHERE source_event_id LIKE 'db-test:%'");
});

afterAll(async () => {
  await client?.query(`
    UPDATE public.inventory_level il
    SET stocked_quantity = GREATEST(stocked_quantity, $2), updated_at = now()
    FROM public.product_variant_inventory_item vii
    WHERE vii.inventory_item_id = il.inventory_item_id
      AND vii.variant_id = $1
      AND il.location_id = 'sloc_default'
      AND il.deleted_at IS NULL
      AND vii.deleted_at IS NULL
  `, [variantId, baselineStock]).catch(() => undefined);
  await client?.query("DELETE FROM app.operator_identities WHERE provider = 'telegram' AND provider_user_id = $1", [telegramUserId]).catch(() => undefined);
  await client?.query("DELETE FROM app.operator_identities WHERE provider = 'telegram' AND provider_user_id = $1", [notificationProviderUserId]).catch(() => undefined);
  await client?.query("DELETE FROM notification.telegram_notifications WHERE source_event_id LIKE 'db-test:%'").catch(() => undefined);
  await client?.query("DELETE FROM app.merchants WHERE id = $1", [notificationMerchantId]).catch(() => undefined);
  client?.release();
  if (originalTelegramToken === undefined) delete process.env.TELEGRAM_SERVICE_TOKEN;
  else process.env.TELEGRAM_SERVICE_TOKEN = originalTelegramToken;
  await shutdownPlatformDb().catch(() => undefined);
});

describe("channel remote order PostgreSQL integration", () => {
  it("resolves Telegram identity to a permissioned channel actor", async () => {
    const actor = await resolveChannelActor({
      authorization: `Bearer ${serviceToken}`,
      "x-channel": "telegram",
      "x-channel-user-id": telegramUserId,
      "x-request-id": `db-test-${runId}`,
    });

    expect(actor).toMatchObject({
      operatorId: "op_owner",
      role: "owner",
      channel: "telegram",
      channelUserId: telegramUserId,
    });
    expect(actor.permissions).toEqual(expect.arrayContaining(["remote_order:create", "order:refund"]));
  });

  it("queues Telegram notifications from outbox events and exposes them to the adapter over HTTP service auth", async () => {
    const eventId = `db-test:${runId}:telegram-notification`;
    await processOutboxEvent({
      id: eventId,
      eventType: "telegram.notification.requested",
      payload: {
        organizationId: notificationOrganizationId,
        merchantId: notificationMerchantId,
        recipientOperatorId: notificationOperatorId,
        template: "daily_summary",
        payload: {
          order_count: 2,
          gross_sales: 500000,
          low_stock: 1,
        },
      },
    });
    await processOutboxEvent({
      id: eventId,
      eventType: "telegram.notification.requested",
      payload: {
        organizationId: notificationOrganizationId,
        merchantId: notificationMerchantId,
        recipientOperatorId: notificationOperatorId,
        template: "daily_summary",
        payload: { order_count: 2, gross_sales: 500000, low_stock: 1 },
      },
    });

    const rows = await client.query(
      "SELECT id::text, status FROM notification.telegram_notifications WHERE source_event_id = $1",
      [eventId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe("pending");

    const serviceHeaders = {
      authorization: `Bearer ${serviceToken}`,
      "x-channel": "telegram",
      "x-merchant-id": notificationMerchantId,
      "x-request-id": `db-test-${runId}-notification`,
    };
    const claimed = await claimTelegramNotifications(serviceHeaders, 5);
    const notification = claimed.data.find((item) => item.id === rows.rows[0].id);

    expect(notification).toMatchObject({
      telegramUserId: notificationProviderUserId,
      recipientOperatorId: notificationOperatorId,
      template: "daily_summary",
      attempts: 1,
    });
    expect(notification?.text).toContain("Bao cao ngay");
    expect(notification?.text).toContain("500.000 VND");

    await markTelegramNotificationSent(serviceHeaders, String(notification?.id));
    const sent = await client.query(
      "SELECT status, sent_at FROM notification.telegram_notifications WHERE id = $1",
      [notification?.id],
    );
    expect(sent.rows[0].status).toBe("sent");
    expect(sent.rows[0].sent_at).toBeTruthy();
  });

  it("creates a remote paid order idempotently and records ledger, audit, stock, and outbox effects", async () => {
    const actor = await resolveChannelActor({
      authorization: `Bearer ${serviceToken}`,
      "x-channel": "telegram",
      "x-channel-user-id": telegramUserId,
      "x-request-id": `db-test-${runId}`,
    });
    const headers = { "idempotency-key": `db-test:${runId}:remote-order` };
    const body = {
      customerId: "cus_demo",
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cod",
      note: "DB integration remote order",
      status: "confirmed" as const,
    };

    const created = await createRemoteOrder(headers, body, actor, { scopeKind: "operating", merchantId: "merchant_default", storeId: "store_default", stockLocationId: "sloc_default" });
    const replay = await createRemoteOrder(headers, body, actor, { scopeKind: "operating", merchantId: "merchant_default", storeId: "store_default", stockLocationId: "sloc_default" });

    expect(created.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.response).toEqual(created.response);

    const order = created.response.data;
    expect(order).toMatchObject({
      remoteStatus: "confirmed",
      medusaStatus: "completed",
      paymentStatus: "posted",
    });

    await expect(stockForVariant()).resolves.toBe(baselineStock - 1);

    const payments = await client.query(`
      SELECT direction, method, amount::numeric AS amount, status, metadata
      FROM app.payment_entries
      WHERE order_id = $1
      ORDER BY created_at ASC
    `, [order.orderId]);
    expect(payments.rows).toHaveLength(1);
    expect(payments.rows[0]).toMatchObject({
      direction: "charge",
      method: "cod",
      status: "posted",
    });
    expect(payments.rows[0].metadata).toMatchObject({
      source: "remote",
      channel: "telegram",
      channelUserId: telegramUserId,
    });

    const audit = await client.query(`
      SELECT action, channel, channel_user_id
      FROM audit.events
      WHERE subject_type = 'order' AND subject_id = $1
      ORDER BY created_at ASC
    `, [order.orderId]);
    expect(audit.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "order.remote_created",
        channel: "telegram",
        channel_user_id: telegramUserId,
      }),
    ]));

    const outbox = await client.query(`
      SELECT event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1
      ORDER BY created_at ASC
    `, [order.orderId]);
    expect(outbox.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: "sale.created",
        payload: expect.objectContaining({
          source: "remote",
          channel: "telegram",
          channelUserId: telegramUserId,
        }),
      }),
    ]));

    const refunded = await refundOrder(
      { "idempotency-key": `db-test:${runId}:refund` },
      String(order.orderId),
      {
        amount: Number(payments.rows[0].amount),
        reason: "DB integration refund",
        confirmationToken: `refund-${runId}`,
      },
      actor,
      {
        merchantId: "merchant_default",
        storeId: "store_default",
      },
    );

    expect(refunded.statusCode).toBe(201);
    expect(refunded.response.data).toMatchObject({
      orderId: order.orderId,
      status: "refunded",
      restock: false,
    });

    const ledgerAfterRefund = await client.query(`
      SELECT direction, status, reason, metadata
      FROM app.payment_entries
      WHERE order_id = $1
      ORDER BY created_at ASC
    `, [order.orderId]);
    expect(ledgerAfterRefund.rows.map(row => row.direction)).toEqual(["charge", "refund"]);
    expect(ledgerAfterRefund.rows[1]).toMatchObject({
      status: "posted",
      reason: "DB integration refund",
      metadata: expect.objectContaining({
        source: "channel",
        channel: "telegram",
        restock: false,
      }),
    });
    await expect(stockForVariant()).resolves.toBe(baselineStock - 1);

    const refundOutbox = await queryOne<{
      id: string;
      event_type: string;
      payload: Record<string, unknown>;
    }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'refund.created'
      ORDER BY created_at DESC
      LIMIT 1
    `, [order.orderId]);
    expect(refundOutbox).toBeTruthy();
    await processOutboxEvent({
      id: String(refundOutbox?.id),
      eventType: String(refundOutbox?.event_type),
      payload: refundOutbox?.payload || {},
    });
    await processOutboxEvent({
      id: String(refundOutbox?.id),
      eventType: String(refundOutbox?.event_type),
      payload: refundOutbox?.payload || {},
    });

    const refundJournal = await client.query(`
      SELECT je.id::text, je.reference_type, je.reference_id, a.code, jl.debit_amount::numeric, jl.credit_amount::numeric
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE je.reference_type = 'refund' AND je.reference_id = $1
      ORDER BY a.code ASC
    `, [refunded.response.data.refundEntryId]);
    expect(refundJournal.rows.length).toBeGreaterThanOrEqual(2);
    expect(refundJournal.rows.map(row => row.code)).toEqual(
      expect.arrayContaining(["5111", "CUSTOMER_REFUND_PAYABLE"]),
    );
    const debits = refundJournal.rows.reduce((sum, row) => sum + Number(row.debit_amount || 0), 0);
    const credits = refundJournal.rows.reduce((sum, row) => sum + Number(row.credit_amount || 0), 0);
    expect(debits).toBe(Number(refunded.response.data.amount));
    expect(credits).toBe(Number(refunded.response.data.amount));

    const payoutJournal = await client.query(`
      SELECT a.code, jl.debit_amount::numeric, jl.credit_amount::numeric
      FROM accounting.journal_entries je
      JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
      JOIN accounting.accounts a ON a.id = jl.account_id
      WHERE je.reference_type = 'customer_refund_payout' AND je.reference_id = $1
      ORDER BY a.code ASC
    `, [refunded.response.data.canonicalPaymentEventId]);
    expect(payoutJournal.rows.map((row) => row.code)).toEqual(
      expect.arrayContaining(["CUSTOMER_REFUND_PAYABLE", "1311"]),
    );
    const payoutDebits = payoutJournal.rows.reduce(
      (sum, row) => sum + Number(row.debit_amount || 0),
      0,
    );
    const payoutCredits = payoutJournal.rows.reduce(
      (sum, row) => sum + Number(row.credit_amount || 0),
      0,
    );
    expect(payoutDebits).toBe(Number(refunded.response.data.amount));
    expect(payoutCredits).toBe(Number(refunded.response.data.amount));
  });
});
