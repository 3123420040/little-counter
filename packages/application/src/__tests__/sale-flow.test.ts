import { describe, expect, it, beforeEach } from "vitest";
import { createApplication, createEmptyApplicationState, InMemoryStoreAdapter } from "../index.js";
import { seedState } from "./fixtures.js";
import type { RequestContext } from "../index.js";

function makeCtx(idempotencyKey?: string): RequestContext {
  return {
    actor: { type: "staff", id: "op_owner" },
    correlationId: "cor_test",
    idempotencyKey,
  };
}

function makeApp() {
  const state = createEmptyApplicationState();
  seedState(state);
  const store = new InMemoryStoreAdapter(state);
  const app = createApplication({ store });
  return { app, store, state };
}

describe("Sale Completion Flow", () => {
  let app: ReturnType<typeof makeApp>["app"];
  let store: ReturnType<typeof makeApp>["store"];
  let state: ReturnType<typeof makeApp>["state"];

  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    store = result.store;
    state = result.state;
  });

  it("completes a cash sale and deducts inventory", async () => {
    const result = await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 2 }],
      customerId: "cus_1",
      paymentMethod: "cash",
      amountReceived: 600000,
      idempotencyKey: "sale-001",
      context: makeCtx("sale-001"),
    });

    expect(result.order.status).toBe("completed");
    expect(result.order.total).toBe(500000);
    expect(result.change).toBe(100000);

    // Inventory deducted
    const product = state.products.find(p => p.id === "prod_mint")!;
    expect(product.variants[0].stockLevel).toBe(8);

    // Stock movement recorded
    const movements = state.stockMovements;
    expect(movements.length).toBeGreaterThanOrEqual(1);
    const saleMovement = movements.find(m => m.movementType === "sale");
    expect(saleMovement).toBeTruthy();
    expect(saleMovement!.quantityChange).toBe(-2);
    expect(saleMovement!.quantityAfter).toBe(8);
  });

  it("emits sale.created event on completion", async () => {
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 300000,
      idempotencyKey: "sale-002",
      context: makeCtx("sale-002"),
    });

    const events = state.outboxEvents.filter(e => e.eventType === "sale.created");
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).total).toBe(250000);
  });

  it("emits stock.changed event for each product", async () => {
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 300000,
      idempotencyKey: "sale-003",
      context: makeCtx("sale-003"),
    });

    const stockEvents = state.outboxEvents.filter(e => e.eventType === "stock.changed");
    expect(stockEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates sale by idempotency key", async () => {
    const input = {
      items: [{ variantId: "var_mint_20", quantity: 1 }] as const,
      paymentMethod: "cash" as const,
      amountReceived: 300000,
      idempotencyKey: "sale-004",
      context: makeCtx("sale-004"),
    };

    await app.completeSale(input);
    const orderCountAfterFirst = state.orders.length;

    // Duplicate call
    const result = await app.completeSale(input);

    expect(state.orders).toHaveLength(orderCountAfterFirst);
    const product = state.products.find(p => p.id === "prod_mint")!;
    expect(product.variants[0].stockLevel).toBe(9); // Deducted only once
    expect(result.order.status).toBe("completed");
  });

  it("rejects idempotency conflict with different body", async () => {
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 300000,
      idempotencyKey: "sale-conflict",
      context: makeCtx("sale-conflict"),
    });

    await expect(app.completeSale({
      items: [{ variantId: "var_citrus_20", quantity: 1 }],
      paymentMethod: "transfer",
      amountReceived: 300000,
      idempotencyKey: "sale-conflict",
      context: makeCtx("sale-conflict"),
    })).rejects.toThrow("Same key, different request body");
  });

  it("rejects sale with insufficient stock", async () => {
    await expect(app.completeSale({
      items: [{ variantId: "var_berry_20", quantity: 5 }],
      paymentMethod: "cash",
      amountReceived: 2000000,
      idempotencyKey: "sale-no-stock",
      context: makeCtx("sale-no-stock"),
    })).rejects.toThrow("insufficient");
  });

  it("creates loyalty record on sale with customer", async () => {
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      customerId: "cus_1",
      paymentMethod: "cash",
      amountReceived: 300000,
      idempotencyKey: "sale-loyalty",
      context: makeCtx("sale-loyalty"),
    });

    const loyaltyRecords = state.loyaltyRecords;
    expect(loyaltyRecords.length).toBeGreaterThanOrEqual(1);
    // 250000 / 10000 = 25 points
    const record = loyaltyRecords[loyaltyRecords.length - 1];
    expect(record.pointsEarned).toBe(25);
    expect(record.customerId).toBe("cus_1");
  });

  it("creates accounting entries on sale", async () => {
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 300000,
      idempotencyKey: "sale-acct",
      context: makeCtx("sale-acct"),
    });

    const journalEntries = state.journalEntries;
    expect(journalEntries.length).toBeGreaterThanOrEqual(1);
    const saleEntry = journalEntries[journalEntries.length - 1];
    expect(saleEntry.status).toBe("posted");
    expect(saleEntry.referenceType).toBe("order");
  });

  it("allows bank transfer payment", async () => {
    const result = await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      paymentMethod: "bank_transfer",
      amountReceived: 250000,
      idempotencyKey: "sale-transfer",
      context: makeCtx("sale-transfer"),
    });
    expect(result.order.paymentMethod).toBe("bank_transfer");
    expect(result.order.status).toBe("completed");
  });

  it("allows COD payment", async () => {
    const result = await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      paymentMethod: "cod",
      amountReceived: 250000,
      idempotencyKey: "sale-cod",
      context: makeCtx("sale-cod"),
    });
    expect(result.order.paymentMethod).toBe("cod");
  });

  it("calculates correct change for cash payment", async () => {
    const result = await app.completeSale({
      items: [{ variantId: "var_mint_slim", quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 200000,
      idempotencyKey: "sale-change",
      context: makeCtx("sale-change"),
    });
    expect(result.order.total).toBe(180000);
    expect(result.change).toBe(20000);
  });

  it("normalizes fixed discount and shipping fee through the shared commercial adjustment contract", async () => {
    const result = await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 300000,
      discountType: "amount",
      discountValue: 20000,
      shippingFee: 10000,
      idempotencyKey: "sale-fixed-discount-shipping",
      context: makeCtx("sale-fixed-discount-shipping"),
    });

    expect(result.order).toMatchObject({
      subtotal: 250000,
      discount: 20000,
      merchandisePayable: 230000,
      shippingFee: 10000,
      total: 240000,
      loyaltyBase: 230000,
      discountType: "amount",
      discountValue: 20000,
      discountPercent: 0,
      commercialAdjustmentVersion: 1,
    });
    expect(result.change).toBe(60000);
  });

  it("anonymous sale skips loyalty", async () => {
    const beforeLoyaltyCount = state.loyaltyRecords.length;
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 300000,
      idempotencyKey: "sale-anon",
      context: makeCtx("sale-anon"),
    });
    // No new loyalty record for anonymous
    expect(state.loyaltyRecords).toHaveLength(beforeLoyaltyCount);
  });

  it("cancels an order and restores inventory", async () => {
    const sale = await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 2 }],
      paymentMethod: "cash",
      amountReceived: 600000,
      idempotencyKey: "sale-to-cancel",
      context: makeCtx("sale-to-cancel"),
    });
    expect(state.products.find(p => p.id === "prod_mint")!.variants[0].stockLevel).toBe(8);

    const result = await app.cancelSale({
      orderId: sale.order.id,
      reason: "Customer changed mind",
      context: makeCtx(),
    });

    expect(result.status).toBe("cancelled");
    // Stock restored
    expect(state.products.find(p => p.id === "prod_mint")!.variants[0].stockLevel).toBe(10);
  });
});
