import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import type { OperatorContext } from "../services/auth-service";
import { processOutboxEvent } from "../services/outbox-processor-service";
import { createPaymentIntent, getPaymentIntent, handleProviderPaymentEvent, listPaymentIntents, settleMockPaymentIntent, type ProviderPaymentEventInput } from "../services/payment-intent-service";
import { createProduct } from "../services/product-management-service";
import { updateMerchantCheckoutPolicy } from "../services/merchant-checkout-policy-service";
import { adjustStock } from "../services/inventory-service";

const originalPackage = process.env.APP_PACKAGE_KEY;
const originalSepayPaymentsEnabled = process.env.SEPAY_PAYMENTS_ENABLED;
const originalCryptoPaymentsEnabled = process.env.CRYPTO_PAYMENTS_ENABLED;
const originalCryptoProvider = process.env.CRYPTO_PROVIDER;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const variantId = "var_mint_20";
const actor: OperatorContext = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "DB Test Owner",
  organizationId: "org_default",
};
const scope = { scopeKind: "operating" as const, merchantId: "merchant_default", storeId: "store_default", stockLocationId: "sloc_default" };
const twoStoreScopeA = { scopeKind: "operating" as const, merchantId: "merchant_two_store", storeId: "store_a", stockLocationId: "sloc_store_a" };
const twoStoreScopeB = { scopeKind: "operating" as const, merchantId: "merchant_two_store", storeId: "store_b", stockLocationId: "sloc_store_b" };

let client: PoolClient;
let baselineStock = 0;
let twoStoreProductId = "";
let twoStoreVariantId = "";
let twoStoreInventoryItemId = "";

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

async function setStockForVariant(quantity: number): Promise<void> {
  await client.query(`
    UPDATE public.inventory_level il
    SET stocked_quantity = $2, updated_at = now()
    FROM public.product_variant_inventory_item vii
    WHERE vii.inventory_item_id = il.inventory_item_id
      AND vii.variant_id = $1
      AND il.location_id = 'sloc_default'
      AND il.deleted_at IS NULL
      AND vii.deleted_at IS NULL
  `, [variantId, quantity]);
}

async function createPreparedCryptoIntent(label: string, options: {
  merchantId?: string;
  storeId?: string;
  stockLocationId?: string;
  asset?: "USDTTRC20" | "USDCMATIC";
} = {}) {
  const asset = options.asset || "USDTTRC20";
  const payCurrency = asset === "USDTTRC20" ? "usdttrc20" : "usdcmatic";
  const intentScope = {
    scopeKind: "operating" as const,
    merchantId: options.merchantId || "merchant_default",
    storeId: options.storeId || "store_default",
    stockLocationId: options.stockLocationId || "sloc_default",
  };
  const created = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:${label}` }, {
    provider: "nowpayments",
    merchantId: options.merchantId || "merchant_default",
    storeId: options.storeId || "store_default",
    order: {
      items: [{ variantId, quantity: 1 }],
      customerId: "cus_demo",
      paymentMethod: "nowpayments",
      amountReceived: 0,
      notes: `NOWPayments ${label} ${runId}`,
      salesChannel: "pos_counter",
    },
  }, actor, intentScope);
  const intent = created.response.data;
  await client.query(`
    UPDATE app.payment_intents
    SET metadata = jsonb_set(metadata, '{provider}', (metadata->'provider') || $2::jsonb, true),
        provider_config_id = 'cfg_db_merchant_retail'
    WHERE id = $1
  `, [intent.id, JSON.stringify({
    expectedProviderAmount: "10",
    expectedProviderCurrency: payCurrency,
    payCurrency,
    providerConfigPurpose: "merchant_retail",
    providerConfigId: "cfg_db_merchant_retail",
    destinationWalletRef: `wallet_db_${payCurrency}`,
    quote: {
      vndUsdRate: 25000,
      exchangeRateSource: "NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE",
      quotedAt: "2026-06-21T02:00:00.000Z",
    },
  })]);
  return intent;
}

function cryptoEvent(
  intent: { referenceCode: string },
  providerEventId: string,
  overrides: Partial<ProviderPaymentEventInput> = {},
): ProviderPaymentEventInput {
  const asset = overrides.retailCryptoAsset || "USDTTRC20";
  const payCurrency = asset === "USDTTRC20" ? "usdttrc20" : "usdcmatic";
  const network = asset === "USDTTRC20" ? "trc20" : "matic";
  return {
    provider: "nowpayments",
    providerEventId,
    eventType: "nowpayments.finished",
    amount: 10,
    currencyCode: payCurrency,
    referenceCode: intent.referenceCode,
    providerTransactionId: providerEventId,
    providerTransactionHash: `hash-${providerEventId}`,
    providerNetwork: network,
    providerPayCurrency: payCurrency,
    retailCryptoAsset: asset,
    grossQuantity: "10",
    providerFeeQuantity: "0.01",
    providerFeeAmount: 0.01,
    providerFeeCurrency: payCurrency,
    payload: { source: "db-test", payment_status: "finished" },
    verification: { mode: "test", terminal: true, paymentStatus: "finished", providerFeeResolved: true },
    ...overrides,
  };
}

async function processSaleCreatedForOrder(orderId: string): Promise<void> {
  const saleEvent = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
    SELECT id::text, event_type, payload
    FROM outbox.events
    WHERE aggregate_type = 'order' AND aggregate_id = $1 AND event_type = 'sale.created'
    ORDER BY created_at ASC
    LIMIT 1
  `, [orderId]);
  expect(saleEvent).toBeTruthy();
  await processOutboxEvent({ id: saleEvent!.id, eventType: saleEvent!.event_type, payload: saleEvent!.payload });
}

async function debitAccountCodesForOrder(orderId: string): Promise<string[]> {
  const rows = await client.query<{ code: string }>(`
    SELECT a.code
    FROM accounting.journal_entries je
    JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
    JOIN accounting.accounts a ON a.id = jl.account_id
    WHERE je.reference_type = 'order'
      AND je.reference_id = $1
      AND jl.debit_amount > 0
    ORDER BY a.code
  `, [orderId]);
  return rows.rows.map((row) => row.code);
}

