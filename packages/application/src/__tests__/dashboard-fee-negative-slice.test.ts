import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_METRIC_TIME_BASIS_V2 } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { freezeRefundAllocationV2, splitRefundComponentsV2, zeroRefundComponentsV2 } from "../services/refund-component-allocation";
import { readRefundCommercialBasisV2 } from "../services/refund-commercial-allocation-service";
import { readDashboardFeeNegativeSliceV1 } from "../services/dashboard-fee-negative-slice";
const ids = { event: "00000000-0000-4000-8000-000000000001", payable: "00000000-0000-4000-8000-000000000002",
  obligation: "00000000-0000-4000-8000-000000000003", revision: "00000000-0000-4000-8000-000000000004" };
const context = { normalizedScope: { scopeKind: "report" as const, merchantId: "merchant-a", storeIds: ["store-a"] },
  localDateRange: { from: "2026-10-27", to: "2026-10-27", inclusiveDays: 1 },
  storeTimeWindows: [{ storeId: "store-a", timeZone: "UTC", startInclusive: "2026-10-27T00:00:00.000Z", endExclusive: "2026-10-28T00:00:00.000Z" }],
  reportAsOf: "2026-10-27T12:00:00.000Z", metricTimeBasis: { ...DASHBOARD_METRIC_TIME_BASIS_V2 } };
const component_record = { merchant_id: "merchant-a", store_id: "store-a", order_id: "order-a", revision_id: ids.revision,
  currency_code: "VND", minor_unit_exponent: 0, component_version: 2, tax_mode: "exclusive", merchandise_gross_minor: 100,
  discount_minor: 0, merchandise_net_minor: 100, shipping_minor: 0, merchandise_vat_minor: 10, shipping_vat_minor: 0,
  payment_fee_minor: 10, payment_fee_vat_minor: 1, vat_minor: 11, unclassified_minor: 0, total_minor: 121 };
