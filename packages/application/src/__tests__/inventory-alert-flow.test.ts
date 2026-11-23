import { describe, expect, it, beforeEach } from "vitest";
import { createApplication, createEmptyApplicationState, InMemoryStoreAdapter } from "../index.js";
import { seedState } from "./fixtures.js";
import { shouldTriggerAlert, calculateReorderQuantity } from "@medusa-snus/domain";
import type { RequestContext } from "../index.js";

function makeCtx(idempotencyKey?: string): RequestContext {
  return { actor: { type: "staff", id: "op_owner" }, correlationId: "cor_test", idempotencyKey };
}

function makeApp() {
  const state = createEmptyApplicationState();
  seedState(state);
  const store = new InMemoryStoreAdapter(state);
  const app = createApplication({ store });
  return { app, store, state };
}

describe("Inventory Alert Processing (Scenario 9)", () => {
  let app: ReturnType<typeof makeApp>["app"];
  let state: ReturnType<typeof makeApp>["state"];

  beforeEach(() => { const r = makeApp(); app = r.app; state = r.state; });

  it("emits stock.changed event with correct payload on sale", async () => {
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }], paymentMethod: "cash",
      amountReceived: 300000, idempotencyKey: "alert-001", context: makeCtx("alert-001"),
    });
    const stockEvents = state.outboxEvents.filter(e => e.eventType === "stock.changed");
    expect(stockEvents.length).toBeGreaterThanOrEqual(1);
    const payload = stockEvents[0].payload as Record<string, unknown>;
    expect(payload.movementType).toBe("sale");
    expect(payload.quantityAfter).toBe(9);
    expect(payload.reorderLevel).toBe(5);
  });

  it("triggers alert when stock drops below reorder_level after sale", async () => {
    // Berry: stock=2, reorder=5. Sell 1 → stock=1 < 5 → alert
    await app.completeSale({
      items: [{ variantId: "var_berry_20", quantity: 1 }], paymentMethod: "cash",
      amountReceived: 300000, idempotencyKey: "alert-002", context: makeCtx("alert-002"),
    });
    const event = state.outboxEvents.find(e =>
      e.eventType === "stock.changed" && (e.payload as Record<string, unknown>).variantId === "var_berry_20",
    );
    expect(event).toBeTruthy();
    const p = event!.payload as Record<string, unknown>;
    expect(shouldTriggerAlert(p.quantityAfter as number, p.reorderLevel as number)).toBe(true);
    expect(p.quantityAfter).toBe(1);
  });

  it("does not trigger alert when stock stays above reorder_level", async () => {
    // Mint: stock=10, reorder=5. Sell 2 → stock=8 > 5
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 2 }], paymentMethod: "cash",
      amountReceived: 600000, idempotencyKey: "alert-003", context: makeCtx("alert-003"),
    });
    const event = state.outboxEvents.find(e =>
      e.eventType === "stock.changed" && (e.payload as Record<string, unknown>).variantId === "var_mint_20",
    );
    const p = event!.payload as Record<string, unknown>;
    expect(shouldTriggerAlert(p.quantityAfter as number, p.reorderLevel as number)).toBe(false);
  });

  it("calculates reorder quantity for low stock product", () => {
    // avg 2/week, 1 week lead, 5 safety, stock=2 → (2*1)+5-2=5
    expect(calculateReorderQuantity({ averageWeeklySales: 2, leadTimeWeeks: 1, safetyStock: 5, currentStock: 2 })).toBe(5);
  });

  it("stock.changed event emitted on manual stock adjustment", async () => {
    await app.adjustStock({ inventoryItemId: "prod_mint", locationId: "loc_default", adjustment: -2, reason: "test", movementType: "damage", context: makeCtx() });
    const events = state.outboxEvents.filter(e => e.eventType === "stock.changed");
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("positive stock adjustment (found items) updates stock correctly", async () => {
    const r = await app.adjustStock({ inventoryItemId: "prod_mint", locationId: "loc_default", adjustment: 5, reason: "found", movementType: "manual_adjustment", context: makeCtx() });
    expect(r.newLevel).toBe(15);
    expect(state.products.find(p => p.id === "prod_mint")!.variants[0].stockLevel).toBe(15);
  });

  it("rejects cancelling an already cancelled order", async () => {
    const sale = await app.completeSale({ items: [{ variantId: "var_mint_20", quantity: 1 }], paymentMethod: "cash", amountReceived: 300000, idempotencyKey: "cancel-001", context: makeCtx("cancel-001") });
    await app.cancelSale({ orderId: sale.order.id, reason: "first", context: makeCtx() });
    await expect(app.cancelSale({ orderId: sale.order.id, reason: "second", context: makeCtx() })).rejects.toThrow("already cancelled");
  });

  it("receives partial purchase order", async () => {
    const po = await app.createPurchaseOrder({ supplierName: "Part PO", items: [{ variantId: "var_mint_20", quantity: 20, unitCost: 150000 }], context: makeCtx() });
    const r = await app.receivePurchaseOrder({ purchaseOrderId: po.id, items: [{ purchaseOrderItemId: po.items[0].id, receivedQuantity: 10 }], context: makeCtx() });
    expect(r.status).toBe("partially_received");
    expect(state.products.find(p => p.id === "prod_mint")!.variants[0].stockLevel).toBe(20);
  });

  it("rejects receiving more than ordered in PO", async () => {
    const po = await app.createPurchaseOrder({ supplierName: "Over PO", items: [{ variantId: "var_mint_20", quantity: 10, unitCost: 150000 }], context: makeCtx() });
    await expect(app.receivePurchaseOrder({ purchaseOrderId: po.id, items: [{ purchaseOrderItemId: po.items[0].id, receivedQuantity: 15 }], context: makeCtx() })).rejects.toThrow("exceeds ordered");
  });

  it("rejects receiving a cancelled purchase order", async () => {
    const po = await app.createPurchaseOrder({ supplierName: "Cancelled PO", items: [{ variantId: "var_mint_20", quantity: 10, unitCost: 150000 }], context: makeCtx() });
    po.status = "cancelled";
    await expect(app.receivePurchaseOrder({ purchaseOrderId: po.id, items: [{ purchaseOrderItemId: po.items[0].id, receivedQuantity: 5 }], context: makeCtx() })).rejects.toThrow("Cannot receive PO");
  });

  it("rejects receiving an already fully received PO", async () => {
    const po = await app.createPurchaseOrder({ supplierName: "Done PO", items: [{ variantId: "var_mint_20", quantity: 10, unitCost: 150000 }], context: makeCtx() });
    await app.receivePurchaseOrder({ purchaseOrderId: po.id, items: [{ purchaseOrderItemId: po.items[0].id, receivedQuantity: 10 }], context: makeCtx() });
    await expect(app.receivePurchaseOrder({ purchaseOrderId: po.id, items: [{ purchaseOrderItemId: po.items[0].id, receivedQuantity: 1 }], context: makeCtx() })).rejects.toThrow("Cannot receive PO");
  });
});