beforeAll(async () => {
  process.env.APP_PACKAGE_KEY = "ai_fan";
  process.env.SEPAY_PAYMENTS_ENABLED = "true";
  process.env.CRYPTO_PAYMENTS_ENABLED = "true";
  process.env.CRYPTO_PROVIDER = "nowpayments";
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  baselineStock = await stockForVariant();
  if (baselineStock < 3) {
    await setStockForVariant(10);
    baselineStock = await stockForVariant();
  }
  // The two-store fixture targets merchant_two_store / store_a / store_b.
  // 013_tenant_constraints_not_valid enforces stock_movements_store_merchant_fk
  // and stores_stock_location_fk, so seed merchant + stock locations + stores
  // (each with a distinct valid location, consistent with the test's isolation)
  // before any product/stock setup runs. Cleanup mirrors this in FK-safe order.
  await client.query("INSERT INTO app.merchants (id, display_name, legacy_organization_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", ["merchant_two_store", "Two Store Merchant", "org_two_store"]);
  // Two distinct stock locations (stores_stock_location_unique_idx requires 1:1).
  await client.query("INSERT INTO public.stock_location (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", ["sloc_store_a", "Two Store Location A"]);
  await client.query("INSERT INTO public.stock_location (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", ["sloc_store_b", "Two Store Location B"]);
  await client.query("INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status) VALUES ($1, $2, $3, $4, true, 'active') ON CONFLICT (id) DO NOTHING", ["store_a", "merchant_two_store", "Two Store A", "sloc_store_a"]);
  await client.query("INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status) VALUES ($1, $2, $3, $4, false, 'active') ON CONFLICT (id) DO NOTHING", ["store_b", "merchant_two_store", "Two Store B", "sloc_store_b"]);

  const twoStoreProduct = await createProduct(
    { "idempotency-key": `db-test:${runId}:two-store-product` },
    {
      title: `Two Store Product ${runId}`,
      status: "published",
      sku: `TWO-STORE-${runId}`,
      barcode: `TWO-STORE-BAR-${runId}`,
      price: 250000,
      costPrice: 175000,
      reorderLevel: 5,
      categoryIds: [],
    },
    actor,
    { scopeKind: "merchant_target", merchantId: twoStoreScopeA.merchantId },
    twoStoreScopeA,
  );
  twoStoreProductId = twoStoreProduct.response.product.id;
  twoStoreVariantId = twoStoreProduct.response.product.variants[0].id;
  const ownedInventory = await queryOne<{ inventory_item_id: string }>(client, `
    SELECT inventory_item_id
    FROM public.product_variant_inventory_item
    WHERE variant_id = $1 AND deleted_at IS NULL
  `, [twoStoreVariantId]);
  twoStoreInventoryItemId = ownedInventory?.inventory_item_id || "";
  await adjustStock(
    { "idempotency-key": `db-test:${runId}:two-store-stock` },
    { inventoryItemId: twoStoreInventoryItemId, adjustment: 10, reason: "payment intent fixture" },
    actor,
    twoStoreScopeA,
  );
  // store_b draws from its own stock_location (sloc_store_b). Seed a matching
  // inventory_level there for the same shared inventory_item so store_b's
  // payment intent can reserve stock and complete.
  await client.query(`
    INSERT INTO public.inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, incoming_quantity)
    SELECT ('ilev_store_b_' || $1), $1, 'sloc_store_b', 10, 0, 0
    WHERE NOT EXISTS (
      SELECT 1 FROM public.inventory_level
      WHERE inventory_item_id = $1 AND location_id = 'sloc_store_b' AND deleted_at IS NULL
    )
  `, [twoStoreInventoryItemId]);
  await client.query(`
    UPDATE public.inventory_level
    SET stocked_quantity = GREATEST(stocked_quantity, 10), updated_at = now()
    WHERE inventory_item_id = $1 AND location_id = 'sloc_store_b' AND deleted_at IS NULL
  `, [twoStoreInventoryItemId]);
});

