import { describe, expect, it } from "vitest";
import { CreatorSalesDashboardV3Schema } from "../order-payment-fee";
import { creatorSalesDashboardFixture } from "../../../application/src/__tests__/fixtures/creator-sales-dashboard";
const legacy = creatorSalesDashboardFixture("full"), currency = { ...legacy.currencies[0]!, currentPaymentFeeMinor: 100,
  currentPaymentFeeVatMinor: 10, currentPaymentFeeCustomerTotalMinor: 100, recordedGrossCollectionsMinor: 420000,
  recordedPaymentFeeMinor: -100, recordedPaymentFeeVatMinor: -10, recordedPaymentFeeCustomerTotalMinor: -110 };
const feeFinancial = { currencies: [{ currencyCode: "VND", minorUnitExponent: 0, currentPaymentFeeRevenueExVatMinor: 90,
  recordedPaymentFeeRevenueExVatMinor: -100 }], negatives: { schemaVersion: 1, aggregateReadSource: "app.payment_events", currencies: [] },
  journals: { schemaVersion: 1, aggregateReadSource: "accounting.journal_entries", metricTimeBasis: "accounting_source_occurred_at",
    currencies: [{ currencyCode: "VND", minorUnitExponent: 0, revenueExcludingVatMinor: 0, verifiedSubsetRevenueExcludingVatMinor: 0,
      coverage: { status: "available", totalJournalCount: 0, coveredJournalCount: 0, excludedJournalCount: 0 }, warnings: [] }] } };
const full = { ...legacy, schemaVersion: 3, currencies: [currency], feeFinancial };
describe("strict full/self fee-aware DashboardV3", () => {
  it("preserves the existing full dashboard and separates owner fee financial sources", () => {
    expect(CreatorSalesDashboardV3Schema.parse(full)).toEqual(full);
  });
  it("accepts a self sales allowlist with current and signed posted customer fee amounts only", () => {
    const self = { ...full, audience: "self", financial: undefined, feeFinancial: undefined };
    expect(CreatorSalesDashboardV3Schema.parse(self)).toEqual(self);
  });
  it.each([
    { audience: "self" }, { feeFinancial: undefined }, { financial: undefined }, { schemaVersion: 2 },
    { feeFinancial: { ...feeFinancial, currencies: [] } },
    { feeFinancial: { ...feeFinancial, currencies: [{ ...feeFinancial.currencies[0], currentPaymentFeeRevenueExVatMinor: 100 }] } },
    { currencies: [{ ...currency, currentPaymentFeeCustomerTotalMinor: 99 }] },
    { currencies: [{ ...currency, activeOrderCount: 4 }] },
    { currencies: [{ ...currency, averageCurrentOrderValueMinor: 1 }] },
    { currencies: [{ ...currency, dailySeries: [{ ...currency.dailySeries[0], currentOrderGrossValueMinor: 1 }] }] },
    { currencies: [{ ...currency, costPrice: 100 }] },
    { currencies: [currency, currency] },
  ])("rejects source, audience, money or identity drift: %j", patch => {
    expect(CreatorSalesDashboardV3Schema.safeParse({ ...full, ...patch }).success).toBe(false);
  });
  it.each([
    { creatorSelection: { mode: "all", creatorOperatorIds: [] } },
    { creatorOptions: [{ operatorId: "other", displayName: "Other", status: "active" }] },
    { currencies: [{ ...currency, currentPaymentFeeRevenueExVatMinor: 90 }] }, { feeFinancial }, { financial: legacy.financial },
  ])("rejects a self response exposing internal or other creator data: %j", patch => {
    expect(CreatorSalesDashboardV3Schema.safeParse({ ...full, audience: "self", financial: undefined, feeFinancial: undefined, ...patch }).success).toBe(false);
  });
});
