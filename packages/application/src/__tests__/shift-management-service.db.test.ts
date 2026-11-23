import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import type { OperatorContext } from "../services/auth-service";
import { completeSale } from "../services/order-service";
import {
  closeShift,
  getMyShiftReport,
  getShiftReport,
  listMyShifts,
  recordShiftCashMovement,
  recordShiftStockCount,
  startShift,
  updateShiftPolicy,
} from "../services/shift-service";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const variantId = "var_mint_20";
const storeId = `store_shift_${runId}`;
const stockLocationId = `sloc_shift_${runId}`;
const actor: OperatorContext = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "DB Test Owner",
  organizationId: "org_default",
};
const staffActor: OperatorContext = {
  operatorId: "op_staff_self",
  role: "staff",
  displayName: "DB Test Staff",
  organizationId: "org_default",
};
const scope = {
  scopeKind: "operating" as const,
  merchantId: "merchant_default",
  storeId,
  stockLocationId,
};
const reportScope = {
  scopeKind: "report" as const,
  merchantId: scope.merchantId,
  storeIds: [scope.storeId],
};

let client: PoolClient;
let inventoryItemId = "";

async function applyShiftMigration(): Promise<void> {
  const sql = await readFile("db/migrations/025_shift_management.sql", "utf8");
  await client.query(sql);
}

async function stockForItem(): Promise<number> {
  const row = await queryOne<{ stock: string }>(client, `
    SELECT COALESCE(stocked_quantity, 0)::numeric AS stock
    FROM public.inventory_level
    WHERE inventory_item_id = $1
      AND location_id = $2
      AND deleted_at IS NULL
    LIMIT 1
  `, [inventoryItemId, stockLocationId]);
  return Number(row?.stock || 0);
}

const originalManualBankFlag = process.env.MANUAL_BANK_CONFIRMATION_ENABLED;
beforeAll(async () => {
  // These fixtures deliberately exercise the available manual-confirmation rail.
  process.env.MANUAL_BANK_CONFIRMATION_ENABLED = "true";
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await applyShiftMigration();
  const item = await queryOne<{ inventory_item_id: string }>(client, `
    SELECT inventory_item_id
    FROM public.product_variant_inventory_item
    WHERE variant_id = $1
      AND deleted_at IS NULL
    LIMIT 1
  `, [variantId]);
  if (!item) throw new Error("variant inventory item missing");
  inventoryItemId = item.inventory_item_id;
  await client.query(`
    INSERT INTO public.stock_location (id, name)
    VALUES ($1, $2)
    ON CONFLICT (id) DO NOTHING
  `, [stockLocationId, `Shift Test Location ${runId}`]);
  await client.query(`
    INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status)
    VALUES ($1, $2, $3, $4, false, 'active')
    ON CONFLICT (id) DO NOTHING
  `, [storeId, scope.merchantId, `Shift Test Store ${runId}`, stockLocationId]);
  await client.query(`
    INSERT INTO public.inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, incoming_quantity)
    VALUES ($1, $2, $3, 20, 0, 0)
    ON CONFLICT (inventory_item_id, location_id) WHERE deleted_at IS NULL
    DO UPDATE SET stocked_quantity = 20, updated_at = now()
  `, [`ilev_shift_${runId}`, inventoryItemId, stockLocationId]);
});

