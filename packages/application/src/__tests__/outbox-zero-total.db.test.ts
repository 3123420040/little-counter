import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";

// Keep the real handlers, SQL, journal validation and accounting writes. Only
// transaction ownership and unrelated external/learning effects are substituted.
const harness = vi.hoisted(() => ({
  client: null as PoolClient | null,
  notify: vi.fn(),
  learn: vi.fn(),
  crypto: vi.fn(),
}));
vi.mock("../db/transaction", () => ({
  withConnectedTransaction: async (handler: (client: PoolClient) => Promise<unknown>) => handler(harness.client!),
}));
vi.mock("../services/telegram-notification-router-service", () => ({ routeTelegramNotificationEvent: harness.notify }));
vi.mock("../services/vision-learning-service", () => ({ handleVisionLearningFromSale: harness.learn }));
vi.mock("../services/crypto-treasury-service", () => ({ persistCryptoReceiptEvidenceFromSaleForClient: harness.crypto }));

import { processExactOutboxEvent } from "../services/outbox-processor-service";

let pool: Pool;
let db: PoolClient;
beforeAll(async () => {
  const target = requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  pool = new Pool({ connectionString: target.connectionString });
  db = await pool.connect();
  await assertSafeTestDatabaseSentinel(db, target);
  harness.client = db;
});
beforeEach(async () => {
  vi.clearAllMocks();
  await db.query("BEGIN");
  await db.query(`
    INSERT INTO app.merchants(id,display_name,legacy_organization_id,status)
      VALUES ('pr_m','Synthetic zero accounting','pr_org','active');
    INSERT INTO public.stock_location(id,name) VALUES ('pr_l1','Synthetic zero accounting');
    INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,status)
      VALUES ('pr_s1','pr_m','Synthetic zero accounting','pr_l1','active');
  `);
});
afterEach(async () => { await db.query("ROLLBACK"); });
afterAll(async () => { db?.release(); await pool?.end(); });

function sale(cogs: number) {
  return {
    id: randomUUID(), eventType: "sale.created",
    payload: {
      orderId: "pr_zero_order", merchantId: "pr_m", storeId: "pr_s1",
      total: 0, merchandiseRevenue: 0, shippingRevenue: 0, tax: 0,
      cogs, paymentMethod: "cod", paymentEntryId: null, paymentStatus: null,
    },
  };
}
function correction(cogsDelta: number) {
  return {
    id: randomUUID(), eventType: "order.corrected",
    payload: {
      orderId: "pr_zero_order", correctionId: randomUUID(), merchantId: "pr_m", storeId: "pr_s1",
      totalDelta: 0, beforeTotals: { merchandiseRevenue: 0, shippingRevenue: 0, tax: 0 },
      afterTotals: { merchandiseRevenue: 0, shippingRevenue: 0, tax: 0 }, cogsDelta, paymentMethod: "cod",
    },
  };
}
async function journals() {
  return (await db.query(`
    SELECT je.reference_type, je.reference_id, a.code,
      jl.debit_amount::float8 AS debit, jl.credit_amount::float8 AS credit
    FROM accounting.journal_entries je
    JOIN accounting.journal_lines jl ON jl.journal_entry_id=je.id
    JOIN accounting.accounts a ON a.id=jl.account_id
    WHERE je.merchant_id='pr_m' ORDER BY je.reference_type,a.code
  `)).rows;
}

