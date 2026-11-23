import { describe, expect, it } from "vitest";
import { RecordedGrossCollectionComponentsV1Schema, RecordedGrossCollectionComponentsV2Schema,
  RecordedGrossCollectionCurrencyV2Schema, RecordedGrossCollectionSliceV2Schema } from "../order-financial-correctness";
const components = { taxModes: ["exclusive" as const], merchandiseGrossMinor: -100, discountMinor: 0, merchandiseNetMinor: -100,
  shippingMinor: 0, merchandiseVatMinor: 0, shippingVatMinor: 0, vatMinor: 0, vatIncludedInPriceMinor: 0, vatAddedToPriceMinor: 0,
  unclassifiedMinor: 0, totalMinor: 50, paymentFeeMinor: 150, paymentFeeVatMinor: 0, paymentFeeVatIncludedInPriceMinor: 0, paymentFeeVatAddedToPriceMinor: 0 };
const currency = { currencyCode: "VND", minorUnitExponent: 0, postedChargeEventCount: 1, bundleCoverage: { validEvents: 1, totalEvents: 1 },
  recordedGrossCollectionsMinor: 50, components, dailyRecordedGrossCollectionsSeries: [{ localDate: "2026-10-27", recordedGrossCollectionsMinor: 50 }] };
const slice = { schemaVersion: 2, aggregateReadSource: "app.payment_events", currencies: [currency] };
describe("strict fee-aware posted collection DTO", () => {
  it("retains signed correction components while the posted cash headline stays nonnegative", () => {
    expect(RecordedGrossCollectionSliceV2Schema.parse(slice)).toEqual(slice);
    expect(RecordedGrossCollectionComponentsV1Schema.safeParse(components).success).toBe(false);
    const negativeFee = { ...components, merchandiseGrossMinor: 200, merchandiseNetMinor: 200, merchandiseVatMinor: 20, vatMinor: 15,
      vatAddedToPriceMinor: 15, totalMinor: 165, paymentFeeMinor: -50, paymentFeeVatMinor: -5, paymentFeeVatAddedToPriceMinor: -5 };
    expect(RecordedGrossCollectionComponentsV2Schema.parse(negativeFee)).toEqual(negativeFee);
  });
  it("retains legacy foreign-currency collections when no fee is present", () => {
    const legacyComponents = { ...components, merchandiseGrossMinor: 50, merchandiseNetMinor: 50, paymentFeeMinor: 0 };
    expect(RecordedGrossCollectionCurrencyV2Schema.parse({ ...currency, currencyCode: "USD", minorUnitExponent: 2, components: legacyComponents }))
      .toMatchObject({ currencyCode: "USD", minorUnitExponent: 2, components: { paymentFeeMinor: 0 } });
  });
  it.each([
    { paymentFeeMinor: 149 }, { paymentFeeVatMinor: 1 }, { paymentFeeVatIncludedInPriceMinor: 1 }, { paymentFeeVatAddedToPriceMinor: 1 },
    { taxModes: ["exclusive", "exclusive"] }, { taxModes: ["inclusive", "exclusive"] }, { vatMinor: 1 }, { merchandiseNetMinor: -101 },
    { totalMinor: -1 }, { paymentFeeMinor: 1.5 }, { paymentFeeMinor: Number.MAX_SAFE_INTEGER + 1 }, { paymentFeeMinor: "150" },
    { bankCost: 1 },
  ])("rejects invalid signed fee/tax math: %j", patch => {
    expect(RecordedGrossCollectionComponentsV2Schema.safeParse({ ...components, ...patch }).success).toBe(false);
  });
  it.each([
    { bundleCoverage: { validEvents: 0, totalEvents: 1 } }, { recordedGrossCollectionsMinor: 51 }, { postedChargeEventCount: 0 },
    { dailyRecordedGrossCollectionsSeries: [{ localDate: "2026-10-27", recordedGrossCollectionsMinor: 49 }] },
    { currencyCode: "USD", minorUnitExponent: 2 }, { minorUnitExponent: 2 },
    { components: { ...components, totalMinor: 51 } }, { unexpected: "not-a-field" },
  ])("keeps exact bundle/headline/daily validation shared with V1: %j", patch => {
    expect(RecordedGrossCollectionCurrencyV2Schema.safeParse({ ...currency, ...patch }).success).toBe(false);
  });
  it.each([
    { schemaVersion: 1 }, { aggregateReadSource: "payment_entries" }, { currencies: [currency, currency] },
    { currencies: [currency, { ...currency, currencyCode: "USD", dailyRecordedGrossCollectionsSeries: [{ localDate: "2026-10-26", recordedGrossCollectionsMinor: 50 }] }] },
  ])("rejects source/version/identity drift: %j", patch => {
    expect(RecordedGrossCollectionSliceV2Schema.safeParse({ ...slice, ...patch }).success).toBe(false);
  });
});
