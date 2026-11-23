import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { requireSafeTestDatabaseTarget, assertSafeTestDatabaseSentinel } from "../db/test-database-target";
import { createOrderForClient, cancelOrder, quoteOrderCancellation } from "../services/order-service";
import { applyOrderCorrection, previewOrderCorrection } from "../services/order-correction-service";
import { createPurchaseOrder, receivePurchaseOrder } from "../services/inventory-service";
import { shutdownPlatformDb } from "../platform-db";
import { ensurePlatformSchema } from "../db/schema";
import type { OperatorContext } from "../services/auth-service";

const scope = { scopeKind: "operating" as const, merchantId: "merchant_default", storeId: "store_default", stockLocationId: "sloc_default" };
const actor: OperatorContext = { operatorId: "op_owner", role: "owner", organizationId: "org_default", displayName: "Synthetic stock regression" };
const variants = ["var_mint_20", "var_citrus_20"];
let pool: Pool; let db: PoolClient; let level: string; let item: string; let originalMapping: string;
let originalStock: string; let originalReserved: string;
const headers = () => ({ "idempotency-key": `partner-stock-test:${randomUUID()}` });
async function stock() { return Number((await db.query("SELECT stocked_quantity FROM public.inventory_level WHERE id=$1", [level])).rows[0].stocked_quantity); }
async function create(quantities: number[]) {
  await db.query("BEGIN");
  try {
    const result = await createOrderForClient(db, { items: variants.map((variantId, i) => ({ variantId, quantity: quantities[i] })),
      paymentMethod: "cod", amountReceived: 0, salesChannel: "telegram" }, actor,
    { ...scope, source: "remote", salesChannelId: "sc_remote", orderStatus: "completed", remoteStatus: "confirmed" });
    await db.query("COMMIT"); return result.data.orderId;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString }); db = await pool.connect();
  await assertSafeTestDatabaseSentinel(db, target);
  await ensurePlatformSchema(db);
  const rows = (await db.query(`SELECT vii.variant_id,vii.inventory_item_id,il.id,il.stocked_quantity,il.reserved_quantity
    FROM public.product_variant_inventory_item vii JOIN public.inventory_level il ON il.inventory_item_id=vii.inventory_item_id
    AND il.location_id='sloc_default' AND il.deleted_at IS NULL WHERE vii.variant_id=ANY($1::text[]) AND vii.deleted_at IS NULL`, [variants])).rows;
  const mint = rows.find(r => r.variant_id === variants[0]);
  level = mint.id; item = mint.inventory_item_id; originalStock = mint.stocked_quantity; originalReserved = mint.reserved_quantity;
  originalMapping = rows.find(r => r.variant_id === variants[1]).inventory_item_id;
});
beforeEach(async () => {
  await db.query("UPDATE public.product_variant_inventory_item SET inventory_item_id=$1 WHERE variant_id=$2 AND deleted_at IS NULL", [item, variants[1]]);
  await db.query("UPDATE public.inventory_level SET stocked_quantity=10,reserved_quantity=0 WHERE id=$1", [level]);
});
afterEach(async () => {
  await db.query("UPDATE public.product_variant_inventory_item SET inventory_item_id=$1 WHERE variant_id=$2 AND deleted_at IS NULL", [originalMapping, variants[1]]);
  await db.query("UPDATE public.inventory_level SET stocked_quantity=$2,reserved_quantity=$3 WHERE id=$1", [level, originalStock, originalReserved]);
});
afterAll(async () => { db?.release(); await pool?.end(); await shutdownPlatformDb(); });
describe("shared inventory balances across staff mutation paths", () => {
  it("restores all quantities and chained movement balances on staff cancellation", async () => {
    const orderId = await create([2, 3]); expect(await stock()).toBe(5);
    const { quote } = await quoteOrderCancellation(orderId, scope, actor);
    await cancelOrder(headers(), orderId, { reason: "Synthetic cancellation regression", quoteId: quote.quoteId,
      effectiveRevision: quote.effectiveRevision, quoteGeneratedAt: quote.generatedAt }, actor, scope);
    expect(await stock()).toBe(10);
    const rows = (await db.query("SELECT metadata->>'quantityBefore' AS quantity_before,quantity_change,quantity_after FROM medusa.stock_movements WHERE reference_id=$1 AND source_action='order_cancel'", [orderId])).rows;
    expect(rows.reduce((n, r) => n + Number(r.quantity_change), 0)).toBe(5);
    expect(rows.some(r => Number(r.quantity_after) === 10)).toBe(true);
    expect(rows.every(r => Number(r.quantity_before) + Number(r.quantity_change) === Number(r.quantity_after))).toBe(true);
  });
  it("rejects combined shortage across correction variants and rolls back all effects", async () => {
    const orderId = await create([2, 3]);
    const body = { baseRevision: 0, reason: "Synthetic shared stock shortage", items: [
      { variantId: variants[0], quantity: 6 }, { variantId: variants[1], quantity: 7 }], settlement: { method: "cod", amountReceived: 0 } };
    await expect(previewOrderCorrection(orderId, body, actor, scope)).rejects.toMatchObject({ code: "insufficient_stock" });
    await expect(applyOrderCorrection(headers(), orderId, body, actor, scope)).rejects.toMatchObject({ code: "insufficient_stock" });
    expect(await stock()).toBe(5);
  });
  it("deducts cumulative correction quantities without overwriting the first variant", async () => {
    const orderId = await create([1, 1]);
    const body = { baseRevision: 0, reason: "Synthetic shared stock correction", items: [
      { variantId: variants[0], quantity: 3 }, { variantId: variants[1], quantity: 4 }], settlement: { method: "cod", amountReceived: 0 } };
    const preview = await previewOrderCorrection(orderId, body, actor, scope);
    await applyOrderCorrection(headers(), orderId, { ...body, settlement: { method: "cod", amountReceived: preview.data.totalDelta } }, actor, scope);
    expect(await stock()).toBe(3);
  });
  it("increments shared stock for both purchase order receipt lines and retains replay idempotency", async () => {
    const created = await createPurchaseOrder(headers(), { supplierName: "Synthetic stock fixture", items: variants.map((variantId, i) => ({ variantId, quantity: i + 2, unitCost: 1000 })) }, actor, scope);
    const po = created.response.data;
    const body = { items: po.items.map(line => ({ purchaseOrderItemId: line.id, receivedQuantity: Number(line.quantity) })) };
    const key = headers();
    await receivePurchaseOrder(key, po.id, body, actor, scope);
    await receivePurchaseOrder(key, po.id, body, actor, scope);
    expect(await stock()).toBe(15);
  });
});
