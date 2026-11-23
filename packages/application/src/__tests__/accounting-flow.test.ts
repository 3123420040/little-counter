import { describe, expect, it, beforeEach } from "vitest";
import { createApplication, createEmptyApplicationState, InMemoryStoreAdapter } from "../index.js";
import { seedState } from "./fixtures.js";
import type { RequestContext } from "../index.js";

const TODAY = new Date().toISOString().slice(0, 10);

function makeCtx(): RequestContext {
  return { actor: { type: "accountant", id: "op_acc" }, correlationId: "cor_test" };
}

function makeApp() {
  const state = createEmptyApplicationState();
  seedState(state);
  const store = new InMemoryStoreAdapter(state);
  const app = createApplication({ store });
  return { app, store, state };
}

describe("Accounting Flow", () => {
  let app: ReturnType<typeof makeApp>["app"];
  let state: ReturnType<typeof makeApp>["state"];

  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    state = result.state;
  });

  it("auto-creates journal entry on sale", async () => {
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 300000,
      idempotencyKey: "acct-auto-001",
      context: { ...makeCtx(), actor: { type: "staff", id: "op_owner" }, idempotencyKey: "acct-auto-001" },
    });

    const entries = state.journalEntries;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[entries.length - 1];
    expect(entry.status).toBe("posted");
    expect(entry.referenceType).toBe("order");
    expect(entry.lines).toHaveLength(4);

    // Verify double-entry balance
    const totalDebit = entry.lines.reduce((s, l) => s + l.debitAmount, 0);
    const totalCredit = entry.lines.reduce((s, l) => s + l.creditAmount, 0);
    expect(totalDebit).toBe(totalCredit);

    // Should have Cash debit line
    const cashLine = entry.lines.find(l => l.accountCode === "1111");
    expect(cashLine).toBeTruthy();
    expect(cashLine!.debitAmount).toBeGreaterThan(0);

    // Should have Revenue credit line
    const revenueLine = entry.lines.find(l => l.accountCode === "5111");
    expect(revenueLine).toBeTruthy();
    expect(revenueLine!.creditAmount).toBeGreaterThan(0);
  });

  it("creates manual journal entry", async () => {
    const entry = await app.createManualJournalEntry({
      entryDate: TODAY,
      referenceType: "manual",
      description: "Điều chỉnh cuối kỳ",
      lines: [
        { accountCode: "6321", debitAmount: 100000, creditAmount: 0, description: "Chi phí" },
        { accountCode: "1111", debitAmount: 0, creditAmount: 100000, description: "Tiền mặt" },
      ],
      context: makeCtx(),
    });

    expect(entry.id).toBeTruthy();
    expect(entry.status).toBe("draft");
    expect(entry.entryNumber).toMatch(/^JE-/);
    expect(entry.lines).toHaveLength(2);
  });

  it("rejects unbalanced journal entry", async () => {
    await expect(app.createManualJournalEntry({
      entryDate: TODAY,
      description: "Unbalanced",
      lines: [
        { accountCode: "6321", debitAmount: 100000, creditAmount: 0 },
        { accountCode: "1111", debitAmount: 0, creditAmount: 50000 },
      ],
      context: makeCtx(),
    })).rejects.toThrow("Debits");
  });

  it("rejects entry with non-existent account", async () => {
    await expect(app.createManualJournalEntry({
      entryDate: TODAY,
      description: "Bad account",
      lines: [
        { accountCode: "9999", debitAmount: 100000, creditAmount: 0 },
        { accountCode: "1111", debitAmount: 0, creditAmount: 100000 },
      ],
      context: makeCtx(),
    })).rejects.toThrow("Account 9999 not found");
  });

  it("posts a draft journal entry", async () => {
    const draft = await app.createManualJournalEntry({
      entryDate: TODAY,
      description: "To post",
      lines: [
        { accountCode: "6321", debitAmount: 50000, creditAmount: 0 },
        { accountCode: "1111", debitAmount: 0, creditAmount: 50000 },
      ],
      context: makeCtx(),
    });
    expect(draft.status).toBe("draft");

    const posted = await app.postJournalEntry({
      entryId: draft.id,
      context: makeCtx(),
    });
    expect(posted.status).toBe("posted");
    expect(posted.postedAt).toBeTruthy();
  });

  it("rejects posting an already posted entry", async () => {
    const draft = await app.createManualJournalEntry({
      entryDate: TODAY,
      description: "Double post",
      lines: [
        { accountCode: "6321", debitAmount: 50000, creditAmount: 0 },
        { accountCode: "1111", debitAmount: 0, creditAmount: 50000 },
      ],
      context: makeCtx(),
    });
    await app.postJournalEntry({ entryId: draft.id, context: makeCtx() });

    await expect(app.postJournalEntry({
      entryId: draft.id,
      context: makeCtx(),
    })).rejects.toThrow("Only draft entries can be posted");
  });

  it("generates income statement", async () => {
    // Create some posted entries
    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 2 }],
      paymentMethod: "cash",
      amountReceived: 600000,
      idempotencyKey: "pandl-001",
      context: { ...makeCtx(), actor: { type: "staff", id: "op_owner" }, idempotencyKey: "pandl-001" },
    });

    const pnl = await app.getIncomeStatement(TODAY, TODAY);
    expect(pnl.revenue).toBeGreaterThan(0);
    expect(pnl.cogs).toBeGreaterThan(0);
    expect(pnl.grossProfit).toBe(pnl.revenue - pnl.cogs);
  });
});

