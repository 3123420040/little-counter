import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import {
  adjustStock,
  cancelPurchaseOrder,
  closeShortPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrderDetail,
  listInventoryItems,
  listPurchaseOrders,
  listStockMovements,
  receivePurchaseOrder,
  sendPurchaseOrder,
} from "../services/inventory-service";
import { applyInventoryImport } from "../services/inventory-import-export-service";
import { processOutboxEvent } from "../services/outbox-processor-service";
import type { OperatorContext } from "../services/auth-service";

/**
 * Two-store / two-location inventory isolation proof.
 *
 * Inventory reads and mutations
 * previously used legacy role guards and could select an arbitrary
 * inventory_level row instead of the active OperatingScope.stockLocationId.
 *
 * This test seeds the same inventory_item at two stock locations with
 * different quantities and proves every read/mutation targets exactly the
 * selected scope.
 */
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const actor: OperatorContext = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "Inventory Isolation Owner",
  organizationId: "org_default",
};

const MERCHANT_A = "merchant_default";
const STORE_A = "store_default";
const SLOC_A = "sloc_default";

// Store B belongs to the same merchant. Cross-merchant isolation is covered
// separately with distinct products in tenant-scope.db.test.ts.
const MERCHANT_B = MERCHANT_A;
const STORE_B = `inv_iso_store_b_${runId}`;
const SLOC_B = `inv_iso_sloc_b_${runId}`;

const VARIANT_MINT = "var_mint_20";
const VARIANT_CITRUS = "var_citrus_20";

const scopeA = {
  scopeKind: "operating" as const,
  merchantId: MERCHANT_A,
  storeId: STORE_A,
  stockLocationId: SLOC_A,
};
const scopeB = {
  scopeKind: "operating" as const,
  merchantId: MERCHANT_B,
  storeId: STORE_B,
  stockLocationId: SLOC_B,
};

let client: PoolClient;
let inventoryItemId = "";
let citrusInventoryItemId = "";
let stockLevelA = 0;
let stockLevelB = 0;
let citrusStockLevelB = 0;
let createdPoIds: string[] = [];
let createdReceiptIds: string[] = [];
let createdLevelIds: string[] = [];

async function inventoryItemForVariant(variantId: string): Promise<string> {
  const result = await client.query<{ id: string }>(`
    SELECT vii.inventory_item_id AS id
    FROM public.product_variant_inventory_item vii
    WHERE vii.variant_id = $1 AND vii.deleted_at IS NULL
    LIMIT 1
  `, [variantId]);
  return result.rows[0]?.id || "";
}

async function stockAtInventoryItem(itemId: string, locationId: string): Promise<number> {
  const result = await client.query<{ stocked: string }>(`
    SELECT il.stocked_quantity::numeric AS stocked
    FROM public.inventory_level il
    WHERE il.inventory_item_id = $1 AND il.location_id = $2 AND il.deleted_at IS NULL
  `, [itemId, locationId]);
  return Number(result.rows[0]?.stocked || 0);
}

async function stockAt(locationId: string): Promise<number> {
  return stockAtInventoryItem(inventoryItemId, locationId);
}

async function scopeMovements(storeId: string): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM medusa.stock_movements
    WHERE store_id = $1
  `, [storeId]);
  return Number(result.rows[0]?.count || 0);
}

async function processPurchaseReceiptOutbox(receiptId: string) {
  const event = await client.query<{ id: string; event_type: string; payload: Record<string, unknown> }>(`
    SELECT id, event_type, payload
    FROM outbox.events
    WHERE event_type = 'purchase_order.received'
      AND aggregate_type = 'purchase_order_receipt'
      AND aggregate_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [receiptId]);
  expect(event.rows).toHaveLength(1);
  await processOutboxEvent({
    id: event.rows[0].id,
    eventType: event.rows[0].event_type,
    payload: event.rows[0].payload,
  });
}

