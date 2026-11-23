import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "../db/client";
import {
  readDashboardAccountingSliceV1,
} from "../services/dashboard-accounting-slice";

const context = {
  normalizedScope: {
    scopeKind: "report" as const,
    merchantId: "merchant-a",
    storeIds: ["store-a"],
  },
  localDateRange: {
    from: "2026-08-10",
    to: "2026-08-17",
    inclusiveDays: 8,
  },
  storeTimeWindows: [{
    storeId: "store-a",
    timeZone: "Asia/Ho_Chi_Minh",
    startInclusive: "2026-08-09T17:00:00.000Z",
    endExclusive: "2026-08-17T17:00:00.000Z",
  }],
  reportAsOf: "2026-08-17T09:00:00.000Z",
  metricTimeBasis: {
    recordedGrossCollectionsMinor: "payment_event_at" as const,
    refundsMinor: "payment_event_at" as const,
    reversalsMinor: "payment_event_at" as const,
    chargebacksMinor: "payment_event_at" as const,
    currentOrderGrossValueMinor: "effective_order_created_at" as const,
    commercialOutstandingAsOfMinor: "as_of_effective_order_and_payment_events" as const,
    customerRefundPayableAsOfMinor: "as_of_payment_events" as const,
    revenueExcludingVatMinor: "accounting_source_occurred_at" as const,
    vatLiabilityMinor: "accounting_source_occurred_at" as const,
    cogsRecognizedMinor: "accounting_source_occurred_at" as const,
  },
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    currency_code: "VND",
    minor_unit_exponent: "0",
    posted_journal_count: "2",
    balanced_journal_count: "2",
    mapped_source_count: "2",
    complete_cost_source_count: "2",
    fractional_line_count: "0",
    unsupported_reference_count: "0",
    unmapped_source_count: "0",
    merchandise_revenue_minor: "1000.00",
    cogs_recognized_minor: "600.00",
    verified_revenue_minor: "1000",
    verified_cogs_minor: "600",
    ...overrides,
  };
}

function clientReturning(input: Record<string, unknown>) {
  const query = vi.fn(async () => ({ rows: [input] }));
  return {
    client: { query } as unknown as PoolClient,
    query,
  };
}

describe("DASH-ACCT accounting-backed profit and margin slice", () => {
  it("attributes original, correction, cancellation and refund journals through one trusted creator selection", async () => {
    const { client, query } = clientReturning(row());
    await readDashboardAccountingSliceV1(client, context, { mode: "selected", creatorOperatorIds: ["creator_a", "creator_b"] });
    const [sql, params] = query.mock.calls[0]!;
    expect(params?.slice(-2)).toEqual(["selected", ["creator_a", "creator_b"]]);
    expect(sql).toContain("FROM source_order_candidates source");
    expect(sql).toContain("source_order.id = source.order_id");
    expect(sql).toContain("HAVING COUNT(*) = 1");
    expect(sql).toContain("creator.actor_id = ANY($7::text[])");
    expect(sql).toContain("MAX(creator_event.merchant_id) = source.merchant_id");
    expect(sql).toContain("MAX(creator_event.store_id) = source.store_id");
  });
  it("aggregates only balanced posted 5111/6321 journals by immutable source time", async () => {
    const { client, query } = clientReturning(row());

    await expect(readDashboardAccountingSliceV1(client, context)).resolves.toMatchObject({
      schemaVersion: 1,
      aggregateReadSource: "accounting.journal_entries",
      currencies: [{
        currencyCode: "VND",
        minorUnitExponent: 0,
        status: "available",
        dataQualityStatus: "complete",
        postedJournalCount: 2,
        revenueExcludingVatMinor: 1000,
        cogsRecognizedMinor: 600,
        grossProfitMinor: 400,
        grossMarginPercent: 40,
      }],
    });

    const [sql, params] = query.mock.calls[0]!;
    const normalizedSql = String(sql).toLowerCase().replace(/\s+/g, " ");
    expect(normalizedSql).toContain("je.status = 'posted'");
    expect(normalizedSql).toContain("a.code = '5111'");
    expect(normalizedSql).toContain("a.code = '6321'");
    expect(normalizedSql).toContain("app.order_commercial_revisions");
    expect(normalizedSql).toContain("source_at >= windows.start_inclusive");
    expect(normalizedSql).toContain("source_at < least(windows.end_exclusive, $5::timestamptz)");
    expect(normalizedSql).not.toContain("je.entry_date between");
    expect(params).toEqual([
      "merchant-a",
      ["store-a"],
      ["2026-08-09T17:00:00.000Z"],
      ["2026-08-17T17:00:00.000Z"],
      "2026-08-17T09:00:00.000Z",
      "all",
      [],
    ]);
  });

  it("withholds values when immutable cost provenance is incomplete", async () => {
    const { client } = clientReturning(row({
      complete_cost_source_count: "1",
    }));

    await expect(readDashboardAccountingSliceV1(client, context)).resolves.toMatchObject({
      schemaVersion: 1,
      aggregateReadSource: "accounting.journal_entries",
      currencies: [{
        currencyCode: "VND",
        minorUnitExponent: 0,
        status: "unavailable",
        dataQualityStatus: "unavailable",
        issues: ["incomplete_cost_provenance"],
      }],
    });
  });

  it("withholds values for unbalanced, fractional or unmapped journal evidence", async () => {
    const { client } = clientReturning(row({
      balanced_journal_count: "1",
      fractional_line_count: "1",
      unmapped_source_count: "1",
    }));

    const result = await readDashboardAccountingSliceV1(client, context);
    expect(result.currencies[0]).toEqual({
      currencyCode: "VND",
      minorUnitExponent: 0,
      status: "unavailable",
      dataQualityStatus: "unavailable",
      issues: [
        "fractional_minor_units",
        "missing_source_mapping",
        "unbalanced_journal",
      ],
    });
  });

  it("keeps exact zero profit available but withholds margin for a zero denominator", async () => {
    const { client } = clientReturning(row({
      posted_journal_count: "0",
      balanced_journal_count: "0",
      mapped_source_count: "0",
      complete_cost_source_count: "0",
      merchandise_revenue_minor: "0",
      cogs_recognized_minor: "0",
    }));

    await expect(readDashboardAccountingSliceV1(client, context)).resolves.toMatchObject({
      currencies: [{
        status: "available",
        revenueExcludingVatMinor: 0,
        cogsRecognizedMinor: 0,
        grossProfitMinor: 0,
        grossMarginPercent: null,
      }],
    });
  });
});


