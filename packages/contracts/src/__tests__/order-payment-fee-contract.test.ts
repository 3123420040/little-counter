import { describe, expect, it } from "vitest";
import { OrderCommercialComponentsV1Schema } from "../order-financial-correctness";
import { EffectiveOrderSurfaceV3Schema, EffectiveOrderV2Schema, OrderCommercialComponentsV2Schema, PaymentFeeInputV1Schema } from "../order-payment-fee";

const inclusive = {
  taxMode: "inclusive", merchandiseGrossMinor: 240_000, discountMinor: 24_000,
  merchandiseNetMinor: 216_000, shippingMinor: 20_000, paymentFeeMinor: 4_320,
  merchandiseVatMinor: 19_636, shippingVatMinor: 1_818, paymentFeeVatMinor: 393,
  vatMinor: 21_847, unclassifiedMinor: 0, totalMinor: 240_320,
};

const projection = {
  schemaVersion: 2, componentVersion: 2, orderId: "fee-order", currencyCode: "VND", minorUnitExponent: 0,
  effectiveRevision: 0, commercialState: "active",
  lines: [{ lineId: "line-1", productId: null, variantId: null, skuSnapshot: "SKU", titleSnapshot: "Item", quantity: 2, unitPriceMinor: 120_000 }],
  components: inclusive, currentOrderGrossValueMinor: 240_320,
  dataQuality: { status: "complete", costCoverage: { knownLines: 1, totalLines: 1 }, warnings: [] },
};

describe("strict fee-aware persisted order projection", () => {
  it("validates fee detail totals without counting the surcharge as an item", () => {
    const surface = { schemaVersion: 3, componentVersion: 2, surfaceKind: "detail", orderId: projection.orderId,
      currencyCode: projection.currencyCode, minorUnitExponent: 0, effectiveRevision: 0, commercialState: "active",
      effectiveItems: projection.lines.map((line) => ({ ...line, lineTotalMinor: 240_000 })), components: inclusive,
      effectiveCommercialTotalMinor: 240_320, currentOrderGrossValueMinor: 240_320, effectiveItemQuantity: 2, dataQuality: projection.dataQuality };
    expect(EffectiveOrderSurfaceV3Schema.safeParse(surface).success).toBe(true);
    for (const patch of [{ effectiveItemQuantity: 3 }, { effectiveCommercialTotalMinor: 236_000 },
      { components: { ...inclusive, paymentFeeMinor: 0 } }, { secret: "not-a-field" }]) {
      expect(EffectiveOrderSurfaceV3Schema.safeParse({ ...surface, ...patch }).success).toBe(false);
    }
  });
  it("keeps inclusive/exclusive VAT, cancellation and explicit-zero component version", () => {
    expect(EffectiveOrderV2Schema.parse(projection)).toEqual(projection);
    expect(EffectiveOrderV2Schema.safeParse({ ...projection, components: { ...inclusive, taxMode: "exclusive",
      merchandiseVatMinor: 21_600, shippingVatMinor: 2_000, paymentFeeVatMinor: 432,
      vatMinor: 24_032, totalMinor: 264_352 }, currentOrderGrossValueMinor: 264_352 }).success).toBe(true);
    expect(EffectiveOrderV2Schema.safeParse({ ...projection, commercialState: "cancelled", currentOrderGrossValueMinor: 0 }).success).toBe(true);
    for (const componentVersion of [1, 2]) expect(EffectiveOrderV2Schema.safeParse({ ...projection, componentVersion,
      components: { ...inclusive, paymentFeeMinor: 0, paymentFeeVatMinor: 0, vatMinor: 21_454, totalMinor: 236_000 },
      currentOrderGrossValueMinor: 236_000 }).success).toBe(true);
  });
  it.each([
    { componentVersion: 1 }, { currentOrderGrossValueMinor: 236_000 },
    { lines: [{ ...projection.lines[0], quantity: 1 }] },
    { dataQuality: { ...projection.dataQuality, costCoverage: { knownLines: 0, totalLines: 2 } } },
    { components: { ...inclusive, vatMinor: 21_848 } }, { componentVersion: 3 },
    { currencyCode: "USD" }, { minorUnitExponent: 2 },
    { secret: "not-a-projection-field" },
  ])("rejects malformed snapshots without relaxing common V1 invariants: %j", (patch) => {
    expect(EffectiveOrderV2Schema.safeParse({ ...projection, ...patch }).success).toBe(false);
  });
});