function event(amount = 61, kind: "manual_refund" | "negative_correction" = "manual_refund") {
  const payable = { payable_id: ids.payable, payable_kind: kind, commercial_revision_id: ids.revision,
    source_type: kind, source_id: "source-a", amount_minor: String(amount), component_record };
  const basis = readRefundCommercialBasisV2(payable);
  const reversalComponents = kind === "manual_refund" ? splitRefundComponentsV2(amount, basis.capacities) : zeroRefundComponentsV2();
  const frozen = freezeRefundAllocationV2({ schemaVersion: 2, amountMinor: amount, reversalComponents,
    settlementOnlyMinor: kind === "manual_refund" ? 0 : amount,
    payableAllocations: [{ payableId: ids.payable, payableKind: kind, commercialRevisionId: ids.revision, componentVersion: 2,
      basisFingerprint: basis.basisFingerprint, sourceType: kind, sourceId: "source-a", amountMinor: amount, reversalComponents,
      ...(kind === "manual_refund" ? { basisCapacities: basis.capacities, remainingBefore: basis.capacities } : {}) }],
    obligationAllocations: [{ obligationId: ids.obligation, amountMinor: amount }] });
  return { id: ids.event, merchant_id: "merchant-a", store_id: "store-a", order_id: "order-a", kind: "refund", currency_code: "VND", minor_unit_exponent: 0,
    amount_minor: String(amount), metadata: { refundAllocationV2: frozen }, exact_evidence_count: "1",
    source_occurred_at: "2026-10-27T01:00:00.000Z", recorded_at: "2026-10-27T01:00:00.000Z",
    payable_allocations: [payable], obligation_allocations: [{ obligation_id: ids.obligation, amount_minor: String(amount), commercial_revision_id: ids.revision, component_record }] };
}
function client(rows: unknown[]) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => sql.includes("to_regclass") ? { rows: [{ present: false }] } : { rows });
  return { client: { query } as unknown as PoolClient, query };
}
describe("fee revenue reversal on posted negative events", () => {
  it("uses the actual frozen partial refund and bound payable/obligation facts", async () => {
    const { client: db } = client([event()]);
    const result = await readDashboardFeeNegativeSliceV1(db, context, { enabled: true });
    expect(result).toMatchObject({ enabled: true, data: { schemaVersion: 1, aggregateReadSource: "app.payment_events", currencies: [{
      currencyCode: "VND", feeRevenueReversedExVatMinor: 5, verifiedSubsetFeeRevenueReversedExVatMinor: 5, verifiedSubsetSettlementOnlyMinor: 0,
      coverage: { status: "available", coveredEventCount: 1, excludedEventCount: 0, totalEventCount: 1,
        coveredNegativeMinor: 61, excludedNegativeMinor: 0, totalNegativeMinor: 61 }, warnings: [] }] } });
  });
  it("does not reverse fee revenue again for a settled correction credit", async () => {
    expect(await readDashboardFeeNegativeSliceV1(client([event(61, "negative_correction")]).client, context, { enabled: true }))
      .toMatchObject({ enabled: true, data: { currencies: [{ feeRevenueReversedExVatMinor: 0, verifiedSubsetSettlementOnlyMinor: 61,
        coverage: { status: "available" } }] } });
  });
  it("retains a proven legacy no-fee refund without consulting the latest order", async () => {
    const row = event(), legacy = { ...component_record, component_version: 1, payment_fee_minor: 0, payment_fee_vat_minor: 0, vat_minor: 10, total_minor: 110 };
    row.metadata = {} as typeof row.metadata;
    row.payable_allocations[0]!.component_record = legacy;
    row.obligation_allocations[0]!.component_record = legacy;
    expect(await readDashboardFeeNegativeSliceV1(client([row]).client, context, { enabled: true })).toMatchObject({ enabled: true,
      data: { currencies: [{ feeRevenueReversedExVatMinor: 0, coverage: { status: "available" } }] } });
  });
  it("retains proven legacy settlement-only payment without a frozen envelope", async () => {
    const row = event(61, "negative_correction"); row.metadata = {} as typeof row.metadata;
    expect(await readDashboardFeeNegativeSliceV1(client([row]).client, context, { enabled: true })).toMatchObject({ enabled: true,
      data: { currencies: [{ feeRevenueReversedExVatMinor: 0, verifiedSubsetSettlementOnlyMinor: 61, coverage: { status: "available" } }] } });
  });
  it.each(["refund", "reversal", "chargeback"])("counts %s with a verified frozen fee allocation", async kind => {
    expect(await readDashboardFeeNegativeSliceV1(client([{ ...event(), kind }]).client, context, { enabled: true })).toMatchObject({ enabled: true,
      data: { currencies: [{ feeRevenueReversedExVatMinor: 5, coverage: { totalNegativeMinor: 61 } }] } });
  });
  it.each([
    "missing_frozen", "bad_fingerprint", "bad_amount", "bad_basis", "bad_payable", "missing_evidence", "bad_obligation",
  ])("preserves unavailable coverage instead of a fake zero: %s", async fault => {
    const row = event();
    if (fault === "missing_frozen") row.metadata = {} as typeof row.metadata;
    if (fault === "bad_fingerprint") row.metadata.refundAllocationV2.fingerprint = "b".repeat(64);
    if (fault === "bad_amount") row.amount_minor = "60";
    if (fault === "bad_basis") row.payable_allocations[0]!.component_record = { ...component_record, payment_fee_minor: 20, total_minor: 131 };
    if (fault === "bad_payable") row.payable_allocations[0]!.source_id = "foreign-source";
    if (fault === "missing_evidence") row.exact_evidence_count = "0";
    if (fault === "bad_obligation") row.obligation_allocations[0]!.amount_minor = "60";
    expect(await readDashboardFeeNegativeSliceV1(client([row]).client, context, { enabled: true })).toMatchObject({ enabled: true,
      data: { currencies: [{ feeRevenueReversedExVatMinor: null, verifiedSubsetFeeRevenueReversedExVatMinor: 0,
        coverage: { status: "unavailable", coveredEventCount: 0, excludedEventCount: 1 } }] } });
  });
  it("does not call nonzero fee fields a legacy zero when the version flag is inconsistent", async () => {
    const row = event(); row.metadata = {} as typeof row.metadata;
    row.payable_allocations[0]!.component_record = { ...component_record, component_version: 1, vat_minor: 10, total_minor: 110 };
    expect(await readDashboardFeeNegativeSliceV1(client([row]).client, context, { enabled: true })).toMatchObject({ enabled: true,
      data: { currencies: [{ feeRevenueReversedExVatMinor: null, coverage: { status: "unavailable" } }] } });
  });
  it("proves a legacy no-fee provider reversal from its immutable funding obligations", async () => {
    const row = event(), legacy = { ...component_record, component_version: 1, payment_fee_minor: 0, payment_fee_vat_minor: 0, vat_minor: 10, total_minor: 110 };
    row.kind = "reversal"; row.metadata = {} as typeof row.metadata; row.payable_allocations = [];
    row.obligation_allocations[0]!.component_record = legacy;
    expect(await readDashboardFeeNegativeSliceV1(client([row]).client, context, { enabled: true })).toMatchObject({ enabled: true,
      data: { currencies: [{ feeRevenueReversedExVatMinor: 0, coverage: { status: "available" } }] } });
  });
  it("does not claim a fee reversal outside integer VND", async () => {
    const row = { ...event(), currency_code: "USD", minor_unit_exponent: 2 };
    const foreign = { ...component_record, currency_code: "USD", minor_unit_exponent: 2 };
    row.payable_allocations[0]!.component_record = foreign; row.obligation_allocations[0]!.component_record = foreign;
    await expect(readDashboardFeeNegativeSliceV1(client([row]).client, context, { enabled: true })).rejects.toMatchObject({ statusCode: 422 });
  });
  it("rejects repeated source event identities", async () => {
    await expect(readDashboardFeeNegativeSliceV1(client([event(), event()]).client, context, { enabled: true })).rejects.toMatchObject({ statusCode: 422 });
  });
  it("retains the historical-payment quarantine gate before reading events", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("to_regclass") ? { rows: [{ present: true }] }
      : { rows: [{ quarantined_count: "1", quarantined_minor: "61" }] });
    await expect(readDashboardFeeNegativeSliceV1({ query } as unknown as PoolClient, context, { enabled: true })).rejects.toMatchObject({ statusCode: 422 });
    expect(query.mock.calls.some(([sql]) => sql.includes("dashboard_fee_negative_events"))).toBe(false);
  });
  it("does not call an unclassified legacy basis a known fee zero", async () => {
    const row = event(); row.metadata = {} as typeof row.metadata;
    const ambiguous = { ...component_record, component_version: 1, payment_fee_minor: 0, payment_fee_vat_minor: 0, vat_minor: 10,
      unclassified_minor: 1, total_minor: 111 };
    row.payable_allocations[0]!.component_record = ambiguous;
    row.obligation_allocations[0]!.component_record = ambiguous;
    expect(await readDashboardFeeNegativeSliceV1(client([row]).client, context, { enabled: true })).toMatchObject({ enabled: true,
      data: { currencies: [{ feeRevenueReversedExVatMinor: null, coverage: { status: "unavailable" } }] } });
  });
  it("keeps partial verified amounts separate from exact headline", async () => {
    const bad = event(); bad.id = "00000000-0000-4000-8000-000000000005"; bad.exact_evidence_count = "0";
    expect(await readDashboardFeeNegativeSliceV1(client([event(), bad]).client, context, { enabled: true })).toMatchObject({ enabled: true,
      data: { currencies: [{ feeRevenueReversedExVatMinor: null, verifiedSubsetFeeRevenueReversedExVatMinor: 5,
        coverage: { status: "partial", coveredEventCount: 1, excludedEventCount: 1, totalEventCount: 2, totalNegativeMinor: 122 } }] } });
  });
  it.each([
    { merchant_id: "foreign" }, { store_id: "foreign" }, { kind: "charge" },
    { source_occurred_at: "2026-10-26T01:00:00.000Z" }, { recorded_at: "2026-10-28T00:00:00.000Z" }, { amount_minor: "1.5" },
  ])("rejects source query-contract drift: %j", async patch => {
    await expect(readDashboardFeeNegativeSliceV1(client([{ ...event(), ...patch }]).client, context, { enabled: true })).rejects.toMatchObject({ statusCode: 422 });
  });
  it("is default-off and freezes scope/time/creator inputs for the actual SQL", async () => {
    const { client: db, query } = client([]);
    expect(await readDashboardFeeNegativeSliceV1(db, context)).toEqual({ enabled: false, status: "disabled" });
    expect(await readDashboardFeeNegativeSliceV1(db, context, { enabled: 1 } as never)).toEqual({ enabled: false, status: "disabled" });
    expect(query).not.toHaveBeenCalled();
    await readDashboardFeeNegativeSliceV1(db, context, { enabled: true }, { mode: "selected", creatorOperatorIds: ["creator-a"] });
    const [sql, params] = query.mock.calls.at(-1)!;
    expect(sql).toContain("events.source_occurred_at"); expect(sql).toContain("events.recorded_at");
    expect(params).toEqual(["merchant-a", ["store-a"], ["2026-10-27T00:00:00.000Z"], ["2026-10-28T00:00:00.000Z"], context.reportAsOf, "selected", ["creator-a"]]);
  });
});