describe("OV2 verified subset accounting", () => {
  it("keeps full profit absent and derives partial from matched subset only", async () => {
    const { client } = clientReturning(row({ complete_cost_source_count: "1", verified_revenue_minor: "300", verified_cogs_minor: "200" }));
    const result = await readDashboardAccountingSliceV1(client, context);
    expect(result.currencies[0]).not.toHaveProperty("grossProfitMinor");
    expect(result.profitCoverage).toMatchObject([{ currencyCode: "VND", coverage: {
      status: "partial", totalJournalCount: 2, coveredJournalCount: 1, excludedJournalCount: 1,
      exactGrossProfitMinor: null, verifiedSubsetRevenueExcludingVatMinor: 300,
      verifiedSubsetCogsRecognizedMinor: 200, verifiedSubsetGrossProfitMinor: 100,
    } }]);
  });
  it.each(["balanced_journal_count", "mapped_source_count"])("fails closed with no partial numeric for %s", async (field) => {
    const { client } = clientReturning(row({ [field]: "1", complete_cost_source_count: "1" }));
    expect((await readDashboardAccountingSliceV1(client, context)).profitCoverage?.[0]?.coverage)
      .toMatchObject({ status: "unavailable", exactGrossProfitMinor: null, verifiedSubsetGrossProfitMinor: null });
  });
  it.each(["fractional_line_count", "unsupported_reference_count", "unmapped_source_count"])("preserves global hard gate %s", async (field) => {
    const { client } = clientReturning(row({ [field]: "1", complete_cost_source_count: "1" }));
    expect((await readDashboardAccountingSliceV1(client, context)).profitCoverage?.[0]?.coverage.status).toBe("unavailable");
  });
  it("has no numeric when 0/N is covered", async () => {
    const { client } = clientReturning(row({ complete_cost_source_count: "0", verified_revenue_minor: "0", verified_cogs_minor: "0" }));
    expect((await readDashboardAccountingSliceV1(client, context)).profitCoverage?.[0]?.coverage)
      .toMatchObject({ status: "unavailable", totalJournalCount: 2, coveredJournalCount: 0, verifiedSubsetGrossProfitMinor: null });
  });
  it("rejects impossible coverage counts", async () => {
    const { client } = clientReturning(row({ complete_cost_source_count: "3" }));
    await expect(readDashboardAccountingSliceV1(client, context)).rejects.toThrow();
  });
  it("rejects unsafe total money even when a safe subset exists", async () => {
    const { client } = clientReturning(row({ complete_cost_source_count: "1", merchandise_revenue_minor: "9007199254740992" }));
    await expect(readDashboardAccountingSliceV1(client, context)).rejects.toThrow();
  });
});
