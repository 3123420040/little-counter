import { describe, expect, it } from "vitest";
import { DashboardAccountingProfitCoverageV1Schema } from "../order-financial-correctness";

const partial = {
  status: "partial", totalJournalCount: 3, coveredJournalCount: 2, excludedJournalCount: 1,
  exactGrossProfitMinor: null, verifiedSubsetRevenueExcludingVatMinor: 100,
  verifiedSubsetCogsRecognizedMinor: 60, verifiedSubsetGrossProfitMinor: 40,
  issues: ["incomplete_cost_provenance"],
};

describe("verified accounting profit coverage contract", () => {
  it("accepts an explicitly identified verified subset", () => {
    expect(DashboardAccountingProfitCoverageV1Schema.parse(partial)).toEqual(partial);
  });
  it.each([
    { exactGrossProfitMinor: 40 }, { coveredJournalCount: -1 },
    { coveredJournalCount: 1.5 }, { coveredJournalCount: 0, excludedJournalCount: 3 },
    { excludedJournalCount: 0 }, { totalJournalCount: Number.MAX_SAFE_INTEGER + 1 },
    { verifiedSubsetGrossProfitMinor: 41 }, { issues: ["unbalanced_journal"] },
    { estimatedProfit: 900 },
  ])("rejects misleading partial state %j", (override) => {
    expect(DashboardAccountingProfitCoverageV1Schema.safeParse({ ...partial, ...override }).success).toBe(false);
  });
  it("accepts exact empty zero and rejects fabricated empty profit", () => {
    const empty = { ...partial, status: "exact", totalJournalCount: 0, coveredJournalCount: 0, excludedJournalCount: 0,
      exactGrossProfitMinor: 0, verifiedSubsetRevenueExcludingVatMinor: 0, verifiedSubsetCogsRecognizedMinor: 0, verifiedSubsetGrossProfitMinor: 0, issues: [] };
    expect(DashboardAccountingProfitCoverageV1Schema.safeParse(empty).success).toBe(true);
    expect(DashboardAccountingProfitCoverageV1Schema.safeParse({ ...empty, verifiedSubsetRevenueExcludingVatMinor: 10, verifiedSubsetCogsRecognizedMinor: 10 }).success).toBe(false);
  });
  it("rejects any numeric profit on unavailable", () => {
    const unavailable = { ...partial, status: "unavailable", coveredJournalCount: 0, excludedJournalCount: 3,
      verifiedSubsetRevenueExcludingVatMinor: null, verifiedSubsetCogsRecognizedMinor: null, verifiedSubsetGrossProfitMinor: null };
    expect(DashboardAccountingProfitCoverageV1Schema.safeParse(unavailable).success).toBe(true);
    expect(DashboardAccountingProfitCoverageV1Schema.safeParse({ ...unavailable, verifiedSubsetGrossProfitMinor: 0 }).success).toBe(false);
  });
});
