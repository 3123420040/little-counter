import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DASHBOARD_METRIC_TIME_BASIS_V2 } from "@medusa-snus/contracts";
import { connectPlatformClient, shutdownPlatformPool, type PoolClient } from "../db/client";
import { assertSafeTestDatabaseSentinel, requireSafeTestDatabaseTarget } from "../db/test-database-target";
import { ensurePlatformSchema } from "../db/schema";
import { openCustomerRefundPayableV1, recordCustomerRefundPayoutV1 } from "../services/customer-refund-payable-service";
import { appendCancellationCommercialRevisionV1 } from "../services/cancellation-commercial-revision-service";
import { readDashboardFeeJournalSliceV1 } from "../services/dashboard-fee-journal-slice";
import { insertJournalEntryForClient } from "../services/accounting-service";
import { readFrozenRefundAllocationV2 } from "../services/refund-component-allocation";
import { readDashboardFeeNegativeSliceV1 } from "../services/dashboard-fee-negative-slice";
import { recordAuditEntry } from "../repositories/audit-repository";
import { calculateOrderTotalsV2 } from "../services/order-total-service";
import { recordOriginalOrderCommercialRevisionFromOrderCreateV2 } from "../services/original-order-commercial-revision-caller";
import { recordProviderInitialPostedChargeFromLockedStateV1 } from "../services/provider-initial-posted-charge-caller";
import { readDashboardRecordedCollectionSliceV1, readDashboardRecordedCollectionSliceV2 } from "../services/dashboard-recorded-collection-slice";
import { readDashboardCommercialSliceV2 } from "../services/dashboard-commercial-slice";
import { readCreatorSalesDashboardV3 } from "../services/creator-sales-dashboard-v2-service";
import { getDashboard } from "../services/dashboard-service";
import { resolveDashboardStoreWindows } from "../services/dashboard-report-foundation";
let db: PoolClient;
beforeAll(async () => {
  db = await connectPlatformClient();
  await assertSafeTestDatabaseSentinel(db, requireSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL));
  await ensurePlatformSchema();
});
afterAll(async () => { db?.release(); await shutdownPlatformPool(); });
describe("canonical fee collection event day", () => {
  it("separates yesterday's order from today's actual provider settlement and retains creator/asOf scope", async () => {
    await db.query("BEGIN");
    let fixtureTransactionOpen = true;
    try {
      const id = `fee-event-${randomUUID()}`, merchantId = `${id}:merchant`, storeId = `${id}:store`, orderId = `${id}:order`;
      const configId = randomUUID(), intentId = randomUUID(), providerEventId = `${id}:provider`, creatorId = `${id}:creator`;
      const createdAt = "2026-10-26T00:00:00.000Z", settledAt = "2026-10-27T00:00:00.000Z";
      await db.query("INSERT INTO app.merchants(id,display_name,legacy_organization_id) VALUES($1,'Synthetic fee event',$1)", [merchantId]);
      await db.query("INSERT INTO public.stock_location(id,name) VALUES($1,'Synthetic fee event')", [storeId]);
      await db.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id,is_primary) VALUES($1,$2,'Synthetic fee event',$1,true)", [storeId, merchantId]);
      await db.query(`INSERT INTO public."order"(id,currency_code,merchant_id,store_id,created_at) VALUES($1,'vnd',$2,$3,$4)`, [orderId, merchantId, storeId, createdAt]);
      const context = { taxMode: "inclusive" as const, vatRatePpm: 100000 };
      const totals = calculateOrderTotalsV2(1000, { discountPercent: 10, paymentFeeType: "percent", paymentFeeValue: 10 }, 100, context);
      const dependencies = { client: db, config: { enabled: true }, transactionContext: { ownership: "caller" as const, orderCreatedInCurrentTransaction: true as const },
        repositoryOptions: { statementTimeoutMs: 10000, lockTimeoutMs: 1000 } };
      const original = await recordOriginalOrderCommercialRevisionFromOrderCreateV2(dependencies, { merchantId, storeId, orderId, orderCreatedAt: createdAt,
        currencyCode: "VND", minorUnitExponent: 0, commercialContext: context, totals,
        lines: [{ orderLineItemId: `${id}:line`, productId: `${id}:product`, variantId: `${id}:variant`, skuSnapshot: "FEE-EVENT", titleSnapshot: "Synthetic fee event",
          quantity: 1, unitPriceMinor: 1000, unitCostMinor: 50, costEvidenceSource: "inventory.product_settings", costEvidenceUpdatedAt: createdAt }] });
      await recordAuditEntry(db, { operatorId: creatorId, role: "manager", organizationId: merchantId }, "order.created", "order", orderId, { merchantId, storeId });
      await db.query(`INSERT INTO app.payment_intents(id,merchant_id,store_id,provider,status,amount,currency_code,order_input,reference_code,expires_at,metadata,created_by,business_purpose,provider_config_purpose,provider_config_id)
        VALUES($1,$2,$3,'sepay_va','paid',1090,'vnd','{}',$1,now()+interval '1 hour',$4,$5,'retail_order','merchant_retail',$6)`,
        [intentId, merchantId, storeId, JSON.stringify({ provider: { providerConfigPurpose: "merchant_retail", providerConfigId: configId } }), creatorId, configId]);
      const verification = { authenticated: true, signatureAlgorithm: "hmac-sha256", signedPayloadSha256: "b".repeat(64), rawBodyPreserved: true,
        providerConfigPurpose: "merchant_retail", providerConfigId: configId };
      await db.query(`INSERT INTO app.payment_provider_events(merchant_id,store_id,provider,provider_event_id,payment_intent_id,event_type,amount,currency_code,status,payload)
        VALUES($1,$2,'sepay_va',$3,$4,'fixture.provider.success',1090,'vnd','received',$5)`,
        [merchantId, storeId, providerEventId, intentId, JSON.stringify({ _verification: verification, _normalized: { providerOccurredAt: settledAt, direction: "in" } })]);
      const input = { paymentIntentId: intentId, orderId, provider: "sepay_va" as const, providerEventId };
      const charge = await recordProviderInitialPostedChargeFromLockedStateV1(dependencies, input);
      expect(charge).toMatchObject({ kind: "recorded", status: "posted", amountMinor: 1090 });
      expect(await recordProviderInitialPostedChargeFromLockedStateV1(dependencies, input)).toEqual({ ...charge, outcome: "replayed" });
      const scope = { scopeKind: "report" as const, merchantId, storeIds: [storeId] };
      async function report(date: string, asOf = new Date(Date.now() + 60000).toISOString()) {
        const range = { from: date, to: date, inclusiveDays: 1 };
        return { normalizedScope: scope, localDateRange: range, storeTimeWindows: await resolveDashboardStoreWindows(db, scope, range),
          reportAsOf: asOf, metricTimeBasis: { ...DASHBOARD_METRIC_TIME_BASIS_V2 } };
      }
      const today = await report("2026-10-27"), yesterday = await report("2026-10-26");
      const collected = await readDashboardRecordedCollectionSliceV2(db, today, { enabled: true });
      expect(collected).toMatchObject({ enabled: true, data: { schemaVersion: 2, currencies: [{ recordedGrossCollectionsMinor: 1090, postedChargeEventCount: 1,
        components: { paymentFeeMinor: 90, paymentFeeVatMinor: 8, paymentFeeVatIncludedInPriceMinor: 8, paymentFeeVatAddedToPriceMinor: 0, totalMinor: 1090 } }] } });
      expect(await readDashboardRecordedCollectionSliceV2(db, yesterday, { enabled: true })).toMatchObject({ enabled: true, data: { currencies: [] } });
      expect((await readDashboardCommercialSliceV2(db, today)).currencies.find(row => row.currencyCode === "VND")).toMatchObject({ validOrderCount: 0, currentOrderGrossValueMinor: 0 });
      expect((await readDashboardCommercialSliceV2(db, yesterday)).currencies.find(row => row.currencyCode === "VND")).toMatchObject({ validOrderCount: 1, currentOrderGrossValueMinor: 1090 });
      expect(await readDashboardRecordedCollectionSliceV2(db, today, { enabled: true }, { mode: "selected", creatorOperatorIds: [creatorId] })).toEqual(collected);
      expect(await readDashboardRecordedCollectionSliceV2(db, today, { enabled: true }, { mode: "selected", creatorOperatorIds: ["foreign-creator"] })).toMatchObject({ enabled: true, data: { currencies: [] } });
      expect(await readDashboardRecordedCollectionSliceV2(db, await report("2026-10-27", "2026-10-26T23:59:00.000Z"), { enabled: true })).toMatchObject({ enabled: true, data: { currencies: [] } });
      await expect(readDashboardRecordedCollectionSliceV1(db, today, { enabled: true })).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
      async function journal(referenceType: string, referenceId: string, lines: Array<{ accountCode: string; debitAmount: number; creditAmount: number }>) {
        return insertJournalEntryForClient(db, { entryDate: "2026-10-27", referenceType, referenceId, description: "Synthetic canonical fee evidence",
          status: "posted", createdBy: creatorId, merchantId, storeId, lines });
      }
      await journal("order", orderId, [
        { accountCode: "1111", debitAmount: 1090, creditAmount: 0 }, { accountCode: "5111", debitAmount: 0, creditAmount: 818 },
        { accountCode: "5112", debitAmount: 0, creditAmount: 91 }, { accountCode: "5113", debitAmount: 0, creditAmount: 82 },
        { accountCode: "3331", debitAmount: 0, creditAmount: 99 }, { accountCode: "6321", debitAmount: 50, creditAmount: 0 },
        { accountCode: "1561", debitAmount: 0, creditAmount: 50 },
      ]);
      expect(await readDashboardFeeJournalSliceV1(db, yesterday)).toMatchObject({ currencies: [{ revenueExcludingVatMinor: 82,
        coverage: { status: "available", coveredJournalCount: 1, totalJournalCount: 1 } }] });
      expect(await readDashboardFeeJournalSliceV1(db, today)).toMatchObject({ currencies: [{ revenueExcludingVatMinor: 0, coverage: { totalJournalCount: 0 } }] });
      if (!original.enabled) throw new Error("Original writer must be enabled");
      const refundScope = { merchantId, storeId, orderId };
      await openCustomerRefundPayableV1(db, { ...refundScope, commercialRevisionId: original.revisionId, kind: "manual_refund", amountMinor: 545,
        sourceType: "fixture_manual_refund", sourceId: `${id}:manual`, sourceOccurredAt: "2026-10-27T01:00:00.000Z" });
      const payoutInput = { ...refundScope, amountMinor: 545, method: "cash" as const, operatorId: creatorId, reason: "Synthetic partial refund",
        sourceType: "fixture_refund_payout", sourceId: `${id}:manual-payout`, sourceOccurredAt: "2026-10-27T01:00:00.000Z" };
      const refunded = await recordCustomerRefundPayoutV1(db, payoutInput);
      expect(await recordCustomerRefundPayoutV1(db, payoutInput)).toEqual({ ...refunded, outcome: "replayed" });
      expect(await readDashboardFeeNegativeSliceV1(db, today, { enabled: true })).toMatchObject({ enabled: true, data: { currencies: [{
        feeRevenueReversedExVatMinor: 41, verifiedSubsetSettlementOnlyMinor: 0, coverage: { status: "available", totalEventCount: 1, totalNegativeMinor: 545 } }] } });
      const frozenRow = await db.query("SELECT metadata FROM app.payment_events WHERE id=$1", [refunded.paymentEventId]);
      const allocation = readFrozenRefundAllocationV2(frozenRow.rows[0]!.metadata.refundAllocationV2), reversed = allocation.reversalComponents;
      const refundEntryId = randomUUID();
      await db.query(`INSERT INTO app.payment_entries(id,merchant_id,store_id,order_id,direction,method,amount,currency_code,status,created_by,metadata)
        VALUES($1,$2,$3,$4,'refund','cash',545,'vnd','posted',$5,$6)`,
        [refundEntryId, merchantId, storeId, orderId, creatorId, JSON.stringify({ canonicalPaymentEventId: refunded.paymentEventId })]);
      await journal("refund", refundEntryId, [
        { accountCode: "5111", debitAmount: reversed.merchandiseRevenueMinor, creditAmount: 0 },
        { accountCode: "5112", debitAmount: reversed.shippingRevenueMinor, creditAmount: 0 },
        { accountCode: "5113", debitAmount: reversed.paymentFeeRevenueMinor, creditAmount: 0 },
        { accountCode: "3331", debitAmount: reversed.vatMinor, creditAmount: 0 }, { accountCode: "1111", debitAmount: 0, creditAmount: 545 },
      ]);
      expect(await readDashboardFeeJournalSliceV1(db, today)).toMatchObject({ currencies: [{ revenueExcludingVatMinor: -41,
        coverage: { status: "available", coveredJournalCount: 1, totalJournalCount: 1 } }] });
      const cancellationId = randomUUID();
      const cancelled = await appendCancellationCommercialRevisionV1(db, { ...refundScope, sourceId: cancellationId,
        sourceOccurredAt: "2026-10-27T02:00:00.000Z", reason: "Synthetic cancellation after partial refund" });
      await openCustomerRefundPayableV1(db, { ...refundScope, commercialRevisionId: cancelled.revisionId, kind: "order_cancellation", amountMinor: 545,
        sourceType: "order_cancellation", sourceId: cancellationId, sourceOccurredAt: "2026-10-27T02:00:00.000Z" });
      await recordCustomerRefundPayoutV1(db, { ...payoutInput, sourceId: `${id}:cancel-payout`, sourceOccurredAt: "2026-10-27T02:00:00.000Z" });
      expect(await readDashboardFeeNegativeSliceV1(db, today, { enabled: true })).toMatchObject({ enabled: true, data: { currencies: [{
        feeRevenueReversedExVatMinor: 41, verifiedSubsetSettlementOnlyMinor: 545, coverage: { status: "available", totalEventCount: 2,
          coveredEventCount: 2, excludedEventCount: 0, totalNegativeMinor: 1090 } }] } });
      expect(await readDashboardFeeNegativeSliceV1(db, yesterday, { enabled: true })).toMatchObject({ enabled: true, data: { currencies: [] } });
      expect(await readDashboardFeeNegativeSliceV1(db, today, { enabled: true }, { mode: "selected", creatorOperatorIds: ["foreign-creator"] }))
        .toMatchObject({ enabled: true, data: { currencies: [] } });
      await journal("order_cancellation", orderId, [
        { accountCode: "5111", debitAmount: 818 - reversed.merchandiseRevenueMinor, creditAmount: 0 },
        { accountCode: "5112", debitAmount: 91 - reversed.shippingRevenueMinor, creditAmount: 0 },
        { accountCode: "5113", debitAmount: 82 - reversed.paymentFeeRevenueMinor, creditAmount: 0 },
        { accountCode: "3331", debitAmount: 99 - reversed.vatMinor, creditAmount: 0 }, { accountCode: "1111", debitAmount: 0, creditAmount: 545 },
        { accountCode: "1561", debitAmount: 50, creditAmount: 0 }, { accountCode: "6321", debitAmount: 0, creditAmount: 50 },
      ]);
      expect(await readDashboardFeeJournalSliceV1(db, today)).toMatchObject({ currencies: [{ revenueExcludingVatMinor: -82,
        coverage: { status: "available", coveredJournalCount: 2, excludedJournalCount: 0, totalJournalCount: 2 } }] });
      expect(await readDashboardFeeJournalSliceV1(db, today, { mode: "selected", creatorOperatorIds: [creatorId] }))
        .toMatchObject({ currencies: [{ revenueExcludingVatMinor: -82, coverage: { status: "available", totalJournalCount: 2 } }] });
      expect(await readDashboardFeeJournalSliceV1(db, today, { mode: "selected", creatorOperatorIds: ["foreign-creator"] }))
        .toMatchObject({ currencies: [{ revenueExcludingVatMinor: 0, coverage: { totalJournalCount: 0 } }] });
      await db.query("SET CONSTRAINTS ALL IMMEDIATE");
      // Snapshot readers own their transactions; commit only these sentinel-qualified synthetic facts.
      await db.query("COMMIT"); fixtureTransactionOpen = false;
      const dashboardInput = { scope, range: { from: "2026-10-27", to: "2026-10-27" },
        creatorSelection: { mode: "selected" as const, creatorOperatorIds: [creatorId] }, statementTimeoutMs: 10_000 };
      const full = await readCreatorSalesDashboardV3(db, { ...dashboardInput, audience: "full" });
      expect(full.currencies).toMatchObject([{ currentOrderGrossValueMinor: 0, currentPaymentFeeMinor: 0,
        recordedGrossCollectionsMinor: 1090, recordedPaymentFeeMinor: 90, recordedPaymentFeeVatMinor: 8, recordedPaymentFeeCustomerTotalMinor: 90 }]);
      expect(full.currencies[0]!.paymentMethods.reduce((sum, row) => sum + row.netMinor, 0)).toBe(0);
      expect(full.feeFinancial).toMatchObject({ currencies: [{ currentPaymentFeeRevenueExVatMinor: 0, recordedPaymentFeeRevenueExVatMinor: 82 }],
        negatives: { currencies: [{ feeRevenueReversedExVatMinor: 41, verifiedSubsetSettlementOnlyMinor: 545,
          coverage: { totalEventCount: 2, totalNegativeMinor: 1090, status: "available" } }] },
        journals: { currencies: [{ revenueExcludingVatMinor: -82, coverage: { status: "available", totalJournalCount: 2 } }] } });
      const self = await readCreatorSalesDashboardV3(db, { ...dashboardInput, audience: "self", selfOperatorId: creatorId });
      expect(self.currencies).toEqual(full.currencies);
      expect(self).not.toHaveProperty("financial"); expect(self).not.toHaveProperty("feeFinancial");
      expect(self.creatorOptions).toMatchObject([{ operatorId: creatorId }]);
      const previous = await readCreatorSalesDashboardV3(db, { ...dashboardInput, range: { from: "2026-10-26", to: "2026-10-26" }, audience: "full" });
      expect(previous.currencies).toMatchObject([{ orderCount: 1, activeOrderCount: 0, currentPaymentFeeMinor: 0, recordedGrossCollectionsMinor: 0 }]);
      expect(previous.feeFinancial).toMatchObject({ negatives: { currencies: [] },
        journals: { currencies: [{ revenueExcludingVatMinor: 82, coverage: { totalJournalCount: 1 } }] } });
      await expect(getDashboard(scope, { date: "2026-10-27" })).rejects.toMatchObject({ code: "unsupported_contract", statusCode: 409 });
      await expect(readCreatorSalesDashboardV3(db, { ...dashboardInput, audience: "full",
        creatorSelection: { mode: "selected", creatorOperatorIds: ["foreign-creator"] } })).rejects.toMatchObject({ code: "forbidden" });
    } finally { if (fixtureTransactionOpen) await db.query("ROLLBACK"); }
  });
});