describe("Inventory Management Flow", () => {
  let app: ReturnType<typeof makeApp>["app"];
  let state: ReturnType<typeof makeApp>["state"];

  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    state = result.state;
  });

  it("manually adjusts stock down (damage)", async () => {
    const result = await app.adjustStock({
      inventoryItemId: "prod_mint",
      locationId: "loc_default",
      adjustment: -3,
      reason: "Hư hỏng khi vận chuyển",
      movementType: "damage",
      context: makeCtx(),
    });

    expect(result.newLevel).toBe(7);
    const product = state.products.find(p => p.id === "prod_mint")!;
    expect(product.variants[0].stockLevel).toBe(7);

    const movements = state.stockMovements;
    const lastMovement = movements[movements.length - 1];
    expect(lastMovement.movementType).toBe("damage");
    expect(lastMovement.quantityChange).toBe(-3);
    expect(lastMovement.reason).toBe("Hư hỏng khi vận chuyển");
  });

  it("rejects stock adjustment below zero", async () => {
    await expect(app.adjustStock({
      inventoryItemId: "prod_mint",
      locationId: "loc_default",
      adjustment: -100,
      reason: "Loss",
      movementType: "manual_adjustment",
      context: makeCtx(),
    })).rejects.toThrow("Stock cannot go below zero");
  });

  it("creates purchase order", async () => {
    const po = await app.createPurchaseOrder({
      supplierName: "Supplier A",
      items: [
        { variantId: "var_mint_20", quantity: 20, unitCost: 150000 },
        { variantId: "var_citrus_20", quantity: 15, unitCost: 130000 },
      ],
      context: makeCtx(),
    });

    expect(po.status).toBe("draft");
    expect(po.items).toHaveLength(2);
    expect(po.supplierName).toBe("Supplier A");
  });

  it("receives purchase order and updates stock", async () => {
    const po = await app.createPurchaseOrder({
      supplierName: "Supplier A",
      items: [{ variantId: "var_mint_20", quantity: 20, unitCost: 150000 }],
      context: makeCtx(),
    });

    const result = await app.receivePurchaseOrder({
      purchaseOrderId: po.id,
      items: [{ purchaseOrderItemId: po.items[0].id, receivedQuantity: 20 }],
      context: makeCtx(),
    });

    expect(result.status).toBe("received");
    const product = state.products.find(p => p.id === "prod_mint")!;
    expect(product.variants[0].stockLevel).toBe(30); // 10 + 20
  });
});

describe("Dashboard", () => {
  it("returns dashboard metrics", async () => {
    const state = createEmptyApplicationState();
    seedState(state);
    const store = new InMemoryStoreAdapter(state);
    const app = createApplication({ store });

    const ctx = { actor: { type: "staff", id: "op_owner" }, correlationId: "cor_test" };
    ctx.correlationId;

    await app.completeSale({
      items: [{ variantId: "var_mint_20", quantity: 2 }],
      paymentMethod: "cash",
      amountReceived: 600000,
      idempotencyKey: "dash-001",
      context: { ...ctx, idempotencyKey: "dash-001" },
    });

    const dashboard = await app.getDashboard(TODAY);
    expect(dashboard.orderCount).toBe(1);
    expect(dashboard.totalRevenue).toBe(500000);
    expect(dashboard.products).toBe(4);
  });
});
