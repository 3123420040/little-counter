import { describe, expect, it } from "vitest";
import {
  buildPositiveCorrectionChargeContractV1,
  buildPositiveCorrectionChargeContractV2,
} from "../services/payment-positive-correction-charge-contract";

const before = {
  taxMode: "inclusive" as const,
  merchandiseGrossMinor: 240_000,
  discountMinor: 24_000,
  merchandiseNetMinor: 216_000,
  shippingMinor: 20_000,
  merchandiseVatMinor: 19_636,
  shippingVatMinor: 1_818,
  paymentFeeMinor: 4_320,
  paymentFeeVatMinor: 393,
  vatMinor: 21_847,
  unclassifiedMinor: 0,
  totalMinor: 240_320,
};
const input = {
  merchantId: "merchant-a",
  storeId: "store-a",
  orderId: "order-a",
  correctionId: "correction-a",
  baseCommercialRevisionId: "revision-a-0",
  baseCommercialRevision: 0,
  effectiveCommercialRevisionId: "revision-a-1",
  effectiveCommercialRevision: 1,
  currencyCode: "VND",
  minorUnitExponent: 0,
  sourceOccurredAt: "2026-10-26T00:00:00.000Z",
  beforeComponents: before,
};

describe("V2 positive correction fee lineage", () => {
  it("retains negative shipping and fee components under a positive correction headline", () => {
    const effectiveComponents = {
      ...before,
      merchandiseGrossMinor: 480_000,
      discountMinor: 48_000,
      merchandiseNetMinor: 432_000,
      shippingMinor: 10_000,
      merchandiseVatMinor: 39_273,
      shippingVatMinor: 909,
      paymentFeeMinor: 0,
      paymentFeeVatMinor: 0,
      vatMinor: 40_182,
      totalMinor: 442_000,
    };
    const result = buildPositiveCorrectionChargeContractV2({
      ...input,
      effectiveComponents,
    });
    expect(result).toMatchObject({
      schemaVersion: 2,
      componentDelta: {
        merchandiseNetMinor: 216_000,
        shippingMinor: -10_000,
        paymentFeeMinor: -4_320,
        paymentFeeVatMinor: -393,
        vatMinor: 18_335,
        totalMinor: 201_680,
      },
      collectionAllocation: { amountMinor: 201_680 },
    });
    expect(result.beforeComponents).toEqual(before);
    expect(result.effectiveComponents).toEqual(effectiveComponents);
    expect(result.contractFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it("allows fee-only positive correction without inventing a merchandise delta", () => {
    const result = buildPositiveCorrectionChargeContractV2({
      ...input,
      effectiveComponents: {
        ...before,
        paymentFeeMinor: 5_000,
        paymentFeeVatMinor: 455,
        vatMinor: 21_909,
        totalMinor: 241_000,
      },
    });
    expect(result.componentDelta).toMatchObject({
      merchandiseNetMinor: 0,
      shippingMinor: 0,
      paymentFeeMinor: 680,
      paymentFeeVatMinor: 62,
      vatMinor: 62,
      vatIncludedInPriceMinor: 62,
      vatAddedToPriceMinor: 0,
      totalMinor: 680,
    });
  });
  it("includes exclusive VAT on the fee delta once", () => {
    const exclusive = {
      ...before,
      taxMode: "exclusive" as const,
      merchandiseVatMinor: 21_600,
      shippingVatMinor: 2_000,
      paymentFeeVatMinor: 432,
      vatMinor: 24_032,
      totalMinor: 264_352,
    };
    const result = buildPositiveCorrectionChargeContractV2({
      ...input,
      beforeComponents: exclusive,
      effectiveComponents: {
        ...exclusive,
        paymentFeeMinor: 5_000,
        paymentFeeVatMinor: 500,
        vatMinor: 24_100,
        totalMinor: 265_100,
      },
    });
    expect(result.componentDelta).toMatchObject({
      paymentFeeMinor: 680,
      paymentFeeVatMinor: 68,
      vatMinor: 68,
      vatIncludedInPriceMinor: 0,
      vatAddedToPriceMinor: 68,
      totalMinor: 748,
    });
    expect(result.collectionAllocation.amountMinor).toBe(748);
  });
  it("keeps V1 strict and rejects invalid V2 lineage instead of coercing it", () => {
    expect(() =>
      buildPositiveCorrectionChargeContractV1({
        ...input,
        effectiveComponents: before,
      }),
    ).toThrow();
    for (const effectiveComponents of [
      before,
      { ...before, paymentFeeMinor: 5_000, totalMinor: 241_001 },
      {
        ...before,
        paymentFeeMinor: 5_000,
        paymentFeeVatMinor: 456,
        vatMinor: 21_909,
        totalMinor: 241_000,
      },
      { ...before, paymentFeeMinor: Number.MAX_SAFE_INTEGER + 1 },
      { ...before, taxMode: "exclusive" as const, totalMinor: 262_167 },
    ]) {
      expect(() =>
        buildPositiveCorrectionChargeContractV2({
          ...input,
          effectiveComponents,
        }),
      ).toThrow();
    }
  });
});
