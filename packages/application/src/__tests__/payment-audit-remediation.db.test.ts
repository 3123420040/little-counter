import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPlatformClient, shutdownPlatformPool, type PoolClient } from "../db/client";
import { requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { completeSale, getOrder, quoteOrderCancellation, cancelOrder, refundOrder } from "../services/order-service";
import { applyOrderCorrection } from "../services/order-correction-service";
import { startShift, closeShift, getShiftReport } from "../services/shift-service";
import { readCheckoutSettlementPolicy, updateStoreSettlementPolicy } from "../services/store-settlement-policy-service";
import { confirmCorrectionManualBankPaymentWithClientV1 } from "../services/manual-bank-correction-confirmation-service";
import { confirmInitialManualBankPaymentV1 } from "../services/manual-bank-confirmation-service";

const run = `pay_fix_${randomUUID()}`;
const merchantId = "merchant_default";
const actor = { operatorId: "op_owner", role: "owner", organizationId: "org_default" };
const scope = { scopeKind: "operating" as const, merchantId, storeId: run, stockLocationId: `${run}_stock` };
const reportScope = { scopeKind: "report" as const, merchantId, storeIds: [scope.storeId] };
const key = (suffix: string) => ({ "idempotency-key": `${run}:${suffix}` });
const body = { items: [{ variantId: "var_citrus_20", quantity: 3 }], paymentMethod: "bank_transfer" as const, amountReceived: 0, customerMode: "walk_in" as const, salesChannel: "pos_counter" as const };
let client: PoolClient;
let shiftId: string;
const originalFlag = process.env.MANUAL_BANK_CONFIRMATION_ENABLED;
beforeAll(async () => {
  requireSafeTestDatabaseTarget(process.env.DATABASE_URL, process.env);
  process.env.MANUAL_BANK_CONFIRMATION_ENABLED = "true";
  client = await connectPlatformClient();
  const inventory = (await client.query("SELECT inventory_item_id FROM public.product_variant_inventory_item WHERE variant_id='var_citrus_20' AND deleted_at IS NULL LIMIT 1")).rows[0];
  if (!inventory) throw new Error("Seeded var_citrus_20 required for literal VND690000 regression");
  await client.query("INSERT INTO public.stock_location(id,name) VALUES($1,'Payment remediation fixture')", [scope.stockLocationId]);
  await client.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,is_primary,status) VALUES($1,$2,'Payment remediation fixture',$3,false,'active')", [scope.storeId, merchantId, scope.stockLocationId]);
  await client.query("INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity,incoming_quantity) VALUES($1,$2,$3,100,0,0)", [`${run}_level`, inventory.inventory_item_id, scope.stockLocationId]);
  shiftId = (await startShift(key("start"), { openingCashAmount: { currencyCode: "vnd", amountVnd: "0" } }, actor, scope)).response.data.id;
});
afterAll(async () => {
  if (originalFlag === undefined) delete process.env.MANUAL_BANK_CONFIRMATION_ENABLED;
  else process.env.MANUAL_BANK_CONFIRMATION_ENABLED = originalFlag;
  client?.release();
  await shutdownPlatformPool();
});
async function cancel(orderId: string, suffix: string) {
  const quote = (await quoteOrderCancellation(orderId, scope, actor)).quote;
  return cancelOrder(key(suffix), orderId, { reason: "Payment remediation regression", quoteId: quote.quoteId, effectiveRevision: quote.effectiveRevision, quoteGeneratedAt: quote.generatedAt }, actor, scope);
}
const report = async () => (await getShiftReport(shiftId, reportScope)).data;

