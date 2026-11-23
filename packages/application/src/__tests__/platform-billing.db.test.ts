import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { queryOne } from "../db/query";
import { withConnectedTransaction } from "../db/transaction";
import {
  applySubscriptionPurchase,
  getMerchantSubscriptionStatus,
} from "../services/subscription-service";
import {
  initiateNewSubscription,
  initiateUpgrade,
  initiateStoreAddon,
  applyBillingOrderToPurchase,
  handlePlatformNowPaymentsWebhook,
} from "../services/subscription-billing-service";
import {
  getBillingOrder,
  updateBillingOrderStatus,
} from "../services/billing-order-service";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../db/migrations");
const migration004 = readFileSync(resolve(MIGRATIONS_DIR, "004_subscription_billing_and_usage.sql"), "utf8");
const migration008 = readFileSync(resolve(MIGRATIONS_DIR, "008_platform_package_billing.sql"), "utf8");

const TEST_MERCHANT = "merchant_billing_test";
const TEST_STORE = "store_billing_test";
const TEST_LOCATION = "sloc_billing_test";
const TEST_ORG = "org_billing_test";
const TIMEOUTS = { timeout: 30000 };

let client: PoolClient;

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query(migration004);
  await client.query(migration008);
  await client.query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id)
    VALUES ($1, 'Billing Test Merchant', $2)
    ON CONFLICT (id) DO NOTHING
  `, [TEST_MERCHANT, TEST_ORG]);
  await client.query(`INSERT INTO public.stock_location (id, name) VALUES ($1, 'Billing Test Loc') ON CONFLICT (id) DO NOTHING`, [TEST_LOCATION]);
  await client.query(`
    INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status)
    VALUES ($1, $2, 'Billing Test Store', $3, true, 'active')
    ON CONFLICT (id) DO NOTHING
  `, [TEST_STORE, TEST_MERCHANT, TEST_LOCATION]);
  await resetMerchant();
}, 30000);

afterAll(async () => {
  if (client) {
    await resetMerchant();
    await client.query("DELETE FROM app.billing_provider_events WHERE provider_event_id LIKE 'evt_billing_test_%'");
    await client.query(`DELETE FROM app.stores WHERE id = $1`, [TEST_STORE]);
    await client.query(`DELETE FROM app.merchants WHERE id = $1`, [TEST_MERCHANT]);
    client.release();
  }
  await shutdownPlatformDb().catch(() => undefined);
});


async function relationCount(relation: string): Promise<string> {
  const [schema, table] = relation.split(".");
  const exists = await client.query<{ c: string }>(`
    SELECT count(*)::text AS c FROM information_schema.tables
    WHERE table_schema = $1 AND table_name = $2
  `, [schema, table]);
  if (exists.rows[0]?.c !== "1") return "missing";
  const result = await client.query<{ c: string }>(`SELECT count(*)::text AS c FROM ${schema}."${table}"`);
  return result.rows[0]?.c || "0";
}

async function resetMerchant() {
  await client.query("DELETE FROM app.billing_provider_events WHERE billing_order_id IN (SELECT id FROM app.billing_orders WHERE merchant_id = $1)", [TEST_MERCHANT]);
  await client.query("DELETE FROM app.billing_orders WHERE merchant_id = $1", [TEST_MERCHANT]);
  await client.query("DELETE FROM app.subscription_events WHERE merchant_id = $1", [TEST_MERCHANT]);
  await client.query("DELETE FROM app.merchant_subscriptions WHERE merchant_id = $1", [TEST_MERCHANT]);
}

describe("008 platform package billing migration", () => {
  it("creates billing_orders and billing_provider_events tables with expected constraints", async () => {
    const billing = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'billing_orders' AND column_name = 'amount_vnd'
    `);
    expect(billing.rows.length).toBe(1);

    const events = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'billing_provider_events' AND column_name = 'provider_event_id'
    `);
    expect(events.rows.length).toBe(1);

    const idempotency = await client.query(`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'app' AND indexname = 'billing_orders_idempotency_idx'
    `);
    expect(idempotency.rows.length).toBe(1);
  });
});

describe("platform billing new-subscription + apply", () => {
  it("creates a Plus billing order from Basic and applies it after payment", async () => {
    await resetMerchant();
    await applySubscriptionPurchase({ merchantId: TEST_MERCHANT, packageKey: "basic", effectiveAt: new Date("2026-06-20T00:00:00Z") });

    const order = await initiateNewSubscription({
      merchantId: TEST_MERCHANT,
      targetPackageKey: "plus",
      requestedBy: "op_owner",
      idempotencyKey: "idem_new_plus",
      quote: {
        vndAmount: "3588000",
        providerCurrency: "usdttrc20",
        providerNetwork: "trc20",
        providerAmount: "142.55",
        providerPaymentId: "np_payment_plus_1",
        quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });

    expect(order.data.amount.amountVnd).toBe("3588000");
    expect(order.data.targetPackageKey).toBe("plus");

    // Snapshot contains tax-inclusive catalog snapshot
    expect(order.data.catalogSnapshot.packageKey).toBe("plus");
    expect(order.data.catalogSnapshot.annualPrice.amountVnd).toBe("3588000");

    // Manually mark paid (simulating webhook match) and apply
    await updateBillingOrderStatus(order.data.billingOrderId, { status: "paid", providerPaymentId: "np_payment_plus_1" });
    const applied = await applyBillingOrderToPurchase(order.data.billingOrderId);
    expect(applied.data.subscriptionStatus.packageKey).toBe("plus");
    expect(applied.data.subscriptionStatus.status).toBe("active");

    // Read model reflects applied
    const reloaded = await getBillingOrder(order.data.billingOrderId);
    expect(reloaded?.status).toBe("applied");
  }, TIMEOUTS.timeout);

  it("creates no retail order, inventory movement, loyalty, or accounting entry", async () => {
    await resetMerchant();
    await applySubscriptionPurchase({ merchantId: TEST_MERCHANT, packageKey: "basic", effectiveAt: new Date("2026-06-20T00:00:00Z") });

    const beforeOrders = await relationCount("public.order");
    const beforeMoves = await relationCount("app.stock_movements");
    const beforeLoyalty = await relationCount("app.loyalty_transactions");
    const beforeJournal = await relationCount("app.journal_entries");

    const order = await initiateNewSubscription({
      merchantId: TEST_MERCHANT,
      targetPackageKey: "ai_fan",
      idempotencyKey: "idem_new_aifan",
      quote: {
        vndAmount: "7188000", providerCurrency: "usdttrc20", providerNetwork: "trc20",
        providerAmount: "285.11", providerPaymentId: "np_payment_aifan_1",
        quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });
    await updateBillingOrderStatus(order.data.billingOrderId, { status: "paid", providerPaymentId: "np_payment_aifan_1" });
    await applyBillingOrderToPurchase(order.data.billingOrderId);

    const afterOrders = await relationCount("public.order");
    const afterMoves = await relationCount("app.stock_movements");
    const afterLoyalty = await relationCount("app.loyalty_transactions");
    const afterJournal = await relationCount("app.journal_entries");

    expect(afterOrders).toBe(beforeOrders);
    expect(afterMoves).toBe(beforeMoves);
    expect(afterLoyalty).toBe(beforeLoyalty);
    expect(afterJournal).toBe(beforeJournal);
  }, TIMEOUTS.timeout);
});

describe("platform billing upgrade proration + apply", () => {
  it("prorates Plus→AI Fan upgrade using remaining-term and preserves renewal date", async () => {
    await resetMerchant();
    await applySubscriptionPurchase({ merchantId: TEST_MERCHANT, packageKey: "plus", effectiveAt: new Date("2028-01-01T00:00:00Z") });

    const upgrade = await initiateUpgrade({
      merchantId: TEST_MERCHANT,
      idempotencyKey: "idem_upgrade_1",
      quote: {
        vndAmount: "0", providerCurrency: "usdttrc20", providerNetwork: "trc20",
        providerAmount: "0", providerPaymentId: "np_payment_upgrade_1",
        quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });
    // The order snapshot should be a positive integer VND multiple of 1000
    const amount = BigInt(upgrade.data.amount.amountVnd);
    expect(amount % 1000n).toBe(0n);
    expect(amount).toBeGreaterThanOrEqual(0n);

    // Renewal date is preserved (periodEnd is unchanged)
    const before = await getMerchantSubscriptionStatus(TEST_MERCHANT);
    expect(upgrade.data.periodEnd).toBe(before.currentPeriodEnd);

    await updateBillingOrderStatus(upgrade.data.billingOrderId, { status: "paid", providerPaymentId: "np_payment_upgrade_1" });
    const applied = await applyBillingOrderToPurchase(upgrade.data.billingOrderId);
    expect(applied.data.subscriptionStatus.packageKey).toBe("ai_fan");
    expect(applied.data.subscriptionStatus.currentPeriodEnd).toBe(before.currentPeriodEnd);
  }, TIMEOUTS.timeout);
});

describe("platform billing store add-on + 10-store cap", () => {
  it("rejects store add-on when 10 active stores already exist", async () => {
    await resetMerchant();
    await applySubscriptionPurchase({ merchantId: TEST_MERCHANT, packageKey: "ai_fan", effectiveAt: new Date("2026-06-20T00:00:00Z") });

    // Bring active store count to 10
    for (let i = 0; i < 9; i++) {
      const sid = `store_billing_extra_${i}`;
      const sloc = `sloc_billing_extra_${i}`;
      await client.query(`INSERT INTO public.stock_location (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [sloc, `Extra ${i}`]);
      await client.query(`
        INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status)
        VALUES ($1, $2, $3, $4, false, 'active')
        ON CONFLICT (id) DO NOTHING
      `, [sid, TEST_MERCHANT, `Extra ${i}`, sloc]);
    }

    await expect(
      initiateStoreAddon({ merchantId: TEST_MERCHANT, idempotencyKey: "idem_addon_capped" }),
    ).rejects.toMatchObject({ code: "store_cap_reached" });

    // Cleanup extras
    for (let i = 0; i < 9; i++) {
      await client.query(`DELETE FROM app.stores WHERE id = $1`, [`store_billing_extra_${i}`]);
      await client.query(`DELETE FROM public.stock_location WHERE id = $1`, [`sloc_billing_extra_${i}`]);
    }
  }, TIMEOUTS.timeout);
});