afterAll(async () => {
  await client?.query(`
    UPDATE public.inventory_level il
    SET stocked_quantity = GREATEST(stocked_quantity, $2), updated_at = now()
    FROM public.product_variant_inventory_item vii
    WHERE vii.inventory_item_id = il.inventory_item_id
      AND vii.variant_id = $1
      AND il.deleted_at IS NULL
      AND vii.deleted_at IS NULL
  `, [variantId, baselineStock]).catch(() => undefined);
  if (twoStoreInventoryItemId) {
    await client?.query("DELETE FROM medusa.stock_movements WHERE inventory_item_id = $1", [twoStoreInventoryItemId]).catch(() => undefined);
    await client?.query("DELETE FROM public.inventory_level WHERE inventory_item_id = $1 AND location_id IN ('sloc_store_a', 'sloc_store_b', 'sloc_default')", [twoStoreInventoryItemId]).catch(() => undefined);
    await client?.query("DELETE FROM public.product_variant_inventory_item WHERE inventory_item_id = $1", [twoStoreInventoryItemId]).catch(() => undefined);
    await client?.query("DELETE FROM public.inventory_item WHERE id = $1", [twoStoreInventoryItemId]).catch(() => undefined);
  }
  if (twoStoreVariantId) {
    const priceSet = await queryOne<{ price_set_id: string }>(client, "SELECT price_set_id FROM public.product_variant_price_set WHERE variant_id = $1 LIMIT 1", [twoStoreVariantId]);
    await client?.query("DELETE FROM inventory.product_settings WHERE variant_id = $1", [twoStoreVariantId]).catch(() => undefined);
    await client?.query("DELETE FROM public.product_variant_price_set WHERE variant_id = $1", [twoStoreVariantId]).catch(() => undefined);
    if (priceSet?.price_set_id) {
      await client?.query("DELETE FROM public.price WHERE price_set_id = $1", [priceSet.price_set_id]).catch(() => undefined);
      await client?.query("DELETE FROM public.price_set WHERE id = $1", [priceSet.price_set_id]).catch(() => undefined);
    }
    await client?.query("DELETE FROM public.product_variant WHERE id = $1", [twoStoreVariantId]).catch(() => undefined);
  }
 if (twoStoreProductId) await client?.query("DELETE FROM public.product WHERE id = $1", [twoStoreProductId]).catch(() => undefined);
  // FK-safe teardown of two-store transactional rows created by the SePay
  // shared-account routing test. These reference merchant_two_store and must
  // be removed before the merchant/store rows are deleted, otherwise the
  // tenant-scope invariant would report scope_unknown_or_orphan leftovers.
  const twoStoreOrderIds = (await client?.query<{ id: string }>("SELECT id::text AS id FROM public.\"order\" WHERE merchant_id = 'merchant_two_store'").catch(() => undefined))?.rows.map((r) => r.id) ?? [];
  if (twoStoreOrderIds.length) {
    await client?.query("DELETE FROM accounting.journal_lines WHERE journal_entry_id IN (SELECT id FROM accounting.journal_entries WHERE reference_type = 'order' AND reference_id = ANY($1::text[]))", [twoStoreOrderIds]).catch(() => undefined);
    await client?.query("DELETE FROM accounting.journal_entries WHERE reference_type = 'order' AND reference_id = ANY($1::text[])", [twoStoreOrderIds]).catch(() => undefined);
    await client?.query("DELETE FROM outbox.events WHERE aggregate_type = 'order' AND aggregate_id = ANY($1::text[])", [twoStoreOrderIds]).catch(() => undefined);
  }
  await client?.query("DELETE FROM app.payment_provider_events WHERE merchant_id = 'merchant_two_store'").catch(() => undefined);
  await client?.query("DELETE FROM app.payment_entries WHERE merchant_id = 'merchant_two_store'").catch(() => undefined);
  await client?.query("DELETE FROM app.payment_intents WHERE merchant_id = 'merchant_two_store'").catch(() => undefined);
  await client?.query("DELETE FROM public.\"order\" WHERE merchant_id = 'merchant_two_store'").catch(() => undefined);
  // Unmatched SePay provider events are created with no merchant/store binding
  // by the "manual review" test case. Clean them up by runId so they do not
  // linger as invariant orphans.
  await client?.query("DELETE FROM app.payment_provider_events WHERE provider_event_id LIKE 'db-test:' || $1 || ':unmatched-provider-event'", [runId]).catch(() => undefined);
  await client?.query("DELETE FROM app.scan_go_carts WHERE id LIKE $1", [`sgc_pi_${runId}%`]).catch(() => undefined);
  // FK-safe teardown of the two-store tenant rows (dependents already removed above).
  await client?.query("DELETE FROM app.stores WHERE id IN ('store_a', 'store_b')").catch(() => undefined);
  await client?.query("DELETE FROM public.stock_location WHERE id IN ('sloc_store_a', 'sloc_store_b')").catch(() => undefined);
  await client?.query("DELETE FROM app.merchants WHERE id = 'merchant_two_store'").catch(() => undefined);
  client?.release();
  if (originalPackage === undefined) delete process.env.APP_PACKAGE_KEY;
  else process.env.APP_PACKAGE_KEY = originalPackage;
  if (originalSepayPaymentsEnabled === undefined) delete process.env.SEPAY_PAYMENTS_ENABLED;
  else process.env.SEPAY_PAYMENTS_ENABLED = originalSepayPaymentsEnabled;
  if (originalCryptoPaymentsEnabled === undefined) delete process.env.CRYPTO_PAYMENTS_ENABLED;
  else process.env.CRYPTO_PAYMENTS_ENABLED = originalCryptoPaymentsEnabled;
  if (originalCryptoProvider === undefined) delete process.env.CRYPTO_PROVIDER;
  else process.env.CRYPTO_PROVIDER = originalCryptoProvider;
  await shutdownPlatformDb().catch(() => undefined);
});

