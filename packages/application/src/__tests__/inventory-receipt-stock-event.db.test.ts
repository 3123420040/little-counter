import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import type { OperatorContext } from "../services/auth-service";

// Real PostgreSQL effects stay inside the test's rollback; service failures retain savepoint rollback.
const harness = vi.hoisted(() => ({ client: null as PoolClient | null, serial: 0 }));
vi.mock("../db/transaction", async original => ({
  ...await original<typeof import("../db/transaction")>(),
  withConnectedTransaction: async (handler: (client: PoolClient) => Promise<unknown>) => {
    const db = harness.client!, name = `receipt_event_${++harness.serial}`;
    await db.query(`SAVEPOINT ${name}`);
    try { const result = await handler(db); await db.query(`RELEASE SAVEPOINT ${name}`); return result; }
    catch (error) { await db.query(`ROLLBACK TO SAVEPOINT ${name}`); await db.query(`RELEASE SAVEPOINT ${name}`); throw error; }
  },
}));
import { createPurchaseOrder, receivePurchaseOrder } from "../services/inventory-service";
import { shutdownPlatformPool } from "../db/client";

let pool: Pool, db: PoolClient, prefix: string, actor: OperatorContext;
let scope: { scopeKind: "operating"; merchantId: string; storeId: string; stockLocationId: string };
const key = () => ({ "idempotency-key": `receipt-event:${randomUUID()}` });
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString }); db = await pool.connect(); harness.client = db;
  await assertSafeTestDatabaseSentinel(db, target);
});
beforeEach(async () => {
  vi.stubEnv("PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED", "false");
  await db.query("BEGIN");
  prefix = `receipt${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  scope = { scopeKind: "operating", merchantId: `${prefix}_m`, storeId: `${prefix}_s1`, stockLocationId: `${prefix}_l1` };
  actor = { operatorId: `${prefix}_owner`, role: "owner", organizationId: `${prefix}_org`, displayName: "Synthetic receipt event" };
  await db.query(`
    INSERT INTO app.merchants(id,display_name,legacy_organization_id,status) VALUES ('fixture_m','Synthetic receipt','fixture_org','active');
    INSERT INTO public.stock_location(id,name) VALUES ('fixture_l1','Receipt target'),('fixture_l2','Other store');
    INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status) VALUES
      ('fixture_s1','fixture_m','Receipt target','fixture_l1','active'),('fixture_s2','fixture_m','Other store','fixture_l2','active');
    INSERT INTO public.product(id,title,handle,status,merchant_id) VALUES ('fixture_p','Synthetic receipt','fixture_p','published','fixture_m');
    INSERT INTO public.product_variant(id,title,sku,product_id) VALUES ('fixture_v1','One','fixture_sku1','fixture_p'),('fixture_v2','Two','fixture_sku2','fixture_p');
    INSERT INTO public.inventory_item(id) VALUES ('fixture_i1'),('fixture_i2');
    INSERT INTO public.product_variant_inventory_item(id,variant_id,inventory_item_id) VALUES ('fixture_map1','fixture_v1','fixture_i1'),('fixture_map2','fixture_v2','fixture_i2');
    INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity) VALUES
      ('fixture_il1','fixture_i1','fixture_l1',10,0),('fixture_il2','fixture_i2','fixture_l1',20,0),('fixture_other','fixture_i1','fixture_l2',40,0);
  `.replace(/\bfixture_/g, `${prefix}_`));
});
afterEach(async () => { try { await db?.query("ROLLBACK"); } finally { vi.unstubAllEnvs(); } });
afterAll(async () => { db?.release(); await pool?.end(); await shutdownPlatformPool(); });

async function create() {
  const result = await createPurchaseOrder(key(), { supplierName: "Synthetic receipt", items: [
    { variantId: `${prefix}_v1`, quantity: 3, unitCost: 1000 },
    { variantId: `${prefix}_v2`, quantity: 4, unitCost: 1000 },
  ] }, actor, scope);
  const poId = String(result.response.data.id);
  const lines = (await db.query<{ id: string }>("SELECT id FROM inventory.purchase_order_items WHERE purchase_order_id=$1 ORDER BY variant_id", [poId])).rows;
  expect(lines).toHaveLength(2);
  return { poId, lines };
}
async function balances() {
  return (await db.query("SELECT stocked_quantity::int AS stock FROM public.inventory_level WHERE id=ANY($1::text[]) ORDER BY id",
    [[`${prefix}_il1`, `${prefix}_il2`, `${prefix}_other`]])).rows.map(row => row.stock);
}
async function effects() {
  const result: Record<string, unknown> = {};
  for (const table of ["public.inventory_level", "inventory.purchase_orders", "inventory.purchase_order_items", "inventory.purchase_order_receipts",
    "inventory.purchase_order_receipt_items", "medusa.stock_movements", "outbox.events", "outbox.aggregate_sequences", "app.idempotency_records", "audit.events"]) {
    result[table] = (await db.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text) AS digest FROM ${table} t`)).rows;
  }
  return result;
}
async function assertEvents(receiptId: string, poId: string, expected: number[][]) {
  const events = (await db.query(`SELECT payload FROM outbox.events WHERE event_type='stock.changed' AND payload->>'receiptId'=$1
    ORDER BY aggregate_id,aggregate_sequence`, [receiptId])).rows;
  expect(events).toHaveLength(expected.length);
  expect(events.map(({ payload: p }) => [p.quantityBefore, p.quantityChange, p.quantityAfter])).toEqual(expected);
  for (const { payload: p } of events) {
    expect(p).toMatchObject({ merchantId: scope.merchantId, storeId: scope.storeId, stockLocationId: scope.stockLocationId, purchaseOrderId: poId, receiptId });
    expect(Number.isSafeInteger(p.quantityBefore)).toBe(true);
    expect(p.quantityBefore + p.quantityChange).toBe(p.quantityAfter);
    const movements = (await db.query(`SELECT metadata,quantity_change::int AS delta,quantity_after::int AS after,
      merchant_id,store_id,stock_location_id,reference_id FROM medusa.stock_movements WHERE id=$1`, [p.movementId])).rows;
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ metadata: { quantityBefore: p.quantityBefore, receiptId }, delta: p.quantityChange, after: p.quantityAfter,
      merchant_id: scope.merchantId, store_id: scope.storeId, stock_location_id: scope.stockLocationId, reference_id: receiptId });
  }
  const receiptEvents = (await db.query("SELECT payload FROM outbox.events WHERE event_type='purchase_order.received' AND payload->>'receiptId'=$1", [receiptId])).rows;
  expect(receiptEvents).toHaveLength(1);
  expect(receiptEvents[0].payload).toMatchObject({ purchaseOrderId: poId, inventoryValue: expected.reduce((sum, line) => sum + line[1] * 1000, 0) });
}