describe("platform billing webhook idempotency + manual review", () => {
  it("applies a verified terminal payment exactly once across duplicate IPNs", async () => {
    await resetMerchant();
    await applySubscriptionPurchase({ merchantId: TEST_MERCHANT, packageKey: "basic", effectiveAt: new Date("2026-06-20T00:00:00Z") });

    const order = await initiateNewSubscription({
      merchantId: TEST_MERCHANT,
      targetPackageKey: "plus",
      idempotencyKey: "idem_dedupe",
      quote: {
        vndAmount: "3588000", providerCurrency: "usdttrc20", providerNetwork: "trc20",
        providerAmount: "142.55", providerPaymentId: "np_payment_dedupe",
        quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });

    const evt = (n: number) => ({
      providerEventId: `evt_billing_test_dedupe_${n}`,
      eventType: "nowpayments.finished",
      paymentStatus: "finished",
      providerPaymentId: "np_payment_dedupe",
      payCurrency: "usdttrc20",
      payAmount: 142.55,
      priceAmount: 3588000,
      priceCurrency: "vnd",
      orderDescription: order.data.billingOrderId,
      payload: { payment_id: "np_payment_dedupe", payment_status: "finished" },
    });

    const r1 = await handlePlatformNowPaymentsWebhook(evt(1));
    expect(["applied", "paid"]).toContain(r1.status);

    const r2 = await handlePlatformNowPaymentsWebhook(evt(2));
    expect(r2.status).toBe("already_applied");

    const reloaded = await getBillingOrder(order.data.billingOrderId);
    expect(reloaded?.status).toBe("applied");

    const events = await client.query<{ status: string }>(
      "SELECT status FROM app.billing_provider_events WHERE provider_event_id LIKE 'evt_billing_test_dedupe_%'",
    );
    expect(events.rows.length).toBe(2);
  }, TIMEOUTS.timeout);

  it("routes underpayment to manual_review and leaves the package unchanged", async () => {
    await resetMerchant();
    await applySubscriptionPurchase({ merchantId: TEST_MERCHANT, packageKey: "basic", effectiveAt: new Date("2026-06-20T00:00:00Z") });

    const order = await initiateNewSubscription({
      merchantId: TEST_MERCHANT,
      targetPackageKey: "plus",
      idempotencyKey: "idem_under",
      quote: {
        vndAmount: "3588000", providerCurrency: "usdttrc20", providerNetwork: "trc20",
        providerAmount: "142.55", providerPaymentId: "np_payment_under",
        quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });

    const r = await handlePlatformNowPaymentsWebhook({
      providerEventId: "evt_billing_test_under_1",
      eventType: "nowpayments.finished",
      paymentStatus: "finished",
      providerPaymentId: "np_payment_under",
      payCurrency: "usdttrc20",
      payAmount: 100, // underpayment vs expected 142.55
      priceAmount: 3588000,
      priceCurrency: "vnd",
      orderDescription: order.data.billingOrderId,
      payload: {},
    });

    expect(r.status).toBe("manual_review");
    expect(r.reason).toMatch(/underpayment/);

    const reloaded = await getBillingOrder(order.data.billingOrderId);
    expect(reloaded?.status).toBe("manual_review");

    // Package is unchanged on provider failure
    const sub = await getMerchantSubscriptionStatus(TEST_MERCHANT);
    expect(sub.packageKey).toBe("basic");
  }, TIMEOUTS.timeout);

  it("routes wrong-asset payments to manual_review", async () => {
    await resetMerchant();
    await applySubscriptionPurchase({ merchantId: TEST_MERCHANT, packageKey: "basic", effectiveAt: new Date("2026-06-20T00:00:00Z") });

    const order = await initiateNewSubscription({
      merchantId: TEST_MERCHANT,
      targetPackageKey: "plus",
      idempotencyKey: "idem_wrongasset",
      quote: {
        vndAmount: "3588000", providerCurrency: "usdttrc20", providerNetwork: "trc20",
        providerAmount: "142.55", providerPaymentId: "np_payment_wrongasset",
        quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });

    const r = await handlePlatformNowPaymentsWebhook({
      providerEventId: "evt_billing_test_wrongasset_1",
      eventType: "nowpayments.finished",
      paymentStatus: "finished",
      providerPaymentId: "np_payment_wrongasset",
      payCurrency: "btc", // wrong asset
      payAmount: 142.55,
      priceAmount: 3588000,
      priceCurrency: "vnd",
      orderDescription: order.data.billingOrderId,
      payload: {},
    });

    expect(r.status).toBe("manual_review");
    expect(r.reason).toMatch(/wrong_currency/);
  }, TIMEOUTS.timeout);


  it("routes wrong-network payments to manual_review", async () => {
    await resetMerchant();
    await applySubscriptionPurchase({ merchantId: TEST_MERCHANT, packageKey: "basic", effectiveAt: new Date("2026-06-20T00:00:00Z") });

    const order = await initiateNewSubscription({
      merchantId: TEST_MERCHANT,
      targetPackageKey: "plus",
      idempotencyKey: "idem_wrongnetwork",
      quote: {
        vndAmount: "3588000", providerCurrency: "usdttrc20", providerNetwork: "trc20",
        providerAmount: "142.55", providerPaymentId: "np_payment_wrongnetwork",
        quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });

    const r = await handlePlatformNowPaymentsWebhook({
      providerEventId: "evt_billing_test_wrongnetwork_1",
      eventType: "nowpayments.finished",
      paymentStatus: "finished",
      providerPaymentId: "np_payment_wrongnetwork",
      payCurrency: "usdttrc20",
      providerNetwork: "erc20",
      payAmount: 142.55,
      priceAmount: 3588000,
      priceCurrency: "vnd",
      orderId: order.data.billingOrderId,
      orderDescription: order.data.billingOrderId,
      payload: {},
    });

    expect(r.status).toBe("manual_review");
    expect(r.reason).toMatch(/wrong_network/);
  }, TIMEOUTS.timeout);

  it("concurrent apply attempts cannot double-apply the subscription", async () => {
    await resetMerchant();
    await applySubscriptionPurchase({ merchantId: TEST_MERCHANT, packageKey: "basic", effectiveAt: new Date("2026-06-20T00:00:00Z") });

    const order = await initiateNewSubscription({
      merchantId: TEST_MERCHANT,
      targetPackageKey: "plus",
      idempotencyKey: "idem_concurrent",
      quote: {
        vndAmount: "3588000", providerCurrency: "usdttrc20", providerNetwork: "trc20",
        providerAmount: "142.55", providerPaymentId: "np_payment_concurrent",
        quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });
    await updateBillingOrderStatus(order.data.billingOrderId, { status: "paid", providerPaymentId: "np_payment_concurrent" });

    // Two concurrent apply calls; both should succeed but only one actually mutates
    const [a, b] = await Promise.allSettled([
      applyBillingOrderToPurchase(order.data.billingOrderId),
      applyBillingOrderToPurchase(order.data.billingOrderId),
    ]);
    const ok = [a, b].filter((r) => r.status === "fulfilled").length;
    expect(ok).toBeGreaterThanOrEqual(1);

    const reloaded = await getBillingOrder(order.data.billingOrderId);
    expect(reloaded?.status).toBe("applied");

    // Exactly one subscription event for plus activation
    const events = await client.query<{ c: string }>(
      "SELECT count(*)::text AS c FROM app.subscription_events WHERE merchant_id = $1 AND event_type IN ('subscription.activated','subscription.reactivated') AND payload->>'packageKey' = 'plus'",
      [TEST_MERCHANT],
    );
    expect(Number(events.rows[0]?.c || 0)).toBe(1);
  }, TIMEOUTS.timeout);
});