afterAll(async () => {
  if (originalManualBankFlag === undefined) delete process.env.MANUAL_BANK_CONFIRMATION_ENABLED;
  else process.env.MANUAL_BANK_CONFIRMATION_ENABLED = originalManualBankFlag;
  await client?.query("DELETE FROM app.shift_events WHERE store_id = $1", [storeId]).catch(() => undefined);
  await client?.query("DELETE FROM app.shift_handover_acknowledgements WHERE store_id = $1", [storeId]).catch(() => undefined);
  await client?.query("DELETE FROM app.shift_stock_counts WHERE store_id = $1", [storeId]).catch(() => undefined);
  await client?.query("DELETE FROM app.shift_cash_movements WHERE store_id = $1", [storeId]).catch(() => undefined);
  await client?.query("DELETE FROM app.work_shifts WHERE store_id = $1", [storeId]).catch(() => undefined);
  await client?.query("DELETE FROM app.shift_policies WHERE store_id = $1", [storeId]).catch(() => undefined);
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("shift management PostgreSQL service integration", () => {
  it("attributes POS sale to an open shift and closes with operational evidence only", async () => {
    await updateShiftPolicy({ "idempotency-key": `db-test:${runId}:policy` }, {
      enabled: true,
      enforceShiftOnPos: true,
      cashDiscrepancyAlertThreshold: { currencyCode: "vnd", amountVnd: "1" },
      stockDiscrepancyAlertThreshold: 1,
    }, actor, scope);

    const opened = await startShift({ "idempotency-key": `db-test:${runId}:open` }, {
      openingCashAmount: { currencyCode: "vnd", amountVnd: "100000" },
      openingNote: "open for DB test",
    }, actor, scope);
    const shift = opened.response.data;
    expect(opened.statusCode).toBe(201);
    expect(shift.status).toBe("open");

    const sale = await completeSale({ "idempotency-key": `db-test:${runId}:sale` }, {
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "cash",
      amountReceived: 1000000,
      notes: `shift sale ${runId}`,
    }, actor, scope);
    const order = sale.response.data;
    expect(order.shiftId).toBe(shift.id);
    expect(order.shiftAttribution).toBe("online_open_shift");

    const orderRow = await queryOne<{ metadata: Record<string, unknown> }>(client, `
      SELECT metadata
      FROM public."order"
      WHERE id = $1
    `, [order.id]);
    expect(orderRow?.metadata).toMatchObject({
      shiftId: shift.id,
      shiftAttribution: "online_open_shift",
    });

    const pendingBankSale = await completeSale({ "idempotency-key": `db-test:${runId}:pending-bank` }, {
      items: [{ variantId, quantity: 1 }],
      paymentMethod: "bank_transfer",
      amountReceived: 0,
      notes: `pending bank shift sale ${runId}`,
    }, actor, scope);
    expect(pendingBankSale.response.data.paymentStatus).toBe("pending");
    const pendingBankEvent = await queryOne<{ amount_minor: string }>(client, `
      SELECT amount_minor::text
      FROM app.payment_events
      WHERE order_id = $1 AND status = 'pending' AND method = 'manual_bank'
      LIMIT 1
    `, [pendingBankSale.response.data.orderId]);
    expect(Number(pendingBankEvent?.amount_minor)).toBeGreaterThan(0);

    await recordShiftCashMovement({ "idempotency-key": `db-test:${runId}:cash` }, {
      type: "pay_out",
      amount: { currencyCode: "vnd", amountVnd: "20000" },
      reason: "petty cash test",
    }, actor, scope);

    const stockBeforeCount = await stockForItem();
    const counts = await recordShiftStockCount({ "idempotency-key": `db-test:${runId}:count` }, {
      countType: "quick",
      items: [{ inventoryItemId, countedQuantity: stockBeforeCount + 1, reason: "test count" }],
    }, actor, scope);
    expect(counts.response.data[0]).toMatchObject({
      inventoryItemId,
      countedQuantity: stockBeforeCount + 1,
      discrepancyQuantity: 1,
    });
    await expect(stockForItem()).resolves.toBe(stockBeforeCount);

    const preview = await getShiftReport(shift.id, reportScope);
    expect(preview.data.paymentSummary.manual_bank).toBeUndefined();
    expect(preview.data.outstandingObligations).toContainEqual(expect.objectContaining({
      currencyCode: "VND",
      remainingAmountMinor: Number(pendingBankEvent?.amount_minor),
      obligationCount: 1,
    }));
    const expectedCash = Number(preview.data.cashExpected);
    const closed = await closeShift({ "idempotency-key": `db-test:${runId}:close` }, {
      countedCashAmount: { currencyCode: "vnd", amountVnd: String(expectedCash + 1000) },
      discrepancyReason: "intentional DB test variance",
      outgoingHandoverNote: "handover note",
    }, actor, scope);

    expect(closed.response.data.shift).toMatchObject({
      id: shift.id,
      status: "closed",
      cashVarianceAmount: 1000,
    });
    expect(closed.response.data.orderIds).toContain(order.id);
    expect(closed.response.data.paymentSummary.cash.charges).toBeGreaterThan(0);
    expect(closed.response.data.stockCounts[0]).toMatchObject({ discrepancyQuantity: 1 });

    const accountingRows = await client.query(`
      SELECT id
      FROM accounting.journal_entries
      WHERE reference_type LIKE 'shift%'
        AND store_id = $1
    `, [storeId]);
    expect(accountingRows.rowCount).toBe(0);

    const alert = await queryOne<{ id: string }>(client, `
      SELECT id::text
      FROM outbox.events
      WHERE aggregate_type = 'shift'
        AND aggregate_id = $1
        AND event_type = 'shift.discrepancy_alert'
      LIMIT 1
    `, [shift.id]);
    expect(alert?.id).toBeTruthy();
  });

  it("limits self shift history and report detail to the opening operator", async () => {
    const opened = await startShift({ "idempotency-key": `db-test:${runId}:self-open` }, {
      openingCashAmount: { currencyCode: "vnd", amountVnd: "0" },
      openingNote: "staff self history test",
    }, staffActor, scope);
    const shift = opened.response.data;

    await closeShift({ "idempotency-key": `db-test:${runId}:self-close` }, {
      countedCashAmount: { currencyCode: "vnd", amountVnd: "0" },
      outgoingHandoverNote: "staff handover",
    }, staffActor, scope);

    const staffHistory = await listMyShifts(staffActor, reportScope, { limit: 10 });
    expect(staffHistory.data.some((row) => row.id === shift.id)).toBe(true);

    const ownerHistory = await listMyShifts(actor, reportScope, { limit: 10 });
    expect(ownerHistory.data.some((row) => row.id === shift.id)).toBe(false);

    await expect(getMyShiftReport(shift.id, staffActor, reportScope)).resolves.toMatchObject({
      data: {
        shift: {
          id: shift.id,
          openedBy: staffActor.operatorId,
        },
      },
    });
    await expect(getMyShiftReport(shift.id, actor, reportScope)).rejects.toMatchObject({
      code: "resource_not_found",
    });
  });
});