describe("purchase receipt persisted stock.changed facts", () => {
  it("records first and subsequent multi-line balances and replays without additional effects", async () => {
    const { poId, lines } = await create();
    const first = await receivePurchaseOrder(key(), poId, { items: [
      { purchaseOrderItemId: lines[0].id, receivedQuantity: 2 }, { purchaseOrderItemId: lines[1].id, receivedQuantity: 1 },
    ] }, actor, scope);
    expect(first.statusCode).toBe(201);
    await assertEvents(first.response.data.receipt.id, poId, [[10, 2, 12], [20, 1, 21]]);
    expect(await balances()).toEqual([12, 21, 40]);
    const headers = key(), body = { items: [
      { purchaseOrderItemId: lines[1].id, receivedQuantity: 3 }, { purchaseOrderItemId: lines[0].id, receivedQuantity: 1 },
    ] };
    const last = await receivePurchaseOrder(headers, poId, body, actor, scope);
    await assertEvents(last.response.data.receipt.id, poId, [[12, 1, 13], [21, 3, 24]]);
    expect(await balances()).toEqual([13, 24, 40]);
    expect(last.response.data.purchaseOrder.status).toBe("received");
    const before = await effects(), replay = await receivePurchaseOrder(headers, poId, body, actor, scope);
    expect(replay.statusCode).toBe(200);
    expect(replay.response).toEqual(JSON.parse(JSON.stringify(last.response)));
    expect(await effects()).toEqual(before);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  });

  it.each(["shared inventory", "legacy duplicate variant"])("chains balances for %s lines in receipt order", async mode => {
    const { poId, lines } = await create();
    if (mode === "shared inventory") {
      await db.query("UPDATE public.product_variant_inventory_item SET inventory_item_id=$1 WHERE id=$2", [`${prefix}_i1`, `${prefix}_map2`]);
    } else {
      // Normal creation rejects duplicate variants; this owned row represents a pre-existing legacy PO.
      await db.query("UPDATE inventory.purchase_order_items SET variant_id=$1 WHERE id=$2", [`${prefix}_v1`, lines[1].id]);
    }
    const headers = key(), body = { items: [
      { purchaseOrderItemId: lines[1].id, receivedQuantity: 3 }, { purchaseOrderItemId: lines[0].id, receivedQuantity: 2 },
    ] };
    const receipt = await receivePurchaseOrder(headers, poId, body, actor, scope);
    await assertEvents(receipt.response.data.receipt.id, poId, [[10, 3, 13], [13, 2, 15]]);
    expect(await balances()).toEqual([15, 20, 40]);
    const before = await effects(), replay = await receivePurchaseOrder(headers, poId, body, actor, scope);
    expect(replay.statusCode).toBe(200);
    expect(replay.response).toEqual(JSON.parse(JSON.stringify(receipt.response)));
    expect(await effects()).toEqual(before);
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  });
});