describe("fee-aware components without relaxing V1", () => {
  it("accepts O1 inclusive and O2 exclusive with three VAT components", () => {
    expect(OrderCommercialComponentsV2Schema.parse(inclusive)).toEqual(inclusive);
    expect(OrderCommercialComponentsV2Schema.parse({ ...inclusive, taxMode: "exclusive",
      merchandiseVatMinor: 21_600, shippingVatMinor: 2_000, paymentFeeVatMinor: 432,
      vatMinor: 24_032, totalMinor: 264_352 })).toMatchObject({ totalMinor: 264_352 });
  });
  it("keeps V1 strict and preserves fee-free field shape", () => {
    const { paymentFeeMinor, paymentFeeVatMinor, ...v1 } = inclusive;
    const legacy = { ...v1, vatMinor: 21_454, totalMinor: 236_000 };
    expect(OrderCommercialComponentsV1Schema.parse(legacy)).toEqual(legacy);
    expect(OrderCommercialComponentsV1Schema.safeParse(inclusive).success).toBe(false);
    expect(OrderCommercialComponentsV2Schema.safeParse(legacy).success).toBe(false);
    expect(OrderCommercialComponentsV2Schema.parse({ ...legacy, paymentFeeMinor: 0, paymentFeeVatMinor: 0 })).toMatchObject(legacy);
  });
  it.each([
    { totalMinor: 236_000 }, { vatMinor: 21_454 }, { paymentFeeMinor: -1 },
    { paymentFeeVatMinor: 4_321, vatMinor: 25_775 }, { paymentFeeMinor: 0.5 },
    { unknownComponent: 1 }, { merchandiseNetMinor: 216_001 },
    { totalMinor: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects inconsistent or unsafe components %j", (change) => {
    expect(OrderCommercialComponentsV2Schema.safeParse({ ...inclusive, ...change }).success).toBe(false);
  });
  it("accepts VAT zero, not a fallback tax rate", () => {
    expect(OrderCommercialComponentsV2Schema.parse({ ...inclusive,
      merchandiseVatMinor: 0, shippingVatMinor: 0, paymentFeeVatMinor: 0, vatMinor: 0 })).toMatchObject({ totalMinor: 240_320, vatMinor: 0 });
  });
});

describe("fee descriptor trust boundary", () => {
  it.each([0, 2, 2.01, 2.5, 100])("accepts percent %s", (paymentFeeValue) => {
    expect(PaymentFeeInputV1Schema.parse({ paymentFeeType: "percent", paymentFeeValue })).toEqual({ paymentFeeType: "percent", paymentFeeValue });
  });
  it.each([-1, 100.01, 0.001, NaN, Infinity])("rejects percent %s", (paymentFeeValue) => {
    expect(PaymentFeeInputV1Schema.safeParse({ paymentFeeType: "percent", paymentFeeValue }).success).toBe(false);
  });
  it.each([0, 10_000, Number.MAX_SAFE_INTEGER])("accepts fixed integer %s", (paymentFeeValue) => {
    expect(PaymentFeeInputV1Schema.parse({ paymentFeeType: "amount", paymentFeeValue })).toEqual({ paymentFeeType: "amount", paymentFeeValue });
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])("rejects fixed amount %s", (paymentFeeValue) => {
    expect(PaymentFeeInputV1Schema.safeParse({ paymentFeeType: "amount", paymentFeeValue }).success).toBe(false);
  });
  it("does not default an absent descriptor or accept resolved fields", () => {
    expect(PaymentFeeInputV1Schema.safeParse({}).success).toBe(false);
    expect(PaymentFeeInputV1Schema.safeParse({ paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeMinor: 4_320 }).success).toBe(false);
  });
});