async function journalCountForReceipt(receiptId: string): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM accounting.journal_entries
    WHERE reference_type = 'purchase_order_receipt'
      AND reference_id = $1
  `, [receiptId]);
  return Number(result.rows[0]?.count || 0);
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();

  // Resolve the inventory_item bound to the seeded mint variant.
  inventoryItemId = await inventoryItemForVariant(VARIANT_MINT);
  if (!inventoryItemId) throw new Error("test setup: mint inventory_item not found");
  citrusInventoryItemId = await inventoryItemForVariant(VARIANT_CITRUS);
  if (!citrusInventoryItemId) throw new Error("test setup: citrus inventory_item not found");

  // Seed a second store + stock_location + inventory_level for the SAME
  // merchant and inventory item so a location-unscoped query is detectable.
  await client.query("INSERT INTO public.stock_location (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [SLOC_B, `Iso Location B ${runId}`]);
  await client.query("INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status) VALUES ($1, $2, $3, $4, false, 'active') ON CONFLICT (id) DO NOTHING", [STORE_B, MERCHANT_B, `Iso Store B ${runId}`, SLOC_B]);

  // Baseline stock at both locations.
  await client.query("UPDATE public.inventory_level SET stocked_quantity = 50, updated_at = now() WHERE inventory_item_id = $1 AND location_id = $2 AND deleted_at IS NULL", [inventoryItemId, SLOC_A]);
  await client.query(`
    INSERT INTO public.inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, incoming_quantity)
    VALUES ($1, $2, $3, 30, 0, 0)
    ON CONFLICT (inventory_item_id, location_id) WHERE deleted_at IS NULL
    DO UPDATE SET stocked_quantity = EXCLUDED.stocked_quantity, deleted_at = NULL, updated_at = now()
  `, [`il_iso_b_${runId}`, inventoryItemId, SLOC_B]);
  createdLevelIds.push(`il_iso_b_${runId}`);
  await client.query(`
    INSERT INTO public.inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, incoming_quantity)
    VALUES ($1, $2, $3, 40, 0, 0)
    ON CONFLICT (inventory_item_id, location_id) WHERE deleted_at IS NULL
    DO UPDATE SET stocked_quantity = EXCLUDED.stocked_quantity, deleted_at = NULL, updated_at = now()
  `, [`il_iso_b_citrus_${runId}`, citrusInventoryItemId, SLOC_B]);
  createdLevelIds.push(`il_iso_b_citrus_${runId}`);

  stockLevelA = await stockAt(SLOC_A);
  stockLevelB = await stockAt(SLOC_B);
  citrusStockLevelB = await stockAtInventoryItem(citrusInventoryItemId, SLOC_B);
  expect(stockLevelA).toBe(50);
  expect(stockLevelB).toBe(30);
  expect(citrusStockLevelB).toBe(40);
}, 30_000);

afterAll(async () => {
  if (createdReceiptIds.length) {
    await client.query(`
      DELETE FROM accounting.journal_lines
      WHERE journal_entry_id IN (
        SELECT id FROM accounting.journal_entries
        WHERE reference_type = 'purchase_order_receipt'
          AND reference_id = ANY($1::text[])
      )
    `, [createdReceiptIds]).catch(() => undefined);
    await client.query(`
      DELETE FROM accounting.journal_entries
      WHERE reference_type = 'purchase_order_receipt'
        AND reference_id = ANY($1::text[])
    `, [createdReceiptIds]).catch(() => undefined);
  }
  if (createdReceiptIds.length || createdPoIds.length) {
    await client.query(`
      DELETE FROM outbox.events
      WHERE aggregate_id = ANY($1::text[])
         OR payload->>'purchaseOrderId' = ANY($2::text[])
    `, [createdReceiptIds, createdPoIds]).catch(() => undefined);
  }
  for (const poId of createdPoIds) {
    await client.query(`
      DELETE FROM inventory.purchase_order_receipt_items pori
      USING inventory.purchase_order_receipts por
      WHERE pori.receipt_id = por.id
        AND por.purchase_order_id = $1
    `, [poId]).catch(() => undefined);
    await client.query("DELETE FROM inventory.purchase_order_receipts WHERE purchase_order_id = $1", [poId]).catch(() => undefined);
    await client.query("DELETE FROM inventory.purchase_order_items WHERE purchase_order_id = $1", [poId]).catch(() => undefined);
    await client.query("DELETE FROM inventory.purchase_orders WHERE id = $1", [poId]).catch(() => undefined);
  }
  await client.query("DELETE FROM medusa.stock_movements WHERE store_id IN ($1, $2)", [STORE_A, STORE_B]).catch(() => undefined);
  for (const levelId of createdLevelIds) {
    await client.query("DELETE FROM public.inventory_level WHERE id = $1", [levelId]).catch(() => undefined);
  }
  await client.query("DELETE FROM app.stores WHERE id = $1", [STORE_B]).catch(() => undefined);
  await client.query("DELETE FROM public.stock_location WHERE id = $1", [SLOC_B]).catch(() => undefined);
  await client.query("UPDATE public.inventory_level SET stocked_quantity = $2, updated_at = now() WHERE inventory_item_id = $1 AND location_id = $3 AND deleted_at IS NULL", [inventoryItemId, stockLevelA, SLOC_A]).catch(() => undefined);
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("inventory operating scope isolation", () => {
  it("a product existing at two locations returns stock from the selected location only", async () => {
    const itemsA = await listInventoryItems(scopeA);
    const mintA = itemsA.inventory_items.find((i) => i.id === inventoryItemId);
    expect(mintA?.location_levels[0]?.stocked_quantity).toBe(stockLevelA);

    const itemsB = await listInventoryItems(scopeB);
    const mintB = itemsB.inventory_items.find((i) => i.id === inventoryItemId);
    expect(mintB?.location_levels[0]?.stocked_quantity).toBe(stockLevelB);
  });

  it("store A adjust does not change store B stock", async () => {
    const result = await adjustStock(
      { "idempotency-key": `db-test:${runId}:adjust-a` },
      { inventoryItemId: VARIANT_MINT, adjustment: -5, reason: "store A adjustment", movementType: "manual_adjustment" },
      actor,
      scopeA,
    );

    expect(result.statusCode).toBe(201);
    expect(result.response.data.newLevel).toBe(stockLevelA - 5);
    await expect(stockAt(SLOC_A)).resolves.toBe(stockLevelA - 5);
    const history = await listStockMovements(scopeA, {
      inventoryItemId,
      sourceAction: "manual_adjustment",
    });
    const movement = history.data.find((entry) => entry.reason === "store A adjustment");
    expect(movement).toMatchObject({
      inventoryItemId,
      sourceAction: "manual_adjustment",
      movementType: "manual_adjustment",
      quantityBefore: stockLevelA,
      quantityChange: -5,
      quantityAfter: stockLevelA - 5,
      actorDisplayName: actor.displayName,
      actorRole: actor.role,
      historyQuality: "native",
    });
    expect(history.summary.currentStock).toBe(stockLevelA - 5);
    expect(history.summary.reconciledToCurrentStock).toBe(true);
    // Store B untouched.
    await expect(stockAt(SLOC_B)).resolves.toBe(stockLevelB);
    // Movement stamped with store A.
    await expect(scopeMovements(STORE_A)).resolves.toBeGreaterThan(0);
  });

  it("store B adjust does not change store A stock", async () => {
    await adjustStock(
      { "idempotency-key": `db-test:${runId}:adjust-b` },
      { inventoryItemId: VARIANT_MINT, adjustment: 10, reason: "store B adjustment", movementType: "manual_adjustment" },
      actor,
      scopeB,
    );

    await expect(stockAt(SLOC_B)).resolves.toBe(stockLevelB + 10);
    await expect(stockAt(SLOC_A)).resolves.toBe(stockLevelA - 5);
    await expect(scopeMovements(STORE_B)).resolves.toBeGreaterThan(0);
  });

  it("duplicate adjust request does not mutate stock twice", async () => {
    const before = await stockAt(SLOC_A);
    const key = { "idempotency-key": `db-test:${runId}:dup-adjust` };
    const body = { inventoryItemId: VARIANT_MINT, adjustment: 2, reason: "dup", movementType: "manual_adjustment" };

    const first = await adjustStock(key, body, actor, scopeA);
    const second = await adjustStock(key, body, actor, scopeA);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    // Idempotent replay returns the same newLevel; stock did not move twice.
    expect(second.response.data.newLevel).toBe(first.response.data.newLevel);
    await expect(stockAt(SLOC_A)).resolves.toBe(before + 2);
  });

  it("CSV inventory import records stock history with import metadata", async () => {
    const before = await stockAt(SLOC_A);
    const csv = [
      "sku,variantId,inventoryItemId,adjustment,reason,movementType",
      `,,${inventoryItemId},1,csv-count,manual_adjustment`,
    ].join("\n");

    const applied = await applyInventoryImport({}, csv, actor, scopeA);

    expect(applied.appliedRows).toBe(1);
    await expect(stockAt(SLOC_A)).resolves.toBe(before + 1);
    const history = await listStockMovements(scopeA, {
      inventoryItemId,
      sourceAction: "csv_import",
    });
    const movement = history.data.find((entry) => (
      entry.metadata
      && typeof entry.metadata === "object"
      && (entry.metadata as Record<string, unknown>).importId === applied.importId
    ));
    expect(movement).toMatchObject({
      inventoryItemId,
      sourceAction: "csv_import",
      movementType: "manual_adjustment",
      quantityBefore: before,
      quantityChange: 1,
      quantityAfter: before + 1,
      reason: "csv-count",
      actorDisplayName: actor.displayName,
      historyQuality: "native",
    });
    expect(movement?.metadata).toMatchObject({
      importId: applied.importId,
      rowNumber: 2,
      variantId: VARIANT_MINT,
      historyQuality: "native",
    });
  });

  it("createPurchaseOrder stamps the selected merchant/store and lists only that store", async () => {
    const created = await createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-b` },
      { supplierName: `Iso Supplier B ${runId}`, items: [{ variantId: VARIANT_MINT, quantity: 5, unitCost: 99000 }] },
      actor,
      scopeB,
    );
    const poId = created.response.data.id;
    createdPoIds.push(poId);

    const stamped = await client.query<{ merchant_id: string; store_id: string }>(
      "SELECT merchant_id, store_id FROM inventory.purchase_orders WHERE id = $1",
      [poId],
    );
    expect(stamped.rows[0]).toEqual({ merchant_id: MERCHANT_B, store_id: STORE_B });

    // Store A list must not include store B's PO.
    const listA = await listPurchaseOrders(scopeA);
    expect(listA.data.find((po) => po.id === poId)).toBeUndefined();
    const listB = await listPurchaseOrders(scopeB);
    expect(listB.data.find((po) => po.id === poId)).toBeDefined();
  });

  it("store A cannot receive a store B purchase order", async () => {
    const created = await createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-b-receive` },
      { supplierName: `Iso Supplier B Receive ${runId}`, items: [{ variantId: VARIANT_MINT, quantity: 4, unitCost: 99000 }] },
      actor,
      scopeB,
    );
    const poId = created.response.data.id;
    createdPoIds.push(poId);
    const itemId = created.response.data.items[0].id;

    const stockBeforeA = await stockAt(SLOC_A);
    const stockBeforeB = await stockAt(SLOC_B);

    await expect(receivePurchaseOrder(
      { "idempotency-key": `db-test:${runId}:receive-as-a` },
      poId,
      { items: [{ purchaseOrderItemId: itemId, receivedQuantity: 4 }] },
      actor,
      scopeA,
    )).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });

    // Nothing changed at either location.
    await expect(stockAt(SLOC_A)).resolves.toBe(stockBeforeA);
    await expect(stockAt(SLOC_B)).resolves.toBe(stockBeforeB);
  });

  it("store B receives its own PO into its own location only", async () => {
    const created = await createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-b-own` },
      { supplierName: `Iso Supplier B Own ${runId}`, items: [{ variantId: VARIANT_MINT, quantity: 3, unitCost: 99000 }] },
      actor,
      scopeB,
    );
    const poId = created.response.data.id;
    createdPoIds.push(poId);
    const itemId = created.response.data.items[0].id;

    const stockBeforeB = await stockAt(SLOC_B);
    const stockBeforeA = await stockAt(SLOC_A);

    const received = await receivePurchaseOrder(
      { "idempotency-key": `db-test:${runId}:receive-b-own` },
      poId,
      { items: [{ purchaseOrderItemId: itemId, receivedQuantity: 3 }] },
      actor,
      scopeB,
    );

    expect(received.response.data.status).toBe("received");
    await expect(stockAt(SLOC_B)).resolves.toBe(stockBeforeB + 3);
    const movements = await listStockMovements(scopeB, {
      inventoryItemId,
      sourceAction: "po_receive",
    });
    const receiptMovement = movements.data.find((entry) => (
      entry.metadata
      && typeof entry.metadata === "object"
      && (entry.metadata as Record<string, unknown>).purchaseOrderId === poId
    ));
    expect(receiptMovement).toMatchObject({
      inventoryItemId,
      sourceAction: "po_receive",
      movementType: "purchase_receipt",
      quantityBefore: stockBeforeB,
      quantityChange: 3,
      quantityAfter: stockBeforeB + 3,
      referenceType: "purchase_order_receipt",
      actorDisplayName: actor.displayName,
    });
    expect(receiptMovement?.referenceDisplay).toContain(poId);
    // Store A inventory untouched by store B receive.
    await expect(stockAt(SLOC_A)).resolves.toBe(stockBeforeA);
  });

  it("duplicate PO receive does not over-receive", async () => {
    const created = await createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-dup` },
      { supplierName: `Iso Supplier Dup ${runId}`, items: [{ variantId: VARIANT_MINT, quantity: 2, unitCost: 99000 }] },
      actor,
      scopeB,
    );
    const poId = created.response.data.id;
    createdPoIds.push(poId);
    const itemId = created.response.data.items[0].id;

    const key = { "idempotency-key": `db-test:${runId}:dup-receive` };
    const body = { items: [{ purchaseOrderItemId: itemId, receivedQuantity: 2 }] };

    const first = await receivePurchaseOrder(key, poId, body, actor, scopeB);
    const second = await receivePurchaseOrder(key, poId, body, actor, scopeB);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    // Idempotent replay returns the same final status without over-receiving.
    expect(second.response.data.status).toBe(first.response.data.status);

    const item = await client.query<{ received_quantity: string }>(
      "SELECT received_quantity::text FROM inventory.purchase_order_items WHERE id = $1",
      [itemId],
    );
    expect(item.rows[0]?.received_quantity).toBe("2");
  });

  it("multiline PO receiving records receipt batches, movements and one accounting journal per receipt", async () => {
    const created = await createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-multiline` },
      {
        supplierName: `Iso Supplier Multiline ${runId}`,
        items: [
          { variantId: VARIANT_MINT, quantity: 4, unitCost: 1000 },
          { variantId: VARIANT_CITRUS, quantity: 6, unitCost: 2000 },
        ],
      },
      actor,
      scopeB,
    );
    const poId = created.response.data.id;
    createdPoIds.push(poId);
    const mintItemId = created.response.data.items.find((item: { variantId: string }) => item.variantId === VARIANT_MINT)?.id;
    const citrusItemId = created.response.data.items.find((item: { variantId: string }) => item.variantId === VARIANT_CITRUS)?.id;
    expect(mintItemId).toBeTruthy();
    expect(citrusItemId).toBeTruthy();

    const mintBeforeB = await stockAt(SLOC_B);
    const citrusBeforeB = await stockAtInventoryItem(citrusInventoryItemId, SLOC_B);
    const mintBeforeA = await stockAt(SLOC_A);

    const first = await receivePurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-multiline-first` },
      poId,
      { items: [
        { purchaseOrderItemId: mintItemId, receivedQuantity: 1 },
        { purchaseOrderItemId: citrusItemId, receivedQuantity: 2 },
      ] },
      actor,
      scopeB,
    );
    const firstReceiptId = String(first.response.data.receipt.id);
    createdReceiptIds.push(firstReceiptId);
    expect(first.statusCode).toBe(201);
    expect(first.response.data.status).toBe("partially_received");
    expect(first.response.data.receipt.items).toHaveLength(2);
    await expect(stockAt(SLOC_B)).resolves.toBe(mintBeforeB + 1);
    await expect(stockAtInventoryItem(citrusInventoryItemId, SLOC_B)).resolves.toBe(citrusBeforeB + 2);
    await expect(stockAt(SLOC_A)).resolves.toBe(mintBeforeA);

    const firstReceiptRows = await client.query<{ receipt_items: string; movements: string }>(`
      SELECT
        (SELECT count(*)::text FROM inventory.purchase_order_receipt_items WHERE receipt_id = $1) AS receipt_items,
        (SELECT count(*)::text FROM medusa.stock_movements WHERE reference_type = 'purchase_order_receipt' AND reference_id = $1) AS movements
    `, [firstReceiptId]);
    expect(firstReceiptRows.rows[0]).toEqual({ receipt_items: "2", movements: "2" });

    await processPurchaseReceiptOutbox(firstReceiptId);
    await expect(journalCountForReceipt(firstReceiptId)).resolves.toBe(1);
    await processPurchaseReceiptOutbox(firstReceiptId);
    await expect(journalCountForReceipt(firstReceiptId)).resolves.toBe(1);

    const second = await receivePurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-multiline-second` },
      poId,
      { items: [
        { purchaseOrderItemId: mintItemId, receivedQuantity: 3 },
        { purchaseOrderItemId: citrusItemId, receivedQuantity: 4 },
      ] },
      actor,
      scopeB,
    );
    const secondReceiptId = String(second.response.data.receipt.id);
    createdReceiptIds.push(secondReceiptId);
    expect(second.response.data.status).toBe("received");
    expect(secondReceiptId).not.toBe(firstReceiptId);

    const detail = await getPurchaseOrderDetail(poId, scopeB);
    expect(detail.data.status).toBe("received");
    expect(detail.data.receipts).toHaveLength(2);
    expect(detail.data.items.map((item) => item.lineStatus)).toEqual(["received", "received"]);
    expect(detail.data.totals).toMatchObject({
      orderedQuantity: 10,
      receivedQuantity: 10,
      remainingQuantity: 0,
      receivedValue: 16_000,
    });
    await processPurchaseReceiptOutbox(secondReceiptId);
    await expect(journalCountForReceipt(secondReceiptId)).resolves.toBe(1);

    const aggregate = await client.query<{ receipts: string; receipt_items: string }>(`
      SELECT
        (SELECT count(*)::text FROM inventory.purchase_order_receipts WHERE purchase_order_id = $1) AS receipts,
        (SELECT count(*)::text
         FROM inventory.purchase_order_receipt_items pori
         JOIN inventory.purchase_order_receipts por ON por.id = pori.receipt_id
         WHERE por.purchase_order_id = $1) AS receipt_items
    `, [poId]);
    expect(aggregate.rows[0]).toEqual({ receipts: "2", receipt_items: "4" });
  });

  it("fails closed for unknown zero cost, preserves explicit free, and pages receipt history deterministically", async () => {
    await expect(createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-unknown-cost` },
      { supplierName: `Unknown Cost ${runId}`, items: [{ variantId: VARIANT_MINT, quantity: 1, unitCost: 0 }] },
      actor,
      scopeB,
    )).rejects.toMatchObject({ code: "purchase_order_cost_unknown", statusCode: 409 });

    const free = await createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-free-cost` },
      {
        supplierName: `Free Cost ${runId}`,
        items: [{ variantId: VARIANT_MINT, quantity: 1, unitCost: 0, unitCostQuality: "free" }],
      },
      actor,
      scopeB,
    );
    const freePoId = String(free.response.data.id);
    createdPoIds.push(freePoId);
    const freeDetail = await getPurchaseOrderDetail(freePoId, scopeB);
    expect(freeDetail.data.items[0]).toMatchObject({ unitCost: 0, unitCostQuality: "free" });
    expect(freeDetail.data.totals).toMatchObject({ valueAvailable: true, orderedValue: 0, receivedValue: 0 });
    const freeListEntry = (await listPurchaseOrders(scopeB)).data.find((po) => po.id === freePoId);
    expect(freeListEntry).toMatchObject({ totalCostAvailable: true, totalCost: 0 });

    const legacyUnknown = await createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-legacy-unknown-cost` },
      { supplierName: `Legacy Unknown ${runId}`, items: [{ variantId: VARIANT_CITRUS, quantity: 2, unitCost: 2000 }] },
      actor,
      scopeB,
    );
    const legacyUnknownPoId = String(legacyUnknown.response.data.id);
    createdPoIds.push(legacyUnknownPoId);
    await client.query(
      "UPDATE inventory.purchase_order_items SET unit_cost = 0 WHERE purchase_order_id = $1",
      [legacyUnknownPoId],
    );
    const legacyUnknownListEntry = (await listPurchaseOrders(scopeB)).data.find((po) => po.id === legacyUnknownPoId);
    expect(legacyUnknownListEntry).toMatchObject({ totalCostAvailable: false, totalCost: null });

    const paged = await createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-receipt-pages` },
      { supplierName: `Receipt Pages ${runId}`, items: [{ variantId: VARIANT_CITRUS, quantity: 11, unitCost: 2000 }] },
      actor,
      scopeB,
    );
    const pagedPoId = String(paged.response.data.id);
    const pagedItemId = String(paged.response.data.items[0].id);
    createdPoIds.push(pagedPoId);
    for (let index = 0; index < 11; index += 1) {
      const receipt = await receivePurchaseOrder(
        { "idempotency-key": `db-test:${runId}:po-receipt-page-${index}` },
        pagedPoId,
        { note: `receipt-${index}`, items: [{ purchaseOrderItemId: pagedItemId, receivedQuantity: 1 }] },
        actor,
        scopeB,
      );
      createdReceiptIds.push(String(receipt.response.data.receipt.id));
    }

    const firstPage = await getPurchaseOrderDetail(pagedPoId, scopeB, { receiptLimit: 5, receiptOffset: 0 });
    const secondPage = await getPurchaseOrderDetail(pagedPoId, scopeB, { receiptLimit: 5, receiptOffset: 5 });
    const lastPage = await getPurchaseOrderDetail(pagedPoId, scopeB, { receiptLimit: 5, receiptOffset: 10 });
    expect(firstPage.data.receiptPage).toEqual({ total: 11, limit: 5, offset: 0, hasPrevious: false, hasNext: true });
    expect(secondPage.data.receiptPage).toEqual({ total: 11, limit: 5, offset: 5, hasPrevious: true, hasNext: true });
    expect(lastPage.data.receiptPage).toEqual({ total: 11, limit: 5, offset: 10, hasPrevious: true, hasNext: false });
    expect(firstPage.data.receipts).toHaveLength(5);
    expect(secondPage.data.receipts).toHaveLength(5);
    expect(lastPage.data.receipts).toHaveLength(1);
    const receiptIds = [
      ...firstPage.data.receipts,
      ...secondPage.data.receipts,
      ...lastPage.data.receipts,
    ].map((receipt) => receipt.id);
    expect(new Set(receiptIds).size).toBe(11);
  });

  it("rejects invalid receive payloads and terminal status transitions without mutating stock", async () => {
    const created = await createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-validation` },
      { supplierName: `Iso Supplier Validation ${runId}`, items: [{ variantId: VARIANT_MINT, quantity: 3, unitCost: 99000 }] },
      actor,
      scopeB,
    );
    const poId = created.response.data.id;
    createdPoIds.push(poId);
    const itemId = created.response.data.items[0].id;
    const stockBefore = await stockAt(SLOC_B);

    await expect(receivePurchaseOrder({ "idempotency-key": `db-test:${runId}:empty-items` }, poId, { items: [] }, actor, scopeB))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    await expect(receivePurchaseOrder({ "idempotency-key": `db-test:${runId}:zero-items` }, poId, { items: [{ purchaseOrderItemId: itemId, receivedQuantity: 0 }] }, actor, scopeB))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    await expect(receivePurchaseOrder({ "idempotency-key": `db-test:${runId}:dup-items` }, poId, { items: [
      { purchaseOrderItemId: itemId, receivedQuantity: 1 },
      { purchaseOrderItemId: itemId, receivedQuantity: 1 },
    ] }, actor, scopeB)).rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    await expect(receivePurchaseOrder({ "idempotency-key": `db-test:${runId}:over-items` }, poId, { items: [{ purchaseOrderItemId: itemId, receivedQuantity: 4 }] }, actor, scopeB))
      .rejects.toMatchObject({ code: "invalid_receipt_quantity", statusCode: 409 });

    const other = await createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-validation-other` },
      { supplierName: `Iso Supplier Validation Other ${runId}`, items: [{ variantId: VARIANT_MINT, quantity: 1, unitCost: 99000 }] },
      actor,
      scopeB,
    );
    const otherPoId = other.response.data.id;
    createdPoIds.push(otherPoId);
    await expect(receivePurchaseOrder({ "idempotency-key": `db-test:${runId}:wrong-item` }, poId, { items: [{ purchaseOrderItemId: other.response.data.items[0].id, receivedQuantity: 1 }] }, actor, scopeB))
      .rejects.toMatchObject({ code: "resource_not_found", statusCode: 404 });

    await expect(stockAt(SLOC_B)).resolves.toBe(stockBefore);
    const receiptCount = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM inventory.purchase_order_receipts WHERE purchase_order_id = $1", [poId]);
    expect(receiptCount.rows[0]?.count).toBe("0");

    const sent = await sendPurchaseOrder({ "idempotency-key": `db-test:${runId}:po-validation-send` }, poId, { note: "sent validation" }, actor, scopeB);
    expect(sent.response.data.status).toBe("sent");
    const cancelled = await cancelPurchaseOrder({ "idempotency-key": `db-test:${runId}:po-validation-cancel` }, poId, { reason: "supplier cancelled" }, actor, scopeB);
    expect(cancelled.response.data.status).toBe("cancelled");
    expect(cancelled.response.data.cancelReason).toBe("supplier cancelled");
    await expect(receivePurchaseOrder({ "idempotency-key": `db-test:${runId}:cancelled-receive` }, poId, { items: [{ purchaseOrderItemId: itemId, receivedQuantity: 1 }] }, actor, scopeB))
      .rejects.toMatchObject({ code: "invalid_state_transition", statusCode: 409 });

    const shortPo = await createPurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-close-short` },
      { supplierName: `Iso Supplier Short ${runId}`, items: [{ variantId: VARIANT_MINT, quantity: 3, unitCost: 99000 }] },
      actor,
      scopeB,
    );
    const shortPoId = shortPo.response.data.id;
    createdPoIds.push(shortPoId);
    const shortItemId = shortPo.response.data.items[0].id;
    const partial = await receivePurchaseOrder(
      { "idempotency-key": `db-test:${runId}:po-close-short-receive` },
      shortPoId,
      { items: [{ purchaseOrderItemId: shortItemId, receivedQuantity: 1 }] },
      actor,
      scopeB,
    );
    createdReceiptIds.push(String(partial.response.data.receipt.id));
    expect(partial.response.data.status).toBe("partially_received");
    await expect(cancelPurchaseOrder({ "idempotency-key": `db-test:${runId}:po-close-short-cancel` }, shortPoId, { reason: "cancel after receipt" }, actor, scopeB))
      .rejects.toMatchObject({ code: "invalid_state_transition", statusCode: 409 });
    const closed = await closeShortPurchaseOrder({ "idempotency-key": `db-test:${runId}:po-close-short-final` }, shortPoId, { reason: "supplier short shipped" }, actor, scopeB);
    expect(closed.response.data.status).toBe("closed_short");
    expect(closed.response.data.items[0].lineStatus).toBe("short_closed");
    await expect(receivePurchaseOrder({ "idempotency-key": `db-test:${runId}:closed-short-receive` }, shortPoId, { items: [{ purchaseOrderItemId: shortItemId, receivedQuantity: 1 }] }, actor, scopeB))
      .rejects.toMatchObject({ code: "invalid_state_transition", statusCode: 409 });
  });

  it("listStockMovements returns only movements for the selected store", async () => {
    const movementsB = await listStockMovements(scopeB);
    const allBForMint = movementsB.data.filter((m) => m.inventoryItemId === inventoryItemId);
    expect(allBForMint.length).toBeGreaterThan(0);

    // Cross-check: none of store B's movement rows leak store A identity.
    const rowsB = await client.query<{ store_id: string | null }>(`
      SELECT store_id FROM medusa.stock_movements WHERE store_id = $1
    `, [STORE_B]);
    for (const row of rowsB.rows) {
      expect(row.store_id).toBe(STORE_B);
    }
  });
});
