import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPlatformClient, type PoolClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import { createPaymentIntent } from "../services/payment-intent-service";

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const merchantId = `merchant_payment_scope_${suffix}`;
const storeId = `store_payment_scope_${suffix}`;
const stockLocationId = `sloc_payment_scope_${suffix}`;
const originalEnv = { ...process.env };
let client: PoolClient;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.APP_PACKAGE_KEY = "ai_fan";
  process.env.CRYPTO_PAYMENTS_ENABLED = "true";
  process.env.NOWPAYMENTS_LIVE_ENABLED = "false";
  process.env.CRYPTO_PROVIDER = "nowpayments";
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query(
    "INSERT INTO app.merchants (id, display_name, legacy_organization_id) VALUES ($1, $2, $3)",
    [merchantId, "Scoped Payment Merchant", `org_${merchantId}`],
  );
  await client.query(
    "INSERT INTO public.stock_location (id, name) VALUES ($1, $2)",
    [stockLocationId, "Scoped Payment Location"],
  );
  await client.query(`
    INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status)
    VALUES ($1, $2, $3, $4, true, 'active')
  `, [storeId, merchantId, "Scoped Payment Store", stockLocationId]);
  await client.query(`
    INSERT INTO app.integration_configs (
      id, provider_key, purpose, scope_type, merchant_id, status,
      secret_digest, created_by, updated_by
    ) VALUES ($1, 'nowpayments', 'merchant_retail', 'merchant', $2, 'inactive', $3, $4, $4)
  `, [`cfg_payment_scope_${suffix}`, merchantId, `digest_${suffix}`, "payment_scope_test"]);
});

afterAll(async () => {
  await client?.query("DELETE FROM app.idempotency_records WHERE tenant_id = $1", [merchantId]).catch(() => undefined);
  await client?.query("DELETE FROM app.payment_intents WHERE merchant_id = $1", [merchantId]).catch(() => undefined);
  await client?.query("DELETE FROM app.integration_configs WHERE merchant_id = $1", [merchantId]).catch(() => undefined);
  await client?.query("DELETE FROM app.stores WHERE id = $1", [storeId]).catch(() => undefined);
  await client?.query("DELETE FROM public.stock_location WHERE id = $1", [stockLocationId]).catch(() => undefined);
  await client?.query("DELETE FROM app.merchants WHERE id = $1", [merchantId]).catch(() => undefined);
  client?.release();
  process.env = { ...originalEnv };
  await shutdownPlatformDb();
});

describe("payment intent scoped provider boundary", () => {
  it("rejects an explicitly inactive merchant provider before writing an intent", async () => {
    const before = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM app.payment_intents WHERE merchant_id = $1",
      [merchantId],
    );

    await expect(createPaymentIntent(
      { "idempotency-key": `payment-scope-${suffix}` },
      {
        provider: "nowpayments",
        order: {
          items: [],
          paymentMethod: "nowpayments",
          amountReceived: 0,
          salesChannel: "pos_counter",
        },
      },
      {
        operatorId: "payment_scope_test",
        role: "owner",
        displayName: "Payment Scope Test",
        organizationId: `org_${merchantId}`,
      },
      { merchantId, storeId, stockLocationId },
    )).rejects.toMatchObject({
      code: "provider_disabled",
      statusCode: 503,
      details: { provider: "nowpayments", reason: "integration_config_inactive" },
    });

    const after = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM app.payment_intents WHERE merchant_id = $1",
      [merchantId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
