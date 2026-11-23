import { describe, expect, it } from "vitest";
import { DashboardFeeNegativeCurrencyV1Schema, DashboardFeeNegativeSliceV1Schema } from "../order-payment-fee";
const available = { currencyCode: "VND", minorUnitExponent: 0, feeRevenueReversedExVatMinor: 5, verifiedSubsetFeeRevenueReversedExVatMinor: 5,
  verifiedSubsetSettlementOnlyMinor: 20, coverage: { status: "available", coveredEventCount: 1, excludedEventCount: 0, totalEventCount: 1,
    coveredNegativeMinor: 61, excludedNegativeMinor: 0, totalNegativeMinor: 61 }, warnings: [] };
const partial = { ...available, feeRevenueReversedExVatMinor: null, coverage: { ...available.coverage, status: "partial", excludedEventCount: 1,
  totalEventCount: 2, excludedNegativeMinor: 39, totalNegativeMinor: 100 }, warnings: ["missing_frozen_allocation"] };
describe("negative-event fee revenue coverage DTO", () => {
  it("keeps a verified subset distinct from the unavailable exact headline", () => {
    expect(DashboardFeeNegativeCurrencyV1Schema.parse(available)).toEqual(available);
    expect(DashboardFeeNegativeCurrencyV1Schema.parse(partial)).toEqual(partial);
    expect(DashboardFeeNegativeSliceV1Schema.parse({ schemaVersion: 1, aggregateReadSource: "app.payment_events", currencies: [] }).currencies).toEqual([]);
  });
  it.each([
    { feeRevenueReversedExVatMinor: null }, { verifiedSubsetFeeRevenueReversedExVatMinor: 6 }, { verifiedSubsetSettlementOnlyMinor: 60 },
    { warnings: ["missing_frozen_allocation"] }, { verifiedSubsetFeeRevenueReversedExVatMinor: -1 }, { currencyCode: "USD", minorUnitExponent: 2 },
    { internalPayload: "not-a-field" },
  ])("rejects misleading available values: %j", patch => {
    expect(DashboardFeeNegativeCurrencyV1Schema.safeParse({ ...available, ...patch }).success).toBe(false);
  });
  it.each([
    { feeRevenueReversedExVatMinor: 5 }, { warnings: [] }, { warnings: ["missing_frozen_allocation", "missing_frozen_allocation"] },
    { coverage: { ...partial.coverage, status: "available" } }, { coverage: { ...partial.coverage, totalEventCount: 3 } },
    { coverage: { ...partial.coverage, totalNegativeMinor: 101 } },
    { coverage: { ...partial.coverage, coveredEventCount: 0, totalEventCount: 1 } },
  ])("rejects misleading partial coverage: %j", patch => {
    expect(DashboardFeeNegativeCurrencyV1Schema.safeParse({ ...partial, ...patch }).success).toBe(false);
  });
  it("rejects source version drift and repeated currency identity", () => {
    expect(DashboardFeeNegativeSliceV1Schema.safeParse({ schemaVersion: 2, aggregateReadSource: "app.payment_events", currencies: [available] }).success).toBe(false);
    expect(DashboardFeeNegativeSliceV1Schema.safeParse({ schemaVersion: 1, aggregateReadSource: "app.payment_events", currencies: [available, available] }).success).toBe(false);
  });
});