describe("zero-total outbox accounting in PostgreSQL", () => {
  it("posts one balanced COGS-only sale journal across replay with no fabricated collection", async () => {
    const event = sale(200_000);
    await processExactOutboxEvent(event);
    await processExactOutboxEvent(event);
    expect(await journals()).toEqual([
      { reference_type: "order", reference_id: "pr_zero_order", code: "1561", debit: 0, credit: 200_000 },
      { reference_type: "order", reference_id: "pr_zero_order", code: "6321", debit: 200_000, credit: 0 },
    ]);
    expect(harness.notify).toHaveBeenCalledTimes(2);
    expect(harness.learn).toHaveBeenCalledTimes(2);
  });

  it("completes a known-zero-cost sale and replay without an empty journal or skipping downstream handlers", async () => {
    const event = sale(0);
    await expect(processExactOutboxEvent(event)).resolves.toBeUndefined();
    await expect(processExactOutboxEvent(event)).resolves.toBeUndefined();
    expect(await journals()).toEqual([]);
    expect(harness.crypto).toHaveBeenNthCalledWith(1, db, event.payload, null);
    expect(harness.notify).toHaveBeenCalledTimes(2);
    expect(harness.learn).toHaveBeenCalledTimes(2);
  });

  it.each([100_000, -100_000])("posts a COGS-only correction once for cost delta %s and zero monetary delta", async (delta) => {
    const event = correction(delta);
    await processExactOutboxEvent(event);
    await processExactOutboxEvent(event);
    expect(await journals()).toEqual([
      { reference_type: "order_correction", reference_id: event.payload.correctionId, code: "1561", debit: Math.max(0, -delta), credit: Math.max(0, delta) },
      { reference_type: "order_correction", reference_id: event.payload.correctionId, code: "6321", debit: Math.max(0, delta), credit: Math.max(0, -delta) },
    ]);
    expect(harness.notify).toHaveBeenCalledTimes(2);
  });

  it("completes a correction with no commercial or cost movement without a poison journal", async () => {
    const event = correction(0);
    await processExactOutboxEvent(event);
    await processExactOutboxEvent(event);
    expect(await journals()).toEqual([]);
    expect(harness.notify).toHaveBeenCalledTimes(2);
  });

  it("reverses only actual COGS lines on cancellation and does not duplicate them on replay", async () => {
    await processExactOutboxEvent(sale(200_000));
    const cancelled = {
      id: randomUUID(), eventType: "sale.cancelled",
      payload: { orderId: "pr_zero_order", merchantId: "pr_m", storeId: "pr_s1", total: 0 },
    };
    await processExactOutboxEvent(cancelled);
    await processExactOutboxEvent(cancelled);
    expect(await journals()).toEqual([
      { reference_type: "order", reference_id: "pr_zero_order", code: "1561", debit: 0, credit: 200_000 },
      { reference_type: "order", reference_id: "pr_zero_order", code: "6321", debit: 200_000, credit: 0 },
      { reference_type: "order_cancellation", reference_id: "pr_zero_order", code: "1561", debit: 200_000, credit: 0 },
      { reference_type: "order_cancellation", reference_id: "pr_zero_order", code: "6321", debit: 0, credit: 200_000 },
    ]);
  });

  it("completes cancellation of an all-zero sale without creating refund or empty journals", async () => {
    await processExactOutboxEvent(sale(0));
    const cancelled = {
      id: randomUUID(), eventType: "sale.cancelled",
      payload: { orderId: "pr_zero_order", merchantId: "pr_m", storeId: "pr_s1", total: 0 },
    };
    await processExactOutboxEvent(cancelled);
    await processExactOutboxEvent(cancelled);
    expect(await journals()).toEqual([]);
  });

  it("reverses both sale and correction costs when a corrected free order is cancelled", async () => {
    await processExactOutboxEvent(sale(200_000));
    const adjusted = correction(-100_000);
    await db.query(`
      INSERT INTO app.order_corrections(id,organization_id,order_id,revision,status,reason,
        before_totals,after_totals,total_delta,created_by)
      VALUES ($1,'pr_org','pr_zero_order',1,'applied','Synthetic zero accounting','{}','{}',0,'system')
    `, [adjusted.payload.correctionId]);
    await processExactOutboxEvent(adjusted);
    const cancelled = {
      id: randomUUID(), eventType: "sale.cancelled",
      payload: { orderId: "pr_zero_order", merchantId: "pr_m", storeId: "pr_s1", total: 0 },
    };
    await processExactOutboxEvent(cancelled);
    await processExactOutboxEvent(cancelled);
    const rows = await journals();
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((row) => row.code))).toEqual(new Set(["1561", "6321"]));
    for (const code of ["1561", "6321"]) {
      expect(rows.filter((row) => row.code === code).reduce((sum, row) => sum + row.debit - row.credit, 0)).toBe(0);
    }
    expect(rows.filter((row) => row.reference_type === "order_cancellation")).toHaveLength(4);
  });
});
