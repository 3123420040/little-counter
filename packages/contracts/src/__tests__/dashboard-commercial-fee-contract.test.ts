import { describe, expect, it } from "vitest";
import { DashboardCommercialCurrencyV2Schema, DashboardCommercialSliceV2Schema } from "../order-payment-fee";
const currency = { currencyCode: "VND", minorUnitExponent: 0, validOrderCount: 2, cancelledOrderCohortCount: 1, activeOrdersWithShippingCount: 0,
  currentOrderGrossValueMinor: 2310, currentMerchandiseGrossValueMinor: 2000, currentDiscountMinor: 0, currentMerchandiseRevenueExVatMinor: 1909,
  currentShippingRevenueExVatMinor: 0, currentShippingGrossValueMinor: 0, currentShippingSharePercent: 0, currentVatMinor: 210,
  currentUnclassifiedMinor: 0, effectiveItemQuantity: 6, averageCurrentOrderValueMinor: 1155, currentCogsMinor: 60,
  currentMerchandiseGrossProfitMinor: 1849, currentContributionBeforeShippingCostMinor: 1849,
  costCoverage: { knownLines: 4, totalLines: 4 }, dataQuality: { status: "complete", costCoverage: { knownLines: 4, totalLines: 4 }, warnings: [] }, topProducts: [],
  currentPaymentFeeMinor: 200, currentPaymentFeeVatMinor: 19, currentPaymentFeeCustomerTotalMinor: 210, currentPaymentFeeRevenueExVatMinor: 191,
  dailyCurrentOrderGrossValueSeries: [{ localDate: "2026-03-08", currentOrderGrossValueMinor: 2310 }] };
const slice = { schemaVersion: 2, currencies: [currency], dailyActiveOrderCountSeries: [{ localDate: "2026-03-08", activeOrderCount: 2 }] };
describe("strict commercial fee Dashboard DTO", () => {
  it("retains actual gross, fee VAT and merchandise-only profit with mixed tax mode", () => {
    expect(DashboardCommercialCurrencyV2Schema.parse(currency)).toEqual(currency);
    expect(DashboardCommercialSliceV2Schema.parse(slice)).toEqual(slice);
  });
  it.each([
    { currentPaymentFeeCustomerTotalMinor: 209 }, { currentPaymentFeeVatMinor: 20 }, { currentPaymentFeeMinor: 190 },
    { currentPaymentFeeMinor: 211 }, { currentOrderGrossValueMinor: 2309 }, { currentVatMinor: 18 },
    { averageCurrentOrderValueMinor: 1154 }, { currentShippingSharePercent: 1 }, { currentMerchandiseGrossProfitMinor: 2040 },
    { currentCogsMinor: null }, { currentPaymentFeeMinor: 0.5 }, { currentOrderGrossValueMinor: -1 },
    { currentOrderGrossValueMinor: Number.MAX_SAFE_INTEGER + 1 }, { currentShippingGrossValueMinor: Number.MAX_SAFE_INTEGER + 1 },
    { currentPaymentFeeRevenueExVatMinor: 3000 }, { currentPaymentFeeRevenueExVatMinor: Number.MAX_SAFE_INTEGER + 1 },
    { dailyCurrentOrderGrossValueSeries: [{ localDate: "2026-03-08", currentOrderGrossValueMinor: 2311 }] },
    { feeRevenueInternal: 191 },
  ])("rejects invalid arithmetic/coverage without throwing outside schema validation: %j", (patch) => {
    expect(DashboardCommercialCurrencyV2Schema.safeParse({ ...currency, ...patch }).success).toBe(false);
    expect(DashboardCommercialSliceV2Schema.safeParse({ ...slice, currencies: [{ ...currency, ...patch }] }).success).toBe(false);
  });
  it.each([
    { currencies: [currency, currency] }, { schemaVersion: 1 },
    { dailyActiveOrderCountSeries: [{ localDate: "2026-03-08", activeOrderCount: 3 }] },
    { dailyActiveOrderCountSeries: [{ localDate: "2026-03-09", activeOrderCount: 2 }] },
    { dailyActiveOrderCountSeries: undefined }, { currencies: [{ ...currency, dailyCurrentOrderGrossValueSeries: undefined }] },
  ])("rejects snapshot envelope/daily identity drift: %j", patch => {
    expect(DashboardCommercialSliceV2Schema.safeParse({ ...slice, ...patch }).success).toBe(false);
  });
});