describe("payment intent PostgreSQL integration", () => {
  it("retains paid evidence for manual review when a Scan & Go cart is claimed by another intent", async () => {
    const cartId = `sgc_pi_${runId}_foreign_claim`;
    const token = `sgt_${createHash("sha256").update(`${runId}:foreign-claim`).digest("hex").slice(0, 24)}`;
    await client.query(`INSERT INTO app.scan_go_carts(id,merchant_id,store_id,status,merchant_slug,store_slug,
      age_acknowledged_at,token_hash,token_generated_at,token_expires_at)
      VALUES($1,$2,$3,'ready','default','main',now(),$4,now(),now()+interval '30 minutes')`,
      [cartId, scope.merchantId, scope.storeId, createHash("sha256").update(token).digest("hex")]);
    const created = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:foreign-claim-create` }, {
      provider: "mock", order: { items: [{ variantId, quantity: 1 }], customerId: "cus_demo", amountReceived: 0,
        paymentMethod: "mock", sourceFlow: "customer_scan_go", salesChannel: "stash_dash", salesChannelLocked: true,
        scanGoCartId: cartId, scanGoCheckoutToken: token },
    }, actor, scope);
    await client.query("UPDATE app.scan_go_carts SET metadata=jsonb_set(metadata,'{paymentIntentId}','\"another-intent\"'::jsonb) WHERE id=$1", [cartId]);
    const stockBefore = await stockForVariant();
    const settled = await settleMockPaymentIntent({ "idempotency-key": `db-test:${runId}:foreign-claim-settle` },
      created.response.data.id, actor, scope);
    expect(settled.response.data).toMatchObject({ status: "manual_review", manualReviewReason: "scan_go_cart_unavailable", completedOrderId: null });
    expect(await stockForVariant()).toBe(stockBefore);
    const cart = await client.query("SELECT status,metadata->>'paymentIntentId' AS intent,redeemed_order_id FROM app.scan_go_carts WHERE id=$1", [cartId]);
    expect(cart.rows).toEqual([{ status: "ready", intent: "another-intent", redeemed_order_id: null }]);
  });
  it("creates a payment intent with fixed discount whose amount equals the normalized order total", async () => {
    const create = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:discount` }, {
      provider: "mock",
      order: {
        items: [{ variantId, quantity: 1 }],
        customerId: "cus_demo",
        paymentMethod: "mock",
        amountReceived: 0,
        discountType: "amount",
        discountValue: 20000,
        shippingFee: 10000,
        notes: `Payment intent with discount ${runId}`,
        salesChannel: "pos_counter",
      },
    }, actor, scope);

    expect(create.statusCode).toBe(201);
    const intent = create.response.data;
    const settle = await settleMockPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:discount-settle` }, intent.id, actor, scope);
    expect(settle.statusCode).toBe(201);
    expect(settle.response.data.status).toBe("completed");
    expect(settle.response.data.completedOrderId).toBeTruthy();

    const completedOrder = await queryOne<{ metadata: Record<string, unknown> }>(client, `
      SELECT metadata FROM public."order" WHERE id = $1
    `, [settle.response.data.completedOrderId]);
    const expectedSubtotal = Number(completedOrder?.metadata.subtotal || 0);
    const expectedTotal = expectedSubtotal - 20000 + 10000;
    expect(intent.amount).toBe(expectedTotal);
    expect(Number(completedOrder?.metadata.total)).toBe(expectedTotal);
    expect(completedOrder?.metadata).toMatchObject({
      discountType: "amount",
      discountValue: 20000,
      discount: 20000,
    });

    const paymentRows = await client.query(
      "SELECT amount::numeric AS amount FROM app.payment_entries WHERE order_id = $1",
      [settle.response.data.completedOrderId],
    );
    expect(Number(paymentRows.rows[0].amount)).toBe(expectedTotal);
  });

  it("creates a pending mock payment intent and completes exactly one order on settlement", async () => {
    const stockBefore = await stockForVariant();
    const create = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:create` }, {
      provider: "mock",
      order: {
        items: [{ variantId, quantity: 1 }],
        customerId: "cus_demo",
        paymentMethod: "mock",
        amountReceived: 0,
        notes: `Payment intent ${runId}`,
        salesChannel: "pos_counter",
      },
    }, actor, scope);

    expect(create.statusCode).toBe(201);
    const intent = create.response.data;
    expect(intent).toMatchObject({
      provider: "mock",
      status: "pending",
      amount: 250000,
      currencyCode: "vnd",
    });
    expect(intent.referenceCode).toMatch(/^PI/);

    const settle = await settleMockPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:settle` }, intent.id, actor, scope);
    const replay = await settleMockPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:settle` }, intent.id, actor, scope);

    expect(settle.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(settle.response.data.status).toBe("completed");
    expect(settle.response.data.completedOrderId).toBeTruthy();
    expect(replay.response).toEqual(settle.response);
    expect(await stockForVariant()).toBe(stockBefore - 1);

    const paymentRows = await client.query(
      "SELECT status, method, metadata FROM app.payment_entries WHERE order_id = $1",
      [settle.response.data.completedOrderId],
    );
    expect(paymentRows.rows).toHaveLength(1);
    expect(paymentRows.rows[0]).toMatchObject({
      status: "posted",
      method: "mock",
    });
    expect(paymentRows.rows[0].metadata).toMatchObject({
      paymentIntentId: intent.id,
      paymentProvider: "mock",
    });
  });

  it("defers Stash Dash cart redemption until payment intent settlement", async () => {
    const cartId = `sgc_pi_${runId}_deferred`;
    const token = `sgt_${createHash("sha256").update(`${runId}:deferred`).digest("hex").slice(0, 24)}`;
    await client.query(`
      INSERT INTO app.scan_go_carts (
        id, merchant_id, store_id, status, merchant_slug, store_slug,
        customer_nickname, contact_type, age_acknowledged_at,
        token_hash, token_generated_at, token_expires_at
      )
      VALUES ($1, $2, $3, 'ready', 'default', 'main', 'Tommy', 'whatsapp', now(), $4, now(), now() + interval '30 minutes')
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        token_hash = EXCLUDED.token_hash,
        token_expires_at = EXCLUDED.token_expires_at,
        redeemed_at = NULL,
        redeemed_by_operator_id = NULL,
        redeemed_order_id = NULL,
        metadata = '{}'::jsonb,
        updated_at = now()
    `, [cartId, scope.merchantId, scope.storeId, createHash("sha256").update(token).digest("hex")]);

    const stockBefore = await stockForVariant();
    const create = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:stash-dash` }, {
      provider: "mock",
      order: {
        items: [{ variantId, quantity: 1 }],
        customerId: "cus_demo",
        paymentMethod: "mock",
        amountReceived: 0,
        notes: `Stash Dash payment intent ${runId}`,
        salesChannel: "stash_dash",
        sourceFlow: "customer_scan_go",
        scanGoCartId: cartId,
        scanGoCheckoutToken: token,
        salesChannelLocked: true,
        customerNickname: "Tommy",
        customerContactType: "whatsapp",
      },
    }, actor, scope);

    expect(create.statusCode).toBe(201);
    const intent = create.response.data;
    const storedIntent = await queryOne<{ order_input: Record<string, unknown> }>(client, `
      SELECT order_input
      FROM app.payment_intents
      WHERE id = $1
    `, [intent.id]);
    expect(storedIntent?.order_input).toMatchObject({
      salesChannel: "stash_dash",
      sourceFlow: "customer_scan_go",
      scanGoCartId: cartId,
    });
    expect(storedIntent?.order_input).not.toHaveProperty("scanGoCheckoutToken");

    const cartAfterCreate = await queryOne<{ status: string; redeemed_at: Date | null; metadata: Record<string, unknown> }>(client, `
      SELECT status, redeemed_at, metadata
      FROM app.scan_go_carts
      WHERE id = $1
    `, [cartId]);
    expect(cartAfterCreate).toMatchObject({ status: "ready", redeemed_at: null });
    expect(cartAfterCreate?.metadata).toMatchObject({ paymentIntentId: intent.id });

    await expect(createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:stash-dash-duplicate` }, {
      provider: "mock",
      order: {
        items: [{ variantId, quantity: 1 }],
        customerId: "cus_demo",
        paymentMethod: "mock",
        amountReceived: 0,
        notes: `Duplicate Stash Dash payment intent ${runId}`,
        salesChannel: "stash_dash",
        sourceFlow: "customer_scan_go",
        scanGoCartId: cartId,
        scanGoCheckoutToken: token,
        salesChannelLocked: true,
        customerNickname: "Tommy",
        customerContactType: "whatsapp",
      },
    }, actor, scope)).rejects.toMatchObject({
      code: "scan_go_payment_intent_active",
    });

    const settle = await settleMockPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:stash-dash-settle` }, intent.id, actor, scope);
    expect(settle.statusCode).toBe(201);
    expect(settle.response.data.completedOrderId).toBeTruthy();
    await expect(stockForVariant()).resolves.toBe(stockBefore - 1);

    const linkedCart = await queryOne<{ status: string; redeemed_order_id: string; metadata: Record<string, unknown> }>(client, `
      SELECT status, redeemed_order_id, metadata
      FROM app.scan_go_carts
      WHERE id = $1
    `, [cartId]);
    expect(linkedCart).toMatchObject({
      status: "redeemed",
      redeemed_order_id: settle.response.data.completedOrderId,
      metadata: expect.objectContaining({
        paymentIntentId: intent.id,
        redeemedOrderId: settle.response.data.completedOrderId,
      }),
    });

    const completedOrder = await queryOne<{ metadata: Record<string, unknown> }>(client, `
      SELECT metadata
      FROM public."order"
      WHERE id = $1
    `, [settle.response.data.completedOrderId]);
    expect(completedOrder?.metadata).toMatchObject({
      salesChannel: "stash_dash",
      sourceFlow: "customer_scan_go",
      scanGoCartId: cartId,
      salesChannelLocked: true,
    });
  });

  it("acknowledges unmatched provider events as manual review without creating an order", async () => {
    const providerEventId = `db-test:${runId}:unmatched-provider-event`;
    const result = await handleProviderPaymentEvent({
      provider: "sepay_va",
      providerEventId,
      eventType: "sepay.transaction",
      amount: 250000,
      currencyCode: "vnd",
      referenceCode: `PIUNMATCHED${runId.replace(/[^a-zA-Z0-9]/g, "").slice(-8)}`,
      payload: { source: "db-test" },
      verification: { mode: "test" },
    });
    const replay = await handleProviderPaymentEvent({
      provider: "sepay_va",
      providerEventId,
      eventType: "sepay.transaction",
      amount: 250000,
      currencyCode: "vnd",
      referenceCode: `PIUNMATCHED${runId.replace(/[^a-zA-Z0-9]/g, "").slice(-8)}`,
      payload: { source: "db-test-replay" },
      verification: { mode: "test" },
    });

    expect(result.data).toMatchObject({
      provider: "sepay_va",
      providerEventId,
      status: "manual_review",
      manualReviewReason: "payment_intent_not_found",
    });
    expect(replay.data).toMatchObject(result.data);

    const eventRows = await client.query(`
      SELECT payment_intent_id, status, error
      FROM app.payment_provider_events
      WHERE provider = 'sepay_va' AND provider_event_id = $1
    `, [providerEventId]);
    expect(eventRows.rows).toHaveLength(1);
    expect(eventRows.rows[0]).toMatchObject({
      payment_intent_id: null,
      status: "manual_review",
      error: "payment_intent_not_found",
    });
  });

  it("marks pending payment intents expired when they are read after expiry", async () => {
    const create = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:expiry` }, {
      provider: "mock",
      order: {
        items: [{ variantId, quantity: 1 }],
        customerId: "cus_demo",
        paymentMethod: "mock",
        amountReceived: 0,
        notes: `Expired payment intent ${runId}`,
        salesChannel: "pos_counter",
      },
    }, actor, scope);

    await client.query(
      "UPDATE app.payment_intents SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [create.response.data.id],
    );

    const expired = await getPaymentIntent(create.response.data.id);
    expect(expired.data).toMatchObject({
      id: create.response.data.id,
      status: "expired",
      manualReviewReason: "payment_intent_expired",
    });
  });

  it("routes shared SePay account callbacks to the store captured by each intent", async () => {
    await setStockForVariant(10);
    const storeA = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:store-a` }, {
      provider: "sepay_va",
      merchantId: "merchant_two_store",
      storeId: "store_a",
      order: {
        items: [{ variantId: twoStoreVariantId, quantity: 1 }],
        paymentMethod: "sepay_va",
        amountReceived: 0,
        notes: `Two-store intent store A ${runId}`,
        salesChannel: "pos_counter",
      },
    }, actor, twoStoreScopeA);
    const storeB = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:store-b` }, {
      provider: "sepay_va",
      merchantId: "merchant_two_store",
      storeId: "store_b",
      order: {
        items: [{ variantId: twoStoreVariantId, quantity: 1 }],
        paymentMethod: "sepay_va",
        amountReceived: 0,
        notes: `Two-store intent store B ${runId}`,
        salesChannel: "pos_counter",
      },
    }, actor, twoStoreScopeB);

    const storeAEvent = await handleProviderPaymentEvent({
      provider: "sepay_va",
      providerEventId: `db-test:${runId}:store-a-callback`,
      eventType: "sepay.transaction",
      amount: storeA.response.data.amount,
      currencyCode: "vnd",
      referenceCode: storeA.response.data.referenceCode,
      direction: "in",
      payload: { source: "db-test", transferType: "in" },
      verification: { mode: "test" },
    });
    const storeBEvent = await handleProviderPaymentEvent({
      provider: "sepay_va",
      providerEventId: `db-test:${runId}:store-b-callback`,
      eventType: "sepay.transaction",
      amount: storeB.response.data.amount,
      currencyCode: "vnd",
      referenceCode: storeB.response.data.referenceCode,
      direction: "in",
      payload: { source: "db-test", transferType: "in" },
      verification: { mode: "test" },
    });

    expect(storeAEvent.data).toMatchObject({
      id: storeA.response.data.id,
      status: "completed",
      completedOrderId: expect.any(String),
      merchantId: "merchant_two_store",
      storeId: "store_a",
    });
    expect(storeBEvent.data).toMatchObject({
      id: storeB.response.data.id,
      status: "completed",
      completedOrderId: expect.any(String),
      merchantId: "merchant_two_store",
      storeId: "store_b",
    });

    const storeAOrder = await queryOne<{ store_id: string | null; merchant_id: string | null }>(client,
      "SELECT store_id, merchant_id FROM public.\"order\" WHERE id = $1",
      [String(storeAEvent.data.completedOrderId)]);
    const storeBOrder = await queryOne<{ store_id: string | null; merchant_id: string | null }>(client,
      "SELECT store_id, merchant_id FROM public.\"order\" WHERE id = $1",
      [String(storeBEvent.data.completedOrderId)]);
    expect(storeAOrder).toMatchObject({ store_id: "store_a", merchant_id: "merchant_two_store" });
    expect(storeBOrder).toMatchObject({ store_id: "store_b", merchant_id: "merchant_two_store" });
  });

  it("keeps outgoing SePay webhooks in manual review and never marks paid", async () => {
    const create = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:outgoing` }, {
      provider: "sepay_va",
      order: {
        items: [{ variantId, quantity: 1 }],
        customerId: "cus_demo",
        paymentMethod: "sepay_va",
        amountReceived: 0,
        notes: `Outgoing SePay intent ${runId}`,
        salesChannel: "pos_counter",
      },
    }, actor, scope);
    const event = await handleProviderPaymentEvent({
      provider: "sepay_va",
      providerEventId: `db-test:${runId}:outgoing-callback`,
      eventType: "sepay.transaction",
      amount: create.response.data.amount,
      currencyCode: "vnd",
      referenceCode: create.response.data.referenceCode,
      direction: "out",
      payload: { source: "db-test", transferType: "out" },
      verification: { mode: "test" },
    });

    expect(event.data).toMatchObject({
      id: create.response.data.id,
      status: "manual_review",
      manualReviewReason: "wrong_transfer_direction",
      completedOrderId: null,
    });
  });

  it("keeps non-terminal NOWPayments webhooks from creating an order", async () => {
    const create = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:non-terminal` }, {
      provider: "nowpayments",
      order: {
        items: [{ variantId, quantity: 1 }],
        customerId: "cus_demo",
        paymentMethod: "nowpayments",
        amountReceived: 0,
        notes: `Non-terminal NOWPayments intent ${runId}`,
        salesChannel: "pos_counter",
      },
    }, actor, scope);
    const event = await handleProviderPaymentEvent({
      provider: "nowpayments",
      providerEventId: `db-test:${runId}:non-terminal-callback`,
      eventType: "nowpayments.waiting",
      amount: 12.34,
      currencyCode: "usd",
      referenceCode: create.response.data.referenceCode,
      providerPayCurrency: "usdttrc20",
      providerNetwork: "trc20",
      payload: { source: "db-test", payment_status: "waiting" },
      verification: { mode: "test", terminal: false, paymentStatus: "waiting" },
    });

    expect(event.data).toMatchObject({
      provider: "nowpayments",
      providerEventId: `db-test:${runId}:non-terminal-callback`,
      status: "manual_review",
      manualReviewReason: "non_terminal_payment_status",
      referenceCode: create.response.data.referenceCode,
    });
    const orderRows = await client.query(
      "SELECT count(*)::int AS count FROM public.\"order\" WHERE metadata->>'paymentIntentId' = $1",
      [create.response.data.id],
    );
    expect(orderRows.rows[0].count).toBe(0);
  });

  it("keeps a late exact provider payment in manual review after intent expiry", async () => {
    const create = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:late-webhook` }, {
      provider: "sepay_va",
      order: {
        items: [{ variantId, quantity: 1 }],
        customerId: "cus_demo",
        paymentMethod: "sepay_va",
        amountReceived: 0,
        notes: `Late SePay payment intent ${runId}`,
        salesChannel: "pos_counter",
      },
    }, actor, scope);

    await client.query(
      "UPDATE app.payment_intents SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [create.response.data.id],
    );
    const expired = await getPaymentIntent(create.response.data.id);
    expect(expired.data.status).toBe("expired");

    const event = await handleProviderPaymentEvent({
      provider: "sepay_va",
      providerEventId: `db-test:${runId}:late-webhook`,
      eventType: "sepay.transaction",
      amount: create.response.data.amount,
      currencyCode: "vnd",
      referenceCode: create.response.data.referenceCode,
      direction: "in",
      payload: { source: "db-test", transferType: "in" },
      verification: { mode: "test" },
    });

    expect(event.data).toMatchObject({
      id: create.response.data.id,
      status: "manual_review",
      manualReviewReason: "payment_intent_expired",
      completedOrderId: null,
    });

    const eventRows = await client.query(`
      SELECT payment_intent_id, status, error
      FROM app.payment_provider_events
      WHERE provider = 'sepay_va' AND provider_event_id = $1
    `, [`db-test:${runId}:late-webhook`]);
    expect(eventRows.rows).toHaveLength(1);
    expect(eventRows.rows[0]).toMatchObject({
      payment_intent_id: create.response.data.id,
      status: "manual_review",
      error: "payment_intent_expired",
    });

    const reviewQueue = await listPaymentIntents({ status: "manual_review", limit: 10, merchantId: scope.merchantId, storeIds: [scope.storeId] });
    expect(reviewQueue.data.some((intent) => (
      intent.id === create.response.data.id
      && intent.manualReviewReason === "payment_intent_expired"
      && intent.completedOrderId === null
    ))).toBe(true);
  });

  it("keeps exact provider payment in manual review when stock disappears before order completion", async () => {
    const merchantMetadata = (await client.query("SELECT metadata FROM app.merchants WHERE id=$1", [scope.merchantId])).rows[0].metadata;
    try {
    await client.query("UPDATE app.merchants SET metadata=metadata - 'foundStockCheckout' WHERE id=$1", [scope.merchantId]);
    await setStockForVariant(10);
    const create = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:stock-conflict` }, {
      provider: "sepay_va",
      order: {
        items: [{ variantId, quantity: 2 }],
        customerId: "cus_demo",
        paymentMethod: "sepay_va",
        amountReceived: 0,
        foundStockConfirmation: { confirmed: true, acknowledgedShortages: [{ variantId, shortageQuantity: 2 }] },
        notes: `Stock conflict SePay payment intent ${runId}`,
        salesChannel: "pos_counter",
      },
    }, actor, scope);

    await updateMerchantCheckoutPolicy(scope.merchantId, { enabled: false, expectedVersion: 0 }, actor);
    await setStockForVariant(0);

    const event = await handleProviderPaymentEvent({
      provider: "sepay_va",
      providerEventId: `db-test:${runId}:stock-conflict`,
      eventType: "sepay.transaction",
      amount: create.response.data.amount,
      currencyCode: "vnd",
      referenceCode: create.response.data.referenceCode,
      direction: "in",
      payload: { source: "db-test", transferType: "in" },
      verification: { mode: "test" },
    });

    expect(event.data).toMatchObject({
      id: create.response.data.id,
      status: "manual_review",
      manualReviewReason: "stock_unavailable_after_payment",
      completedOrderId: null,
    });
    expect(await stockForVariant()).toBe(0);

    const eventRows = await client.query(`
      SELECT payment_intent_id, status, error
      FROM app.payment_provider_events
      WHERE provider = 'sepay_va' AND provider_event_id = $1
    `, [`db-test:${runId}:stock-conflict`]);
    expect(eventRows.rows).toHaveLength(1);
    expect(eventRows.rows[0]).toMatchObject({
      payment_intent_id: create.response.data.id,
      status: "manual_review",
      error: "stock_unavailable_after_payment",
    });

    const paymentRows = await client.query(`
      SELECT count(*)::int AS count
      FROM app.payment_entries
      WHERE metadata->>'paymentIntentId' = $1
    `, [create.response.data.id]);
    expect(paymentRows.rows[0].count).toBe(0);
    } finally {
      await client.query("UPDATE app.merchants SET metadata=$2::jsonb WHERE id=$1", [scope.merchantId, JSON.stringify(merchantMetadata)]);
      await setStockForVariant(10);
    }
  });

  it("posts SePay provider-confirmed sales to bank account journal lines", async () => {
    await setStockForVariant(10);
    const create = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:sepay-accounting` }, {
      provider: "sepay_va",
      order: {
        items: [{ variantId, quantity: 1 }],
        customerId: "cus_demo",
        paymentMethod: "sepay_va",
        amountReceived: 0,
        notes: `SePay accounting ${runId}`,
        salesChannel: "pos_counter",
      },
    }, actor, scope);

    const event = await handleProviderPaymentEvent({
      provider: "sepay_va",
      providerEventId: `db-test:${runId}:sepay-accounting`,
      eventType: "sepay.transaction",
      amount: create.response.data.amount,
      currencyCode: "vnd",
      referenceCode: create.response.data.referenceCode,
      direction: "in",
      payload: { source: "db-test", transferType: "in" },
      verification: { mode: "test" },
    });

    expect(event.data).toMatchObject({
      id: create.response.data.id,
      status: "completed",
      completedOrderId: expect.any(String),
    });

    await processSaleCreatedForOrder(String(event.data.completedOrderId));
    await expect(debitAccountCodesForOrder(String(event.data.completedOrderId))).resolves.toContain("1121");
    await expect(debitAccountCodesForOrder(String(event.data.completedOrderId))).resolves.not.toContain("1111");
  });

  it("matches NOWPayments provider amount while posting the VND order amount", async () => {
    const transactionHash = `0xdbtestnowpaymentshash-${runId}`;
    const create = await createPaymentIntent({ "idempotency-key": `db-test:${runId}:pi:nowpayments-provider-amount` }, {
      provider: "nowpayments",
      order: {
        items: [{ variantId, quantity: 1 }],
        customerId: "cus_demo",
        paymentMethod: "nowpayments",
        amountReceived: 0,
        notes: `NOWPayments provider amount ${runId}`,
        salesChannel: "pos_counter",
      },
    }, actor, scope);
    const intent = create.response.data;

    await client.query(`
      UPDATE app.payment_intents
      SET metadata = jsonb_set(metadata, '{provider}', (metadata->'provider') || $2::jsonb, true),
          provider_config_id = 'cfg_db_merchant_retail'
      WHERE id = $1
    `, [intent.id, JSON.stringify({
      expectedProviderAmount: "12.34",
      expectedProviderCurrency: "usdttrc20",
      payCurrency: "usdttrc20",
      providerConfigPurpose: "merchant_retail",
      providerConfigId: "cfg_db_merchant_retail",
      destinationWalletRef: "wallet_db_merchant_retail",
      quote: {
        vndUsdRate: 25000,
        exchangeRateSource: "NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE",
        quotedAt: "2026-06-21T01:00:00.000Z",
      },
    })]);

    const event = await handleProviderPaymentEvent({
      provider: "nowpayments",
      providerEventId: `db-test:${runId}:nowpayments-provider-amount`,
      eventType: "nowpayments.finished",
      amount: 12.34,
      currencyCode: "usdttrc20",
      referenceCode: intent.referenceCode,
      providerTransactionId: `np-${runId}-123`,
      providerTransactionHash: transactionHash,
      providerNetwork: "trc20",
      providerPayCurrency: "usdttrc20",
      retailCryptoAsset: "USDTTRC20",
      grossQuantity: "12.34",
      providerFeeQuantity: "0.01",
      providerFeeAmount: 0.01,
      providerFeeCurrency: "usdttrc20",
      payload: { source: "db-test", payment_status: "finished" },
      verification: { mode: "test", terminal: true, paymentStatus: "finished", providerFeeResolved: true },
    });

    expect(event.data).toMatchObject({
      id: intent.id,
      status: "completed",
      completedOrderId: expect.any(String),
    });

    const paymentRows = await client.query(
      "SELECT amount, status, method, metadata FROM app.payment_entries WHERE order_id = $1",
      [event.data.completedOrderId],
    );
    expect(paymentRows.rows).toHaveLength(1);
    expect(paymentRows.rows[0]).toMatchObject({
      status: "posted",
      method: "nowpayments",
    });
    expect(Number(paymentRows.rows[0].amount)).toBe(intent.amount);
    expect(paymentRows.rows[0].metadata).toMatchObject({
      paymentIntentId: intent.id,
      paymentProvider: "nowpayments",
      providerPaidAmount: 12.34,
      providerPaidCurrency: "usdttrc20",
      providerTransactionId: `np-${runId}-123`,
      providerTransactionHash: transactionHash,
      providerNetwork: "trc20",
      providerPayCurrency: "usdttrc20",
      amountReceived: intent.amount,
      merchantId: "merchant_default",
      storeId: "store_default",
    });
    const providerEventRows = await client.query(
      "SELECT payload FROM app.payment_provider_events WHERE provider = 'nowpayments' AND provider_event_id = $1",
      [`db-test:${runId}:nowpayments-provider-amount`],
    );
    expect(providerEventRows.rows[0].payload).toMatchObject({
      _normalized: {
        providerTransactionId: `np-${runId}-123`,
        providerTransactionHash: transactionHash,
        providerNetwork: "trc20",
          providerPayCurrency: "usdttrc20",
          providerFeeQuantity: "0.01",
          retailCryptoAsset: "USDTTRC20",
        },
      });
    expect(event.cryptoReceiptEvidence).toMatchObject({
      businessPurpose: "retail_order",
      merchantId: "merchant_default",
      storeId: "store_default",
      paymentIntentId: intent.id,
      providerEventId: `db-test:${runId}:nowpayments-provider-amount`,
      asset: "USDTTRC20",
      transactionHash,
      destinationWalletRef: "wallet_db_merchant_retail",
      grossQuantity: "12.34",
      providerFeeQuantity: "0.01",
      netQuantity: "12.33",
      grossVndValue: intent.amount,
      feeVndValue: 250,
      valuationRateSource: "NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE",
      valuationTimestamp: "2026-06-21T01:00:00.000Z",
    });
    await processSaleCreatedForOrder(String(event.data.completedOrderId));
    await expect(debitAccountCodesForOrder(String(event.data.completedOrderId))).resolves.toContain("1122");
    await expect(debitAccountCodesForOrder(String(event.data.completedOrderId))).resolves.not.toContain("1111");
    const accountingEvidence = await queryOne<{
      valuation_rate: string;
      valuation_rate_source: string;
      valuation_timestamp: string;
      quote_payload: Record<string, unknown>;
    }>(client, `
      SELECT valuation_rate::text, valuation_rate_source, valuation_timestamp::text, quote_payload
      FROM accounting.crypto_receipt_evidence
      WHERE provider = 'nowpayments' AND provider_event_id = $1
    `, [`db-test:${runId}:nowpayments-provider-amount`]);
    expect(Number(accountingEvidence?.valuation_rate)).toBe(25000);
    expect(accountingEvidence?.valuation_rate_source).toBe("NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE");
    expect(accountingEvidence?.quote_payload).toMatchObject({
      vndUsdRate: 25000,
      exchangeRateSource: "NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE",
      quotedAt: "2026-06-21T01:00:00.000Z",
    });
  });

  it("keeps a terminal receipt with missing provider fee evidence in manual review", async () => {
    await setStockForVariant(20);
    const intent = await createPreparedCryptoIntent("missing-fee");
    const providerEventId = `db-test:${runId}:missing-fee`;
    const event = await handleProviderPaymentEvent(cryptoEvent(intent, providerEventId, {
      providerFeeAmount: undefined,
      providerFeeCurrency: undefined,
      providerFeeQuantity: undefined,
      verification: { mode: "test", terminal: true, paymentStatus: "finished", providerFeeResolved: false },
    }));

    expect(event.data).toMatchObject({
      id: intent.id,
      status: "manual_review",
      manualReviewReason: "missing_provider_fee_evidence",
      completedOrderId: null,
    });
    const persisted = await queryOne<{ status: string; error: string; crypto_receipt_evidence: unknown }>(client, `
      SELECT status, error, crypto_receipt_evidence
      FROM app.payment_provider_events
      WHERE provider = 'nowpayments' AND provider_event_id = $1
    `, [providerEventId]);
    expect(persisted).toEqual({
      status: "manual_review",
      error: "missing_provider_fee_evidence",
      crypto_receipt_evidence: null,
    });
  });

  it("deduplicates sequential and concurrent terminal callbacks", async () => {
    await setStockForVariant(20);
    const sequentialIntent = await createPreparedCryptoIntent("sequential-duplicate");
    const sequentialEvent = cryptoEvent(sequentialIntent, `db-test:${runId}:sequential-duplicate`);
    const first = await handleProviderPaymentEvent(sequentialEvent);
    const replay = await handleProviderPaymentEvent(sequentialEvent);
    expect(replay.data.completedOrderId).toBe(first.data.completedOrderId);
    expect(replay.cryptoReceiptEvidence).toEqual(first.cryptoReceiptEvidence);

    const concurrentIntent = await createPreparedCryptoIntent("concurrent-duplicate");
    const concurrentEvent = cryptoEvent(concurrentIntent, `db-test:${runId}:concurrent-duplicate`);
    const concurrentResults = await Promise.all([
      handleProviderPaymentEvent(concurrentEvent),
      handleProviderPaymentEvent(concurrentEvent),
    ]);
    expect(concurrentResults[0].data.completedOrderId).toBe(concurrentResults[1].data.completedOrderId);

    for (const intent of [sequentialIntent, concurrentIntent]) {
      const counts = await queryOne<{ orders: number; payments: number; events: number }>(client, `
        SELECT
          (SELECT count(*)::int FROM public."order" WHERE metadata->>'paymentIntentId' = $1) AS orders,
          (SELECT count(*)::int FROM app.payment_entries WHERE payment_intent_id = $1) AS payments,
          (SELECT count(*)::int FROM app.payment_provider_events WHERE payment_intent_id = $1) AS events
      `, [intent.id]);
      expect(counts).toEqual({ orders: 1, payments: 1, events: 1 });
    }
  });

  it("processes waiting then finished callbacks with the same stable payment id", async () => {
    await setStockForVariant(20);
    const intent = await createPreparedCryptoIntent("out-of-order");
    const providerEventId = `db-test:${runId}:out-of-order`;
    const waiting = await handleProviderPaymentEvent(cryptoEvent(intent, providerEventId, {
      eventType: "nowpayments.waiting",
      grossQuantity: undefined,
      providerFeeQuantity: undefined,
      providerFeeAmount: undefined,
      providerFeeCurrency: undefined,
      providerTransactionHash: undefined,
      payload: { source: "db-test", payment_status: "waiting" },
      verification: { mode: "test", terminal: false, paymentStatus: "waiting", providerFeeResolved: false },
    }));
    expect(waiting.data).toMatchObject({ status: "manual_review", manualReviewReason: "non_terminal_payment_status" });

    const finished = await handleProviderPaymentEvent(cryptoEvent(intent, providerEventId));
    expect(finished.data).toMatchObject({ status: "completed", completedOrderId: expect.any(String) });
    const persisted = await queryOne<{ status: string; event_revision: number }>(client, `
      SELECT status, event_revision
      FROM app.payment_provider_events
      WHERE provider = 'nowpayments' AND provider_event_id = $1
    `, [providerEventId]);
    expect(persisted?.status).toBe("matched");
    expect(persisted?.event_revision).toBeGreaterThanOrEqual(3);
  });

  it("fails closed when a matched provider event is replayed with conflicting evidence", async () => {
    await setStockForVariant(20);
    const intent = await createPreparedCryptoIntent("conflicting-event");
    const providerEventId = `db-test:${runId}:conflicting-event`;
    const settled = await handleProviderPaymentEvent(cryptoEvent(intent, providerEventId));
    const conflict = await handleProviderPaymentEvent(cryptoEvent(intent, providerEventId, {
      providerTransactionHash: `conflicting-hash-${runId}`,
    }));

    expect(conflict.data).toMatchObject({
      id: intent.id,
      status: "manual_review",
      manualReviewReason: "conflicting_provider_event",
      completedOrderId: settled.data.completedOrderId,
    });
    const counts = await queryOne<{ orders: number; payments: number }>(client, `
      SELECT
        (SELECT count(*)::int FROM public."order" WHERE metadata->>'paymentIntentId' = $1) AS orders,
        (SELECT count(*)::int FROM app.payment_entries WHERE payment_intent_id = $1) AS payments
    `, [intent.id]);
    expect(counts).toEqual({ orders: 1, payments: 1 });
  });

  it("enforces merchant scope even when report scope also supplies store ids", async () => {
    const intent = await createPreparedCryptoIntent("tenant-isolation");
    await expect(getPaymentIntent(intent.id, {
      merchantId: "merchant_tenant_b",
      storeIds: ["store_tenant_a"],
    })).rejects.toMatchObject({ code: "resource_not_found" });
  });
});