describe("payment audit regressions via public application services", () => {
  it("blocks new correction collection after cancel while replaying a committed correction receipt", async () => {
    for (const confirmed of [false, true]) {
      const suffix = `correction-cancel-${confirmed}`;
      const sale = (await completeSale(key(suffix), body, actor, scope)).response.data;
      await applyOrderCorrection(key(`${suffix}-change`), sale.orderId, {
        baseRevision: 0, reason: "Additional unpaid item correction", items: [{ variantId: "var_citrus_20", quantity: 4 }],
        settlement: { method: "bank_transfer", amountReceived: 230000 },
      }, actor, scope);
      const evidence = { sourceReference: `${run}:${suffix}`, confirmedAt: new Date().toISOString() };
      const confirm = () => confirmCorrectionManualBankPaymentWithClientV1(client, key(`${suffix}-confirm`), sale.orderId, evidence, actor, scope);
      const receipt = confirmed ? await confirm() : undefined;
      await cancel(sale.orderId, `${suffix}-cancel`);
      if (confirmed) expect((await confirm()).response).toEqual({ ...receipt!.response, data: { ...receipt!.response.data, outcome: "replayed" } });
      else await expect(confirm()).rejects.toMatchObject({ code: "invalid_state_transition" });
    }
  });

  it("serializes manual-bank collection against cancellation without losing refundable money", async () => {
    const sale = (await completeSale(key("collection-race"), body, actor, scope)).response.data;
    const q = (await quoteOrderCancellation(sale.orderId, scope, actor)).quote;
    const cancellation = { reason: "Cancellation collection race", quoteId: q.quoteId,
      effectiveRevision: q.effectiveRevision, quoteGeneratedAt: q.generatedAt };
    const results = await Promise.allSettled([
      cancelOrder(key("collection-race-cancel"), sale.orderId, cancellation, actor, scope),
      confirmInitialManualBankPaymentV1(key("collection-race-confirm"), sale.orderId,
        { sourceReference: `${run}:race-bank`, confirmedAt: new Date().toISOString() }, actor, scope),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const current = (await getOrder(sale.orderId, reportScope)).order;
    if (current.status === "canceled") {
      expect(results[1].status).toBe("rejected");
    } else {
      expect(results[0].status).toBe("rejected");
      await cancel(sale.orderId, "collection-race-current-quote");
      const payable = await client.query("SELECT sum(amount_minor)::int AS n FROM app.customer_refund_payables WHERE order_id=$1", [sale.orderId]);
      expect(payable.rows[0].n).toBe(690000);
    }
  });

  it("rejects a new manual-bank collection after cancellation instead of losing refund payable", async () => {
    const sale = (await completeSale(key("cancel-before-collection"), body, actor, scope)).response.data;
    await cancel(sale.orderId, "cancel-before-collection-apply");
    await expect(confirmInitialManualBankPaymentV1(key("cancel-before-collection-confirm"), sale.orderId,
      { sourceReference: `${run}:canceled-bank`, confirmedAt: new Date().toISOString() }, actor, scope)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects new manual bookings when disabled, exposes capability, and replays committed sales", async () => {
    const sale = await completeSale(key("capability"), body, actor, scope);
    expect(sale.response.data.total).toBe(690000);
    process.env.MANUAL_BANK_CONFIRMATION_ENABLED = "false";
    try {
      expect((await readCheckoutSettlementPolicy(merchantId, scope.storeId)).data.manualConfirmationEnabled).toBe(false);
      await expect(completeSale(key("disabled-new"), body, actor, scope)).rejects.toMatchObject({ code: "manual_bank_confirmation_disabled" });
      const replay = await completeSale(key("capability"), body, actor, scope);
      expect(replay.statusCode).toBe(200);
      expect(replay.response.data.orderId).toBe(sale.response.data.orderId);
      const detail = (await getOrder(sale.response.data.orderId, reportScope)).order;
      expect(detail.manualBankConfirmationEnabled).toBe(false);
    } finally { process.env.MANUAL_BANK_CONFIRMATION_ENABLED = "true"; }
    await cancel(sale.response.data.orderId, "capability-cancel");
  });
  it("removes canceled unpaid receivables instead of retaining immutable positive obligations", async () => {
    const sale = (await completeSale(key("unpaid"), body, actor, scope)).response.data;
    expect((await report()).outstandingObligations).toEqual([{ currencyCode: "VND", minorUnitExponent: 0, remainingAmountMinor: 690000, obligationCount: 1 }]);
    await cancel(sale.orderId, "cancel-unpaid");
    const result = await report();
    expect(result.outstandingObligations).toEqual([]);
    expect(result.orders.find((o: { id: string }) => o.id === sale.orderId).total).toBe(0);
  });
  it("uses a negative commercial correction to reduce an unpaid receivable", async () => {
    const sale = (await completeSale(key("negative-unpaid"), body, actor, scope)).response.data;
    await applyOrderCorrection(key("negative-unpaid-correction"), sale.orderId, {
      baseRevision: 0, reason: "Reduce unpaid order by one item", items: [{ variantId: "var_citrus_20", quantity: 2 }],
      settlement: { method: "bank_transfer", amountReceived: 230000 },
    }, actor, scope);
    expect((await report()).outstandingObligations[0].remainingAmountMinor).toBe(460000);
    await cancel(sale.orderId, "negative-unpaid-cancel");
    expect((await report()).outstandingObligations).toEqual([]);
  });
  it("resolves confirmed receipt rows while preserving the initial raw pending mirror", async () => {
    const priorPayables = (await report()).outstandingRefundPayables;
    const priorAmount = priorPayables[0]?.remainingAmountMinor || 0;
    const priorCount = priorPayables[0]?.payableCount || 0;
    const sale = (await completeSale(key("later"), body, actor, scope)).response.data;
    await confirmInitialManualBankPaymentV1(key("later-confirm"), sale.orderId, { sourceReference: `${run}:bank`, confirmedAt: new Date().toISOString() }, actor, scope);
    const detail = (await getOrder(sale.orderId, reportScope)).order;
    expect(detail.paymentStatus).toBe("posted");
    expect(detail.paymentEntries).toHaveLength(1);
    expect(detail.paymentEntries[0]).toMatchObject({ status: "pending", effectiveStatus: "posted", collectedAmountMinor: 690000, remainingAmountMinor: 0 });
    await cancel(sale.orderId, "cancel-paid");
    expect((await report()).outstandingObligations).toEqual([]);
    expect((await report()).outstandingRefundPayables).toEqual([{ currencyCode: "VND", minorUnitExponent: 0, remainingAmountMinor: priorAmount + 690000, payableCount: priorCount + 1 }]);
  });
  it("keeps paid negative corrections as payables and reduces them only by actual payout", async () => {
    const before = (await report()).outstandingRefundPayables[0].remainingAmountMinor;
    const sale = (await completeSale(key("negative-paid"), body, actor, scope)).response.data;
    await confirmInitialManualBankPaymentV1(key("negative-paid-confirm"), sale.orderId,
      { sourceReference: `${run}:negative-paid-bank`, confirmedAt: new Date().toISOString() }, actor, scope);
    await applyOrderCorrection(key("negative-paid-correction"), sale.orderId, {
      baseRevision: 0, reason: "Reduce paid order by one item", items: [{ variantId: "var_citrus_20", quantity: 2 }],
      settlement: { method: "bank_transfer", amountReceived: 230000 },
    }, actor, scope);
    expect((await report()).outstandingObligations).toEqual([]);
    expect((await report()).outstandingRefundPayables[0].remainingAmountMinor).toBe(before + 230000);
    await refundOrder(key("partial-refund"), sale.orderId, { amount: 100000, method: "bank_transfer",
      sourceReference: `${run}:partial-payout`, paidAt: new Date().toISOString(), reason: "First partial payout",
      confirmationToken: String(sale.orderNumber) }, { ...actor, role: "owner", displayName: "Remediation owner", channel: "telegram", channelUserId: run, serviceIdentity: "payment_remediation", permissions: ["order:refund"] }, { merchantId, storeId: scope.storeId });
    expect((await report()).outstandingRefundPayables[0].remainingAmountMinor).toBe(before + 130000);
    expect((await report()).outstandingObligations).toEqual([]);
  });
  it("does not resolve a partially allocated receipt as fully posted", async () => {
    const sale = (await completeSale(key("partial-collection"), body, actor, scope)).response.data;
    const obligation = (await client.query("SELECT * FROM app.commercial_obligations WHERE order_id=$1", [sale.orderId])).rows[0];
    const eventId = randomUUID();
    await client.query("BEGIN");
    try {
      await client.query(`INSERT INTO app.payment_events(id,merchant_id,store_id,order_id,commercial_revision_id,kind,status,method,evidence_type,evidence_fingerprint,currency_code,minor_unit_exponent,amount_minor,idempotency_key,source_type,source_id,source_occurred_at)
        VALUES($1::uuid,$2,$3,$4,$5,'charge','posted','manual_bank','manual_verified',$6,'VND',0,230000,$1::text,'synthetic_audit',$1::text,now())`,
        [eventId, merchantId, scope.storeId, sale.orderId, obligation.commercial_revision_id, "a".repeat(64)]);
      await client.query(`INSERT INTO app.payment_event_evidence(payment_event_id,merchant_id,store_id,evidence_type,source_system,source_reference,verification_status,evidence_fingerprint,source_occurred_at)
        VALUES($1::uuid,$2,$3,'manual_verified','synthetic_audit',$1::text,'verified',$4,now())`, [eventId, merchantId, scope.storeId, "a".repeat(64)]);
      await client.query(`INSERT INTO app.payment_event_allocations(merchant_id,store_id,obligation_id,payment_event_id,allocation_kind,currency_code,minor_unit_exponent,amount_minor,idempotency_key,allocated_at)
        VALUES($1,$2,$3,$4::uuid,'collection','VND',0,230000,$4::text,now())`, [merchantId, scope.storeId, obligation.id, eventId]);
      await client.query(`INSERT INTO app.payment_event_component_allocations(payment_event_id,commercial_revision_id,merchant_id,store_id,currency_code,minor_unit_exponent,tax_mode,merchandise_gross_minor,discount_minor,merchandise_net_minor,shipping_minor,merchandise_vat_minor,shipping_vat_minor,vat_minor,unclassified_minor,total_minor)
        VALUES($1,$2,$3,$4,'VND',0,'exclusive',230000,0,230000,0,0,0,0,0,230000)`, [eventId, obligation.commercial_revision_id, merchantId, scope.storeId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    const detail = (await getOrder(sale.orderId, reportScope)).order;
    expect(detail.paymentEntries[0]).toMatchObject({ status: "pending", effectiveStatus: "partially_collected", collectedAmountMinor: 230000, remainingAmountMinor: 460000 });
    expect((await report()).outstandingObligations[0].remainingAmountMinor).toBe(460000);
  });
  it("allows confirm-on-booking independently of manual capability and freezes closed financial values", async () => {
    await updateStoreSettlementPolicy(scope.storeId, { mode: "confirm_on_booking", expectedVersion: 0 }, actor, { scopeKind: "merchant_target", merchantId });
    process.env.MANUAL_BANK_CONFIRMATION_ENABLED = "false";
    const sale = (await completeSale(key("booking"), { ...body, bankTransferSettlementAcknowledgment: { policyVersion: 1, acknowledgmentVersion: 1 } }, actor, scope)).response.data;
    expect(sale.paymentStatus).toBe("posted");
    const closed = (await closeShift(key("close"), { countedCashAmount: { currencyCode: "vnd", amountVnd: "0" }, checklist: [] }, actor, scope, shiftId)).response.data;
    await cancel(sale.orderId, "after-close-cancel");
    const reread = await report();
    expect(reread.orders).toEqual(closed.orders);
    expect(reread.outstandingRefundPayables).toEqual(closed.outstandingRefundPayables);
    expect(reread.paymentSummary).toEqual(closed.paymentSummary);
    expect(reread.postCloseFinancialAdjustments).toEqual(expect.arrayContaining([expect.objectContaining({ orderId: sale.orderId, kind: "commercial_revision" })]));
  });
});
