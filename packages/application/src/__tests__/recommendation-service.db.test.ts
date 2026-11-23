import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import type { OperatorContext } from "../services/auth-service";
import { createProduct } from "../services/product-management-service";
import { adjustStock } from "../services/inventory-service";
import { getCrossSellRecommendations, recordCrossSellAcceptance } from "../services/recommendation-service";

const originalPackage = process.env.APP_PACKAGE_KEY;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const actor: OperatorContext = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "DB Test Owner",
  organizationId: "org_default",
};
const TEST_MERCHANT = `merchant_recommendation_${runId}`;
const OTHER_MERCHANT = `merchant_recommendation_other_${runId}`;
const TEST_STORE = `store_recommendation_${runId}`;
const OTHER_STORE = `store_recommendation_other_${runId}`;
const LOCATION = `sloc_recommendation_${runId}`;

let client: PoolClient;


beforeAll(async () => {
  process.env.APP_PACKAGE_KEY = "ai_fan";
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await client.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id) VALUES($1,$1,$1)", [TEST_MERCHANT]);
  await client.query("INSERT INTO public.stock_location(id,name) VALUES($1,$1)", [LOCATION]);
  await client.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id) VALUES($1,$2,$1,$3)", [TEST_STORE,TEST_MERCHANT,LOCATION]);
  const operating = { scopeKind: "operating" as const, merchantId: TEST_MERCHANT, storeId: TEST_STORE, stockLocationId: LOCATION };
  for (let i=0;i<3;i++) {
    const product = await createProduct({ "idempotency-key": `${runId}:recommendation:${i}` }, {
      title: `Recommendation ${runId} ${i}`, sku: `${runId}-RECO-${i}`, price: 150000,
      costPrice: 75000, reorderLevel: 2, categoryIds: [],
    }, actor, { scopeKind: "merchant_target", merchantId: TEST_MERCHANT }, operating);
    const item=(await client.query("SELECT inventory_item_id FROM public.product_variant_inventory_item WHERE variant_id=$1",[product.response.product.variants[0]!.id])).rows[0];
    await adjustStock({ "idempotency-key": `${runId}:stock:${i}` }, { inventoryItemId: item.inventory_item_id, adjustment: 20, reason: "Recommendation fixture opening stock" }, actor, operating);
  }
});

afterAll(async () => {
  if (client) {
    await client.query(`DELETE FROM ai_module.cross_sell_events WHERE merchant_id IN ($1, $2)`, [TEST_MERCHANT, OTHER_MERCHANT]);

  }
  client?.release();
  if (originalPackage === undefined) delete process.env.APP_PACKAGE_KEY;
  else process.env.APP_PACKAGE_KEY = originalPackage;
  await shutdownPlatformDb().catch(() => undefined);
});

describe("cross-sell recommendation PostgreSQL integration", () => {
  it("returns staff-safe reasons and filters current cart variants", async () => {
    const result = await getCrossSellRecommendations({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      customerId: "cus_demo",
      merchantId: TEST_MERCHANT,
      storeId: TEST_STORE,
      stockLocationId: LOCATION,
      limit: 5,
    });

    expect(result.data.length).toBeGreaterThan(0);
    for (const item of result.data) {
      expect(item.variantId).not.toBe("var_mint_20");
      expect(item.stock).toBeGreaterThan(0);
      expect(item.reason.toLowerCase()).not.toContain("margin");
      expect(item.reason.toLowerCase()).not.toContain("cost");
      expect(item.reason.toLowerCase()).not.toContain("priority");
    }
  });

  it("does not return another merchant's products", async () => {
    const result = await getCrossSellRecommendations({
      items: [],
      merchantId: OTHER_MERCHANT,
      storeId: OTHER_STORE,
      stockLocationId: LOCATION,
      limit: 5,
    });

    expect(result.data).toHaveLength(0);
  });

  it("records accepted recommendation events for audit and learning", async () => {
    const acceptedVariantId = `var_cross_sell_${runId}`;
    const result = await recordCrossSellAcceptance({
      merchantId: TEST_MERCHANT,
      storeId: TEST_STORE,
      acceptedVariantId,
      acceptedProductId: `prod_cross_sell_${runId}`,
      cartVariantIds: ["var_mint_20", "var_citrus_10"],
      customerId: "cus_demo",
      source: "pos",
      metadata: {
        score: 128,
        reason: "db-test",
      },
    }, actor);

    expect(result.data.recorded).toBe(true);
    expect(result.data.id).toBeTruthy();

    const rows = await client.query(`
      SELECT merchant_id, store_id, event_type, cart_variant_ids, accepted_variant_id, accepted_product_id,
        customer_id, source, metadata, created_by
      FROM ai_module.cross_sell_events
      WHERE id = $1
    `, [result.data.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      event_type: "accepted",
      merchant_id: TEST_MERCHANT,
      store_id: TEST_STORE,
      accepted_variant_id: acceptedVariantId,
      accepted_product_id: `prod_cross_sell_${runId}`,
      customer_id: "cus_demo",
      source: "pos",
      created_by: "op_owner",
    });
    expect(rows.rows[0].cart_variant_ids).toEqual(["var_mint_20", "var_citrus_10"]);
    expect(rows.rows[0].metadata).toMatchObject({ score: 128, reason: "db-test" });
  });
});
