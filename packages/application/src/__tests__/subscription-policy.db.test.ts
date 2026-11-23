import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import {
  applySubscriptionPurchase,
  getMerchantSubscriptionStatus,
  runSubscriptionLifecycleScheduler,
} from "../services/subscription-service";
import { resolvePackageEntitlements } from "../services/feature-entitlement-service";
import {
  getOrCreateUsageBucket,
  reserveUsage,
  commitUsage,
  releaseUsage,
} from "../services/subscription-usage-service";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../db/migrations");
const migration004 = readFileSync(resolve(MIGRATIONS_DIR, "004_subscription_billing_and_usage.sql"), "utf8");
const migration018 = readFileSync(resolve(MIGRATIONS_DIR, "018_vision_pos_input_foundation.sql"), "utf8");
const migration019 = readFileSync(resolve(MIGRATIONS_DIR, "019_package_feature_entitlements_rollup.sql"), "utf8");

const TEST_MERCHANT = "merchant_sub_policy_test";
const TEST_STORE = "store_sub_policy_test";
const TEST_LOCATION = "sloc_sub_policy_test";
const TEST_ORG = "org_sub_policy_test";
const TIMEOUTS = { timeout: 30000 };

let client: PoolClient;

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query(migration004);
  await client.query(migration004);
  await client.query(migration018);
  await client.query(migration019);
  await client.query(migration019);
  await client.query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id)
    VALUES ($1, 'Subscription Test Merchant', $2)
    ON CONFLICT (id) DO NOTHING
  `, [TEST_MERCHANT, TEST_ORG]);
  await client.query(`
    INSERT INTO public.stock_location (id, name)
    VALUES ($1, 'Subscription Test Location')
    ON CONFLICT (id) DO NOTHING
  `, [TEST_LOCATION]);
  await client.query(`
    INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status)
    VALUES ($1, $2, 'Subscription Test Store', $3, true, 'active')
    ON CONFLICT (id) DO NOTHING
  `, [TEST_STORE, TEST_MERCHANT, TEST_LOCATION]);
}, 30000);

afterAll(async () => {
  if (client) {
    await client.query("DELETE FROM app.subscription_events WHERE merchant_id = $1", [TEST_MERCHANT]);
    await client.query("DELETE FROM app.subscription_usage_reservations WHERE merchant_id = $1", [TEST_MERCHANT]);
    await client.query("DELETE FROM app.subscription_usage_buckets WHERE merchant_id = $1", [TEST_MERCHANT]);
    await client.query("DELETE FROM app.merchant_subscriptions WHERE merchant_id = $1", [TEST_MERCHANT]);
    await client.query("DELETE FROM app.stores WHERE id = $1", [TEST_STORE]);
    await client.query("DELETE FROM app.merchants WHERE id = $1", [TEST_MERCHANT]);
    client.release();
  }
  await shutdownPlatformDb().catch(() => undefined);
});

async function deleteSubscription() {
  await client.query("DELETE FROM app.subscription_events WHERE merchant_id = $1", [TEST_MERCHANT]);
  await client.query("DELETE FROM app.subscription_usage_reservations WHERE merchant_id = $1", [TEST_MERCHANT]);
  await client.query("DELETE FROM app.subscription_usage_buckets WHERE merchant_id = $1", [TEST_MERCHANT]);
  await client.query("DELETE FROM app.merchant_subscriptions WHERE merchant_id = $1", [TEST_MERCHANT]);
}

describe("subscription billing, usage, and package feature migrations", () => {
  it("seeds the package catalog and applies additive feature-key rollups idempotently", async () => {
    const catalog = await client.query<{ id: string }>(
      "SELECT id FROM app.package_catalog_versions WHERE catalog_version = '1.1.2-annual-v1'"
    );
    expect(catalog.rows.map((r) => r.id).sort()).toEqual([
      "pcv_1_1_2_annual_v1_ai_fan",
      "pcv_1_1_2_annual_v1_basic",
      "pcv_1_1_2_annual_v1_plus",
    ]);
    const row = await client.query<{ annual_price_vnd: string; feature_keys: string[] }>(
      `
        SELECT annual_price_vnd::text, feature_keys
        FROM app.package_catalog_versions
        WHERE id = 'pcv_1_1_2_annual_v1_ai_fan'
      `
    );
    expect(row.rows[0]?.annual_price_vnd).toBe("7188000");
    expect(row.rows[0]?.feature_keys).toEqual(expect.arrayContaining([
      "vision_pos_input",
      "vision_pos_single_capture",
      "vision_correction_report",
    ]));
    expect(row.rows[0]?.feature_keys).not.toContain("vision_pos_bulk_capture");
    expect(row.rows[0]?.feature_keys).not.toContain("vision_debug_image_storage");
    const plus = await client.query<{ feature_keys: string[] }>(
      `
        SELECT feature_keys
        FROM app.package_catalog_versions
        WHERE id = 'pcv_1_1_2_annual_v1_plus'
      `
    );
    expect(plus.rows[0]?.feature_keys).toContain("customer_scan_go");
    expect(plus.rows[0]?.feature_keys).not.toContain("vision_pos_input");
  });

  it("creates a Plus subscription with Feb-29 clamp and correct period end", async () => {
    await deleteSubscription();
    const sub = await applySubscriptionPurchase({
      merchantId: TEST_MERCHANT,
      packageKey: "plus",
      effectiveAt: new Date("2028-02-29T09:00:00.000Z"),
      primaryStoreId: TEST_STORE,
    });
    expect(sub.data.packageKey).toBe("plus");
    expect(sub.data.currentPeriodEnd).toBe("2029-02-28T09:00:00.000Z");
    expect(sub.data.primaryStoreId).toBe(TEST_STORE);
  }, TIMEOUTS.timeout);

  it("reflects active/grace/expired via status clock", async () => {
    await deleteSubscription();
    await applySubscriptionPurchase({
      merchantId: TEST_MERCHANT,
      packageKey: "plus",
      effectiveAt: new Date("2028-02-29T09:00:00.000Z"),
      primaryStoreId: TEST_STORE,
    });
    const active = await getMerchantSubscriptionStatus(TEST_MERCHANT, { now: new Date("2028-08-01T00:00:00.000Z") });
    expect(active.status).toBe("active");

    const grace = await getMerchantSubscriptionStatus(TEST_MERCHANT, { now: new Date("2029-02-28T09:00:01.000Z") });
    expect(grace.status).toBe("grace");

    const expired = await getMerchantSubscriptionStatus(TEST_MERCHANT, { now: new Date("2029-03-07T09:00:00.000Z") });
    expect(expired.status).toBe("expired");
  }, TIMEOUTS.timeout);

  it("emits T-1 renewal reminder and grace/expiry events from scheduler", async () => {
    await deleteSubscription();
    await applySubscriptionPurchase({
      merchantId: TEST_MERCHANT,
      packageKey: "plus",
      effectiveAt: new Date("2028-02-29T09:00:00.000Z"),
      primaryStoreId: TEST_STORE,
    });

    const r1 = await runSubscriptionLifecycleScheduler({ now: new Date("2029-02-27T10:00:00.000Z") });
    expect(r1.data.reminders).toBeGreaterThanOrEqual(1);

    const r2 = await runSubscriptionLifecycleScheduler({ now: new Date("2029-02-28T09:00:01.000Z") });
    expect(r2.data.enteredGrace).toBeGreaterThanOrEqual(1);

    const r3 = await runSubscriptionLifecycleScheduler({ now: new Date("2029-03-07T09:00:00.000Z") });
    expect(r3.data.expired).toBeGreaterThanOrEqual(1);

    const reminderCount = await client.query<{ value: string }>(
      "SELECT count(*)::text AS value FROM app.subscription_events WHERE merchant_id = $1 AND event_type = 'subscription.renewal_reminder'",
      [TEST_MERCHANT]
    );
    expect(Number(reminderCount.rows[0]?.value || 0)).toBeGreaterThanOrEqual(1);
  }, TIMEOUTS.timeout);

  it("reactivates on AI Fan, opens usage windows, and supports reserve/commit/release", async () => {
    await deleteSubscription();
    await applySubscriptionPurchase({
      merchantId: TEST_MERCHANT,
      packageKey: "ai_fan",
      effectiveAt: new Date("2029-03-08T09:00:00.000Z"),
      primaryStoreId: TEST_STORE,
      eventType: "subscription.reactivated",
    });

    const status = await getMerchantSubscriptionStatus(TEST_MERCHANT, { now: new Date("2029-03-08T09:00:00.000Z") });
    expect(status.status).toBe("active");
    expect(status.packageKey).toBe("ai_fan");

    const bucket = await getOrCreateUsageBucket(TEST_MERCHANT, "product_research_runs", {
      now: new Date("2029-03-08T09:00:00.000Z"),
    });
    expect(bucket.includedQuantity).toBe(500);

    const reserved = await reserveUsage({
      merchantId: TEST_MERCHANT,
      metricKey: "product_research_runs",
      reservationToken: `rsv_${TEST_MERCHANT}_r1`,
      quantity: 2,
      now: new Date("2029-03-08T09:00:00.000Z"),
    });
    expect(reserved.data.reservedQuantity).toBe(2);
    expect(reserved.data.usedQuantity).toBe(0);

    const committed = await commitUsage(`rsv_${TEST_MERCHANT}_r1`);
    expect(committed.data.reservedQuantity).toBe(0);
    expect(committed.data.usedQuantity).toBe(2);

    const reserved2 = await reserveUsage({
      merchantId: TEST_MERCHANT,
      metricKey: "telegram_ai_drafts",
      reservationToken: `rsv_${TEST_MERCHANT}_r2`,
      quantity: 5,
      now: new Date("2029-03-08T09:00:00.000Z"),
    });
    expect(reserved2.data.reservedQuantity).toBe(5);

    const released = await releaseUsage(`rsv_${TEST_MERCHANT}_r2`);
    expect(released.data.reservedQuantity).toBe(0);
  }, TIMEOUTS.timeout);

  it("restart does not change purchased subscription state", async () => {
    await deleteSubscription();
    await applySubscriptionPurchase({
      merchantId: TEST_MERCHANT,
      packageKey: "plus",
      effectiveAt: new Date("2029-01-01T00:00:00.000Z"),
      primaryStoreId: TEST_STORE,
    });
    await ensurePlatformSchema();
    const status = await getMerchantSubscriptionStatus(TEST_MERCHANT, { now: new Date("2029-06-01T00:00:00.000Z") });
    expect(status.packageKey).toBe("plus");
    expect(status.status).toBe("active");
  }, TIMEOUTS.timeout);

  it("does not let environment feature flags override a merchant DB subscription", async () => {
    await deleteSubscription();
    await applySubscriptionPurchase({
      merchantId: TEST_MERCHANT,
      packageKey: "basic",
      effectiveAt: new Date("2029-01-01T00:00:00.000Z"),
      primaryStoreId: TEST_STORE,
    });
    const originalFlags = process.env.FEATURE_FLAGS;
    process.env.FEATURE_FLAGS = "sepay_qr_payment,crypto_payment,smart_cross_sell,product_research";
    try {
      const entitlements = await resolvePackageEntitlements({ merchantId: TEST_MERCHANT, client });
      expect(entitlements.packageKey).toBe("basic");
      expect(entitlements.features).toEqual([]);
    } finally {
      if (originalFlags === undefined) delete process.env.FEATURE_FLAGS;
      else process.env.FEATURE_FLAGS = originalFlags;
    }
  }, TIMEOUTS.timeout);

  it("blocks quota-exceeding reservation", async () => {
    await deleteSubscription();
    await applySubscriptionPurchase({
      merchantId: TEST_MERCHANT,
      packageKey: "plus",
      effectiveAt: new Date("2029-01-01T00:00:00.000Z"),
      primaryStoreId: TEST_STORE,
    });
    await expect(
      reserveUsage({
        merchantId: TEST_MERCHANT,
        metricKey: "product_research_runs",
        reservationToken: `rsv_${TEST_MERCHANT}_over`,
        quantity: 99,
        now: new Date("2029-01-15T00:00:00.000Z"),
      })
    ).resolves.toBeDefined();
    await expect(
      reserveUsage({
        merchantId: TEST_MERCHANT,
        metricKey: "product_research_runs",
        reservationToken: `rsv_${TEST_MERCHANT}_over2`,
        quantity: 5,
        now: new Date("2029-01-15T00:00:00.000Z"),
      })
    ).rejects.toMatchObject({ code: "quota_exceeded" });
  }, TIMEOUTS.timeout);
});
