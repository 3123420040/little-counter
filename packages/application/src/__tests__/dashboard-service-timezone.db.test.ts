import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { shutdownPlatformDb } from "../platform-db";
import { getDashboard } from "../services/dashboard-service";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const merchantId = `dash-live-tz-merchant-${runId}`;
const storeId = `dash-live-tz-store-${runId}`;
const stockLocationId = `dash-live-tz-sloc-${runId}`;
const orderId = `dash-live-tz-order-${runId}`;
let client: PoolClient;

beforeAll(async () => {
  client = await connectPlatformClient();
  await client.query(`
    INSERT INTO app.merchants (id, display_name, legacy_organization_id, status, metadata)
    VALUES ($1, $1, $2, 'active', '{}'::jsonb)
  `, [merchantId, `org-${merchantId}`]);
  await client.query(
    "INSERT INTO public.stock_location (id, name) VALUES ($1, $1)",
    [stockLocationId],
  );
  await client.query(`
    INSERT INTO app.stores (
      id, merchant_id, display_name, stock_location_id, is_primary, status, metadata
    ) VALUES (
      $1, $2, $1, $3, true, 'active',
      '{"ownerSettings":{"timezone":"Asia/Ho_Chi_Minh"}}'::jsonb
    )
  `, [storeId, merchantId, stockLocationId]);
  await client.query(`
    INSERT INTO public."order" (
      id, status, currency_code, metadata, merchant_id, store_id, created_at
    ) VALUES ($1, 'completed', 'vnd', '{}'::jsonb, $2, $3, $4::timestamptz)
  `, [orderId, merchantId, storeId, "2026-03-07T17:30:00.000Z"]);
  await client.query("BEGIN");
  const revision = await client.query<{ id: string }>(`
    INSERT INTO app.order_commercial_revisions (
      merchant_id, store_id, order_id, revision, source_type, source_id,
      commercial_state, currency_code, minor_unit_exponent, effective_at,
      idempotency_key, data_quality
    ) VALUES (
      $1, $2, $3, 0, 'original_order', $3, 'active', 'VND', 0,
      $4::timestamptz, $5, 'complete'
    )
    RETURNING id::text
  `, [merchantId, storeId, orderId, "2026-03-07T17:30:00.000Z", `dash-live-tz:${runId}`]);
  await client.query(`
    INSERT INTO app.order_commercial_revision_components (
      revision_id, merchant_id, store_id, order_id, revision, currency_code,
      minor_unit_exponent, tax_mode, merchandise_gross_minor, discount_minor,
      merchandise_net_minor, shipping_minor, merchandise_vat_minor,
      shipping_vat_minor, vat_minor, unclassified_minor, total_minor
    ) VALUES (
      $1::uuid, $2, $3, $4, 0, 'VND', 0, 'inclusive',
      100000, 0, 100000, 0, 9091, 0, 9091, 0, 100000
    )
  `, [revision.rows[0]!.id, merchantId, storeId, orderId]);
  await client.query(`
    INSERT INTO app.order_commercial_revision_lines (
      revision_id, merchant_id, store_id, order_id, revision, line_key,
      sku_snapshot, title_snapshot, quantity, unit_price_minor, line_total_minor
    ) VALUES (
      $1::uuid, $2, $3, $4, 0, 'line-1', 'TZ-SKU', 'Timezone SKU', 1, 100000, 100000
    )
  `, [revision.rows[0]!.id, merchantId, storeId, orderId]);
  await client.query("COMMIT");
});

afterAll(async () => {
  await client?.query("DELETE FROM app.order_commercial_revision_lines WHERE order_id = $1", [orderId]).catch(() => undefined);
  await client?.query("DELETE FROM app.order_commercial_revision_components WHERE order_id = $1", [orderId]).catch(() => undefined);
  await client?.query("DELETE FROM app.order_commercial_revisions WHERE order_id = $1", [orderId]).catch(() => undefined);
  await client?.query("DELETE FROM public.\"order\" WHERE id = $1", [orderId]).catch(() => undefined);
  await client?.query("DELETE FROM app.stores WHERE id = $1", [storeId]).catch(() => undefined);
  await client?.query("DELETE FROM public.stock_location WHERE id = $1", [stockLocationId]).catch(() => undefined);
  await client?.query("DELETE FROM app.merchants WHERE id = $1", [merchantId]).catch(() => undefined);
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("live dashboard store-local business date", () => {
  it("includes an order after local midnight even when its UTC date is the prior day", async () => {
    const scope = { scopeKind: "report" as const, merchantId, storeIds: [storeId] };

    const localMarch8 = await getDashboard(scope, { date: "2026-03-08" });
    expect(localMarch8.data.orderCount).toBe(1);
    expect(localMarch8.data.totalRevenue).toBe(100000);
    expect(localMarch8.data.daily).toEqual([expect.objectContaining({
      date: "2026-03-08",
      orders: 1,
      revenue: 100000,
    })]);
    expect(localMarch8.data.newCustomers).toBeNull();

    const localMarch7 = await getDashboard(scope, { date: "2026-03-07" });
    expect(localMarch7.data.orderCount).toBe(0);
    expect(localMarch7.data.totalRevenue).toBe(0);
  });
});
