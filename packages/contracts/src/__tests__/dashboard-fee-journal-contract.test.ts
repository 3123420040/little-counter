import { describe, expect, it } from "vitest";
import { DashboardFeeJournalCurrencyV1Schema, DashboardFeeJournalSliceV1Schema } from "../order-payment-fee";
const row = { currencyCode: "VND", minorUnitExponent: 0, revenueExcludingVatMinor: -41, verifiedSubsetRevenueExcludingVatMinor: -41,
  coverage: { status: "available", totalJournalCount: 1, coveredJournalCount: 1, excludedJournalCount: 0 }, warnings: [] };
const partial = { ...row, revenueExcludingVatMinor: null, coverage: { ...row.coverage, status: "partial", totalJournalCount: 2, excludedJournalCount: 1 },
  warnings: ["unavailable_refund_evidence"] };
describe("strict fee journal income coverage", () => {
  it("retains signed income and makes exact vs verified-subset values explicit", () => {
    expect(DashboardFeeJournalCurrencyV1Schema.parse(row)).toEqual(row);
    expect(DashboardFeeJournalCurrencyV1Schema.parse(partial)).toEqual(partial);
  });
  it.each([
    { revenueExcludingVatMinor: null }, { verifiedSubsetRevenueExcludingVatMinor: -40 }, { warnings: ["fee_lineage_mismatch"] },
    { coverage: { ...row.coverage, coveredJournalCount: 0 } }, { coverage: { ...row.coverage, totalJournalCount: 2 } },
    { revenueExcludingVatMinor: Number.MAX_SAFE_INTEGER + 1 }, { feeJournalPayload: "not-a-field" },
  ])("rejects misleading exact revenue or counts: %j", patch => {
    expect(DashboardFeeJournalCurrencyV1Schema.safeParse({ ...row, ...patch }).success).toBe(false);
  });
  it.each([
    { revenueExcludingVatMinor: -41 }, { warnings: [] }, { warnings: ["unavailable_refund_evidence", "unavailable_refund_evidence"] },
    { coverage: { ...partial.coverage, status: "available" } }, { coverage: { ...partial.coverage, coveredJournalCount: 0, totalJournalCount: 1 } },
  ])("keeps partial revenue distinct from exact income: %j", patch => {
    expect(DashboardFeeJournalCurrencyV1Schema.safeParse({ ...partial, ...patch }).success).toBe(false);
  });
  it("rejects source, version and repeated currency drift", () => {
    const slice = { schemaVersion: 1, aggregateReadSource: "accounting.journal_entries", metricTimeBasis: "accounting_source_occurred_at", currencies: [row] };
    expect(DashboardFeeJournalSliceV1Schema.parse(slice)).toEqual(slice);
    for (const patch of [{ schemaVersion: 2 }, { metricTimeBasis: "payment_event_at" }, { aggregateReadSource: "public.order" }, { currencies: [row, row] }]) {
      expect(DashboardFeeJournalSliceV1Schema.safeParse({ ...slice, ...patch }).success).toBe(false);
    }
  });
});
