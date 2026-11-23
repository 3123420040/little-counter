import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_METRIC_TIME_BASIS_V2 } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { readDashboardFeeJournalSliceV1 } from "../services/dashboard-fee-journal-slice";
const context = { normalizedScope: { scopeKind: "report" as const, merchantId: "merchant-a", storeIds: ["store-a"] },
  localDateRange: { from: "2026-10-27", to: "2026-10-27", inclusiveDays: 1 },
  storeTimeWindows: [{ storeId: "store-a", timeZone: "UTC", startInclusive: "2026-10-27T00:00:00.000Z", endExclusive: "2026-10-28T00:00:00.000Z" }],
  reportAsOf: "2026-10-27T12:00:00.000Z", metricTimeBasis: { ...DASHBOARD_METRIC_TIME_BASIS_V2 } };
const components = { merchant_id: "merchant-a", store_id: "store-a", order_id: "order-a", revision_id: "00000000-0000-4000-8000-000000000001",
  currency_code: "VND", minor_unit_exponent: 0, component_version: 2, tax_mode: "exclusive", merchandise_gross_minor: 1000,
  discount_minor: 0, merchandise_net_minor: 1000, shipping_minor: 0, merchandise_vat_minor: 100, shipping_vat_minor: 0,
  payment_fee_minor: 100, payment_fee_vat_minor: 10, vat_minor: 110, unclassified_minor: 0, total_minor: 1210 };
function row(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "journal-a", reference_type: "order", merchant_id: "merchant-a", store_id: "store-a", order_id: "order-a", source_order_found: true,
    currency_code: "VND", minor_unit_exponent: 0, revision_id: components.revision_id, revision_number: 0, revision_count: 1, invalid_revision_count: 0,
    data_quality: "partial", complete_lineage: false, expected_cogs_minor: null, source_at: "2026-10-27T01:00:00.000Z",
    debit_total: "1210", credit_total: "1210", fractional_line_count: "0", payment_fee_revenue_minor: "100",
    fee_components: components, previous_fee_components: null, prior_refund_events: [], refund_event_id: null, refund_event_amount_minor: null, ...patch };
}
function client(rows: unknown[]) { const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows })); return { client: { query } as unknown as PoolClient, query }; }
describe("posted fee journal revenue source", () => {
  it("counts verified5113 revenue without requiring merchandise cost completeness", async () => {
    const { client: db, query } = client([row()]);
    const result = await readDashboardFeeJournalSliceV1(db, context, { mode: "selected", creatorOperatorIds: ["creator-a"] });
    expect(result).toMatchObject({ schemaVersion: 1, aggregateReadSource: "accounting.journal_entries", metricTimeBasis: "accounting_source_occurred_at",
      currencies: [{ currencyCode: "VND", revenueExcludingVatMinor: 100, verifiedSubsetRevenueExcludingVatMinor: 100,
        coverage: { status: "available", totalJournalCount: 1, coveredJournalCount: 1, excludedJournalCount: 0 }, warnings: [] }] });
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("HAVING COUNT(*) FILTER (WHERE a.code = '5113') > 0");
    expect(sql).toContain("je.status = 'posted'"); expect(sql).toContain("je.posted_at <= $5::timestamptz");
    expect(sql).toContain("source_at >= windows.start_inclusive"); expect(sql).not.toContain("je.entry_date BETWEEN");
    expect(params).toEqual(["merchant-a", ["store-a"], ["2026-10-27T00:00:00.000Z"], ["2026-10-28T00:00:00.000Z"], context.reportAsOf, "selected", ["creator-a"]]);
  });
  it("checks a signed fee decrease against both stored correction snapshots", async () => {
    const current = { ...components, revision_id: "00000000-0000-4000-8000-000000000002", payment_fee_minor: 0, payment_fee_vat_minor: 0, vat_minor: 100, total_minor: 1100 };
    const result = await readDashboardFeeJournalSliceV1(client([row({ reference_type: "order_correction", revision_id: current.revision_id,
      revision_number: 1, revision_count: 2, payment_fee_revenue_minor: "-100", fee_components: current, previous_fee_components: components })]).client, context);
    expect(result.currencies[0]).toMatchObject({ revenueExcludingVatMinor: -100, coverage: { status: "available" } });
  });
  it("recognizes cancellation reversal from the previous immutable basis", async () => {
    const cancelled = { ...components, revision_id: "00000000-0000-4000-8000-000000000003" };
    expect(await readDashboardFeeJournalSliceV1(client([row({ reference_type: "order_cancellation", revision_id: cancelled.revision_id,
      revision_number: 1, revision_count: 2, payment_fee_revenue_minor: "-100", fee_components: cancelled, previous_fee_components: components })]).client, context))
      .toMatchObject({ currencies: [{ revenueExcludingVatMinor: -100, coverage: { status: "available" } }] });
  });
  it.each([
    { credit_total: "1209" }, { fractional_line_count: "1" }, { payment_fee_revenue_minor: "99" }, { source_order_found: false },
    { revision_count: 2 }, { data_quality: "unavailable" }, { reference_type: "manual" }, { fee_components: null },
    { fee_components: { ...components, merchant_id: "foreign" } }, { payment_fee_revenue_minor: "9007199254740992" },
    { reference_type: "refund", refund_event_id: "missing-event", refund_event_amount_minor: 100, payment_fee_revenue_minor: -100 },
  ])("keeps unknown or inconsistent journals out of exact revenue: %j", async patch => {
    const value = row(patch), query = vi.fn(async (sql: string) => sql.includes("to_regclass") ? { rows: [{ present: false }] }
      : sql.includes("dashboard_fee_negative_events") ? { rows: [] } : { rows: [value] });
    const result = await readDashboardFeeJournalSliceV1({ query } as unknown as PoolClient, context);
    expect(result.currencies[0]).toMatchObject({ revenueExcludingVatMinor: null, verifiedSubsetRevenueExcludingVatMinor: 0,
      coverage: { status: "unavailable", totalJournalCount: 1, excludedJournalCount: 1, coveredJournalCount: 0 } });
    expect(result.currencies[0]!.warnings.length).toBeGreaterThan(0);
  });
  it("keeps a verified subset separate from exact income", async () => {
    const result = await readDashboardFeeJournalSliceV1(client([row(), row({ id: "journal-b", credit_total: 1 })]).client, context);
    expect(result.currencies[0]).toMatchObject({ revenueExcludingVatMinor: null, verifiedSubsetRevenueExcludingVatMinor: 100,
      coverage: { status: "partial", totalJournalCount: 2, coveredJournalCount: 1, excludedJournalCount: 1 } });
  });
  it("returns a known zero when no fee journal exists", async () => {
    expect(await readDashboardFeeJournalSliceV1(client([]).client, context)).toMatchObject({ currencies: [{ revenueExcludingVatMinor: 0,
      coverage: { status: "available", totalJournalCount: 0 } }] });
  });
  it.each([{ merchant_id: "foreign" }, { store_id: "foreign" }, { source_at: "2026-10-26T01:00:00.000Z" }])("rejects source scope/window drift: %j", async patch => {
    await expect(readDashboardFeeJournalSliceV1(client([row(patch)]).client, context)).rejects.toMatchObject({ statusCode: 422 });
  });
});
