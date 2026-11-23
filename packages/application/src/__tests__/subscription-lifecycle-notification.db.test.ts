import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DeliveryResult, TransactionalEmailMessage, TransactionalEmailProvider } from "../email/provider";
import { TestEmailProvider } from "../email/test-adapter";
import { connectPlatformClient, type PoolClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import {
  deliverSubscriptionLifecycleNotifications,
  queueSubscriptionLifecycleNotifications,
} from "../services/subscription-lifecycle-notification-service";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../db/migrations");
const migration002 = readFileSync(resolve(MIGRATIONS_DIR, "002_tenant_foundation_expand.sql"), "utf8");
const migration006 = readFileSync(resolve(MIGRATIONS_DIR, "006_signup_identity_and_verification.sql"), "utf8");
const migration011Lifecycle = readFileSync(resolve(MIGRATIONS_DIR, "011_subscription_lifecycle_notifications.sql"), "utf8");
const SUB_A = "lifecycle_notify_sub_a";
const SUB_B = "lifecycle_notify_sub_b";
const OWNER_A = "lifecycle_notify_owner_a";
const OWNER_B = "lifecycle_notify_owner_b";
const EMAIL_A = "lifecycle-notify-a@example.test";
const EMAIL_B = "lifecycle-notify-b@example.test";

let client: PoolClient;

function merchantIdFromEmail(email: string): string {
  return `m_${createHash("sha256").update(`merchant:${email}`).digest("hex").slice(0, 16)}`;
}

const MERCHANT_A = merchantIdFromEmail(EMAIL_A);
const MERCHANT_B = merchantIdFromEmail(EMAIL_B);

async function cleanup() {
  await client.query("DELETE FROM app.subscription_notifications WHERE merchant_id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
  await client.query("DELETE FROM app.subscription_events WHERE merchant_id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
  await client.query("DELETE FROM app.merchant_subscriptions WHERE id IN ($1, $2)", [SUB_A, SUB_B]).catch(() => undefined);
  await client.query("DELETE FROM app.operator_memberships WHERE operator_id IN ($1, $2)", [OWNER_A, OWNER_B]).catch(() => undefined);
  await client.query("DELETE FROM app.signup_requests WHERE normalized_email IN ($1, $2)", [EMAIL_A, EMAIL_B]).catch(() => undefined);
  await client.query("DELETE FROM app.stores WHERE id IN ('lifecycle_notify_store_a', 'lifecycle_notify_store_b')").catch(() => undefined);
  await client.query("DELETE FROM public.stock_location WHERE id IN ('lifecycle_notify_store_a_sloc', 'lifecycle_notify_store_b_sloc')").catch(() => undefined);
  await client.query("DELETE FROM app.merchants WHERE id IN ($1, $2)", [MERCHANT_A, MERCHANT_B]).catch(() => undefined);
}

async function seedMerchant(merchantId: string, subscriptionId: string, operatorId: string, email: string, membershipStatus = "active") {
  const catalog = await client.query<{ id: string }>("SELECT id FROM app.package_catalog_versions WHERE package_key = 'plus' ORDER BY effective_from DESC LIMIT 1");
  const catalogId = catalog.rows[0]?.id;
  if (!catalogId) throw new Error("missing plus catalog seed");
  const storeId = merchantId === MERCHANT_A ? "lifecycle_notify_store_a" : "lifecycle_notify_store_b";
  await client.query("INSERT INTO app.merchants (id, display_name, legacy_organization_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [merchantId, merchantId, `org_${merchantId}`]);
  await client.query("INSERT INTO public.stock_location (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [`${storeId}_sloc`, storeId]);
  await client.query("INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary) VALUES ($1, $2, $3, $4, true) ON CONFLICT (id) DO NOTHING", [storeId, merchantId, storeId, `${storeId}_sloc`]);
  await client.query(`
    INSERT INTO app.merchant_subscriptions (
      id, merchant_id, package_key, catalog_version_id, status,
      current_period_start, current_period_end, grace_ends_at, primary_store_id, usage_anchor_day
    ) VALUES ($1, $2, 'plus', $3, 'active', '2026-06-20T00:00:00Z', '2027-06-20T00:00:00Z', '2027-06-27T00:00:00Z', $4, 20)
  `, [subscriptionId, merchantId, catalogId, storeId]);
  await client.query(`
    INSERT INTO app.signup_requests (id, normalized_email, email_hash, password_hash, status)
    VALUES ($1, $2, $3, 'not-used-in-notification-test', 'provisioned')
  `, [`signup_${merchantId}`, email, createHash("sha256").update(email).digest("hex")]);
  // Notification scenarios require an existing owner, independent of sub-millisecond clock boundaries.
  await client.query(`
    INSERT INTO app.operator_memberships (operator_id, scope_type, merchant_id, role_key, status, granted_by, valid_from)
    VALUES ($1, 'merchant', $2, 'owner', $3, 'system',clock_timestamp()-interval '1 day')
  `, [operatorId, merchantId, membershipStatus]);
}

async function insertEvent(merchantId: string, subscriptionId: string, eventType: string, offset: number | null = null) {
  const result = await client.query<{ id: string }>(`
    INSERT INTO app.subscription_events (merchant_id, subscription_id, event_type, reminder_offset_days, period_end, payload)
    VALUES ($1, $2, $3, $4, '2027-06-20T00:00:00Z', '{"packageKey":"plus"}'::jsonb)
    RETURNING id
  `, [merchantId, subscriptionId, eventType, offset]);
  return result.rows[0]?.id;
}

function queueFixtureNotifications() {
  return queueSubscriptionLifecycleNotifications({ merchantIds: [MERCHANT_A, MERCHANT_B] });
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query(migration002);
  await client.query(migration006);
  await client.query(migration011Lifecycle);
}, 30_000);

beforeEach(async () => {
  await cleanup();
  await seedMerchant(MERCHANT_A, SUB_A, OWNER_A, EMAIL_A);
  await seedMerchant(MERCHANT_B, SUB_B, OWNER_B, EMAIL_B, "disabled");
});

afterAll(async () => {
  await cleanup().catch(() => undefined);
  client.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("subscription lifecycle notification outbox", () => {
  it("creates one merchant-scoped lifecycle job despite duplicate scheduler dispatch", async () => {
    await insertEvent(MERCHANT_A, SUB_A, "subscription.renewal_reminder", 7);
    await insertEvent(MERCHANT_B, SUB_B, "subscription.expired");

    expect(await queueFixtureNotifications()).toEqual({ queued: 1, skipped: 1 });
    expect(await queueFixtureNotifications()).toEqual({ queued: 0, skipped: 0 });

    const provider = new TestEmailProvider();
    expect(await deliverSubscriptionLifecycleNotifications(provider)).toEqual({ sent: 1, failed: 0, deferred: 0 });
    expect(provider.findByRecipient(EMAIL_A)).toHaveLength(1);
    expect(provider.findByRecipient(EMAIL_B)).toHaveLength(0);

    const rows = await client.query<{ delivery_status: string; recipient_operator_id: string | null; recipient_email_hash: string | null }>(`
      SELECT delivery_status, recipient_operator_id, recipient_email_hash
      FROM app.subscription_notifications
      WHERE merchant_id IN ($1, $2)
      ORDER BY merchant_id
    `, [MERCHANT_A, MERCHANT_B]);
    expect(rows.rows).toEqual([
      { delivery_status: "sent", recipient_operator_id: OWNER_A, recipient_email_hash: createHash("sha256").update(EMAIL_A).digest("hex") },
      { delivery_status: "skipped_no_recipient", recipient_operator_id: null, recipient_email_hash: null },
    ]);
  });

  it("preserves retryable provider failure without mutating the subscription", async () => {
    await insertEvent(MERCHANT_A, SUB_A, "subscription.expired");
    await queueFixtureNotifications();
    const failingProvider: TransactionalEmailProvider = {
      provider: "test",
      async send(_message: TransactionalEmailMessage): Promise<DeliveryResult> {
        return { provider: "test", status: "failed", errorCode: "simulated", errorMessage: "simulated failure" };
      },
    };

    expect(await deliverSubscriptionLifecycleNotifications(failingProvider)).toEqual({ sent: 0, failed: 1, deferred: 0 });
    const result = await client.query<{ delivery_status: string; attempt_count: number; status: string }>(`
      SELECT notification.delivery_status, notification.attempt_count, subscription.status
      FROM app.subscription_notifications AS notification
      JOIN app.merchant_subscriptions AS subscription ON subscription.id = notification.subscription_id
      WHERE notification.merchant_id = $1
    `, [MERCHANT_A]);
    expect(result.rows[0]).toEqual({ delivery_status: "failed", attempt_count: 1, status: "active" });
  });

  it("records a missing owner as skipped without selecting another merchant's owner", async () => {
    await client.query("DELETE FROM app.operator_memberships WHERE operator_id = $1", [OWNER_B]);
    await insertEvent(MERCHANT_B, SUB_B, "subscription.entered_grace");

    expect(await queueFixtureNotifications()).toEqual({ queued: 0, skipped: 1 });
    const row = await client.query<{ delivery_status: string; recipient_operator_id: string | null }>(`
      SELECT delivery_status, recipient_operator_id
      FROM app.subscription_notifications
      WHERE merchant_id = $1
    `, [MERCHANT_B]);
    expect(row.rows[0]).toEqual({ delivery_status: "skipped_no_recipient", recipient_operator_id: null });
  });

  it("does not regress state when an out-of-order renewed event is delivered after expiry evidence", async () => {
    await client.query("UPDATE app.merchant_subscriptions SET status = 'expired' WHERE id = $1", [SUB_A]);
    await insertEvent(MERCHANT_A, SUB_A, "subscription.expired");
    await insertEvent(MERCHANT_A, SUB_A, "subscription.renewed");
    await queueFixtureNotifications();

    const provider = new TestEmailProvider();
    expect(await deliverSubscriptionLifecycleNotifications(provider)).toEqual({ sent: 2, failed: 0, deferred: 0 });
    const state = await client.query<{ status: string }>("SELECT status FROM app.merchant_subscriptions WHERE id = $1", [SUB_A]);
    expect(state.rows[0]?.status).toBe("expired");
    expect(provider.findByTemplate("subscription.expired")).toHaveLength(1);
    expect(provider.findByTemplate("subscription.renewal_applied")).toHaveLength(1);
  });

  it("permanently excludes noncanonical reminder rows from dispatch selection", async () => {
    await insertEvent(MERCHANT_A, SUB_A, "subscription.renewal_reminder");

    expect(await queueFixtureNotifications()).toEqual({ queued: 0, skipped: 0 });
    expect(await queueFixtureNotifications()).toEqual({ queued: 0, skipped: 0 });
    const notifications = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM app.subscription_notifications WHERE merchant_id = $1", [MERCHANT_A]);
    expect(notifications.rows[0]?.count).toBe("0");
  });

  it("retries an ambiguous accepted send with the same provider idempotency key", async () => {
    await insertEvent(MERCHANT_A, SUB_A, "subscription.renewal_reminder", 7);
    await queueFixtureNotifications();
    const seenKeys = new Set<string>();
    const calls: string[] = [];
    const ambiguousProvider: TransactionalEmailProvider = {
      provider: "test",
      async send(message: TransactionalEmailMessage): Promise<DeliveryResult> {
        const key = message.idempotencyKey || "";
        calls.push(key);
        if (!seenKeys.has(key)) {
          seenKeys.add(key); // provider accepted the first request, but its response was lost.
          return { provider: "test", status: "deferred", errorCode: "timeout_after_accept" };
        }
        return { provider: "test", status: "sent", messageId: "same-provider-message" };
      },
    };

    expect(await deliverSubscriptionLifecycleNotifications(ambiguousProvider, { now: new Date("2027-06-20T00:00:00.000Z") })).toEqual({ sent: 0, failed: 0, deferred: 1 });
    expect(await deliverSubscriptionLifecycleNotifications(ambiguousProvider, { now: new Date("2027-06-20T00:02:00.000Z") })).toEqual({ sent: 1, failed: 0, deferred: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeTruthy();
    expect(calls[1]).toBe(calls[0]);
    expect(seenKeys).toHaveLength(1);
  });

  it("reapplying migration 011 preserves unrelated dependent triggers", async () => {
    await client.query(`
      CREATE TRIGGER lifecycle_notification_reapply_safety_trg
      BEFORE INSERT ON app.signup_requests
      FOR EACH ROW EXECUTE FUNCTION app.signup_requests_set_owner_merchant_id()
    `);
    await client.query(migration011Lifecycle);
    await client.query(migration011Lifecycle);
    const trigger = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_trigger
      WHERE tgrelid = 'app.signup_requests'::regclass
        AND tgname = 'lifecycle_notification_reapply_safety_trg'
        AND NOT tgisinternal
    `);
    expect(trigger.rows[0]?.count).toBe("1");
    await client.query("DROP TRIGGER lifecycle_notification_reapply_safety_trg ON app.signup_requests");
  });
});
