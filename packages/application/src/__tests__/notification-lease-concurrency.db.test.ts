import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeliveryResult, TransactionalEmailMessage, TransactionalEmailProvider } from "../email/provider";
import { connectPlatformClient, type PoolClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import {
  deliverSubscriptionLifecycleNotifications,
  queueSubscriptionLifecycleNotifications,
} from "../services/subscription-lifecycle-notification-service";

/**
 * Concurrent notification delivery leases.
 *
 * Two workers running deliverSubscriptionLifecycleNotifications concurrently
 * against the same due notification row must produce exactly one concurrent
 * provider send call. The claim/lease written in phase 1 of the worker ensures
 * the second worker cannot reselect the row while the first worker is mid-send.
 */
const MIGRATIONS_DIR = resolve(__dirname, "../../../../db/migrations");
const migration011Lifecycle = readFileSync(resolve(MIGRATIONS_DIR, "011_subscription_lifecycle_notifications.sql"), "utf8");

const SUB_C = "fixture_notify_sub_c";
const OWNER_C = "fixture_notify_owner_c";
const EMAIL_C = "fixture-notify-c@example.test";
const STORE_C = "fixture_notify_store_c";

function merchantIdFromEmail(email: string): string {
  return `m_${createHash("sha256").update(`merchant:${email}`).digest("hex").slice(0, 16)}`;
}

const MERCHANT_C = merchantIdFromEmail(EMAIL_C);

let client: PoolClient;

async function seedMerchant() {
  const catalog = await client.query<{ id: string }>("SELECT id FROM app.package_catalog_versions WHERE package_key = 'plus' ORDER BY effective_from DESC LIMIT 1");
  const catalogId = catalog.rows[0]?.id;
  if (!catalogId) throw new Error("missing plus catalog seed");
  await client.query("INSERT INTO app.merchants (id, display_name, legacy_organization_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [MERCHANT_C, "Notification Fixture C", `org_${MERCHANT_C}`]);
  await client.query("INSERT INTO public.stock_location (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [`${STORE_C}_sloc`, "Notification Fixture C Loc"]);
  await client.query("INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary) VALUES ($1, $2, $3, $4, true) ON CONFLICT (id) DO NOTHING", [STORE_C, MERCHANT_C, "Notification Fixture C Store", `${STORE_C}_sloc`]);
  await client.query(`
    INSERT INTO app.merchant_subscriptions (
      id, merchant_id, package_key, catalog_version_id, status,
      current_period_start, current_period_end, grace_ends_at, primary_store_id, usage_anchor_day
    ) VALUES ($1, $2, 'plus', $3, 'active', '2026-06-20T00:00:00Z', '2027-06-20T00:00:00Z', '2027-06-27T00:00:00Z', $4, 20)
    ON CONFLICT (id) DO NOTHING
  `, [SUB_C, MERCHANT_C, catalogId, STORE_C]);
  await client.query(`
    INSERT INTO app.signup_requests (id, normalized_email, email_hash, password_hash, status)
    VALUES ($1, $2, $3, 'not-used', 'provisioned')
    ON CONFLICT (id) DO NOTHING
  `, [`signup_${MERCHANT_C}`, EMAIL_C, createHash("sha256").update(EMAIL_C).digest("hex")]);
  // Exercise delivery leases with an already active owner, not an activation-time boundary.
  await client.query(`
    INSERT INTO app.operator_memberships (operator_id, scope_type, merchant_id, role_key, status, granted_by, valid_from)
    VALUES ($1, 'merchant', $2, 'owner', 'active', 'system',clock_timestamp()-interval '1 day')
    ON CONFLICT DO NOTHING
  `, [OWNER_C, MERCHANT_C]);
}

async function insertEvent(eventType: string) {
  await client.query(`
    INSERT INTO app.subscription_events (merchant_id, subscription_id, event_type, reminder_offset_days, period_end, payload)
    VALUES ($1, $2, $3, $4, '2027-06-20T00:00:00Z', '{"packageKey":"plus"}'::jsonb)
  `, [MERCHANT_C, SUB_C, eventType, null]);
}

async function resetNotifications() {
  // Per-test reset: only clear notification/event rows so each test starts
  // fresh. The merchant/subscription/store scaffolding is seeded once in
  // beforeAll and torn down in afterAll. Each statement runs in its own
  // BEGIN/COMMIT to avoid the client falling into an aborted-transaction
  // state on a failure.
  const tryQ = async (sql: string, params: unknown[] = []) => {
    try {
      await client.query("BEGIN");
      await client.query(sql, params);
      await client.query("COMMIT");
    } catch {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    }
  };
  await tryQ("DELETE FROM app.subscription_events WHERE merchant_id = $1", [MERCHANT_C]);
  await tryQ("DELETE FROM app.subscription_notifications WHERE merchant_id = $1", [MERCHANT_C]);
}

async function cleanup() {
  await resetNotifications();
  // Each statement runs in its own BEGIN/COMMIT so a failure does not
  // leave the client in an aborted transaction state (which would
  // silently skip all subsequent deletes and orphan the test merchant).
  const tryQ = async (sql: string, params: unknown[] = []) => {
    try {
      await client.query("BEGIN");
      await client.query(sql, params);
      await client.query("COMMIT");
    } catch {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    }
  };
  await tryQ("DELETE FROM app.subscription_notifications WHERE merchant_id = $1", [MERCHANT_C]);
  await tryQ("DELETE FROM app.subscription_events WHERE merchant_id = $1", [MERCHANT_C]);
  await tryQ("DELETE FROM app.merchant_subscriptions WHERE id = $1", [SUB_C]);
  await tryQ("DELETE FROM app.signup_requests WHERE id = $1", [`signup_${MERCHANT_C}`]);
  await tryQ("DELETE FROM app.operator_memberships WHERE operator_id = $1", [OWNER_C]);
  await tryQ("DELETE FROM app.stores WHERE id = $1", [STORE_C]);
  await tryQ("DELETE FROM public.stock_location WHERE id = $1", [`${STORE_C}_sloc`]);
  await tryQ("DELETE FROM app.merchants WHERE id = $1", [MERCHANT_C]);
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  // Ensure the recipient-resolution trigger / owner_merchant_id column exists.
  await client.query(migration011Lifecycle);
  await seedMerchant();
});

afterAll(async () => {
  await cleanup();
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("Concurrent notification lease", () => {
  it("two concurrent workers produce exactly one provider send", async () => {
    await resetNotifications();
    await insertEvent("subscription.expired");

    let sendCallCount = 0;
    let signalSendStarted: () => void = () => {};
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    const countingProvider: TransactionalEmailProvider = {
      provider: "test",
      async send(message: TransactionalEmailMessage): Promise<DeliveryResult> {
        sendCallCount += 1;
        // Hold the provider send in flight briefly so both workers genuinely
        // contend while the lease is held. Without this, the first worker can
        // settle and release the lease before the second worker selects the row.
        signalSendStarted();
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { provider: "test", status: "sent", messageId: `fixture-${message.idempotencyKey}` };
      },
    };

    expect(await queueSubscriptionLifecycleNotifications({ merchantIds: [MERCHANT_C] }))
      .toEqual({ queued: 1, skipped: 0 });

    // Run two workers concurrently against the same due row.
    const now = new Date("2027-06-22T00:00:00.000Z");
    const deliver = Promise.all([
      deliverSubscriptionLifecycleNotifications(countingProvider, { now }, "worker-1"),
      deliverSubscriptionLifecycleNotifications(countingProvider, { now }, "worker-2"),
    ]);
    // Wait until the first provider send is in flight before awaiting, so the
    // lease window is exercised deterministically rather than by scheduling luck.
    await sendStarted;
    const [r1, r2] = await deliver;

    const totalSent = r1.sent + r2.sent;
    // Exactly one worker should have sent the notification. The lease prevents
    // the second worker from reselecting the row.
    expect(totalSent).toBe(1);
    expect(sendCallCount).toBe(1);
  });

  it("a second worker dispatches the row only after the lease is released", async () => {
    await resetNotifications();
    await insertEvent("subscription.expired");
    let sendCallCount = 0;
    const provider: TransactionalEmailProvider = {
      provider: "test",
      async send(message: TransactionalEmailMessage): Promise<DeliveryResult> {
        sendCallCount += 1;
        return { provider: "test", status: "deferred", errorCode: "timeout_after_accept" };
      },
    };
    await queueSubscriptionLifecycleNotifications();
    const now1 = new Date("2027-06-22T00:00:00.000Z");
    const r1 = await deliverSubscriptionLifecycleNotifications(provider, { now: now1 }, "worker-1");
    expect(r1.deferred).toBe(1);
    // The first worker released the lease on outcome. After the retry interval
    // the same row is dispatchable again by another worker.
    const now2 = new Date("2027-06-22T00:02:00.000Z");
    const r2 = await deliverSubscriptionLifecycleNotifications(provider, { now: now2 }, "worker-2");
    expect(r2.deferred).toBe(1);
    expect(sendCallCount).toBe(2);
  });
});
