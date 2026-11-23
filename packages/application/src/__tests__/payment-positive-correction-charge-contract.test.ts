import { describe, expect, it } from "vitest";
import {
  PositiveCorrectionChargeContractValidationErrorV1,
  buildPositiveCorrectionChargeContractV1,
} from "../services/payment-positive-correction-charge-contract";

const before = {
  taxMode: "inclusive" as const,
  merchandiseGrossMinor: 100_000,
  discountMinor: 10_000,
  merchandiseNetMinor: 90_000,
  shippingMinor: 10_000,
  merchandiseVatMinor: 8_182,
  shippingVatMinor: 909,
  vatMinor: 9_091,
  unclassifiedMinor: 0,
  totalMinor: 100_000,
};

const afterDiscountRemoval = {
  taxMode: "inclusive" as const,
  merchandiseGrossMinor: 100_000,
  discountMinor: 0,
  merchandiseNetMinor: 100_000,
  shippingMinor: 10_000,
  merchandiseVatMinor: 9_091,
  shippingVatMinor: 909,
  vatMinor: 10_000,
  unclassifiedMinor: 0,
  totalMinor: 110_000,
};

const input = {
  merchantId: "merchant-a",
  storeId: "store-a",
  orderId: "order-a",
  correctionId: "correction-a-1",
  baseCommercialRevisionId: "revision-a-0",
  baseCommercialRevision: 0,
  effectiveCommercialRevisionId: "revision-a-1",
  effectiveCommercialRevision: 1,
  currencyCode: "VND",
  minorUnitExponent: 0,
  sourceOccurredAt: "2026-08-06T05:00:00.000Z",
  beforeComponents: before,
  effectiveComponents: afterDiscountRemoval,
};

describe("PAY-CORR-01 positive-correction charge contract", () => {
  it("creates a strictly positive correction charge from a zero commercial base",()=>{
    const zero={...before,merchandiseGrossMinor:0,discountMinor:0,merchandiseNetMinor:0,shippingMinor:0,
      merchandiseVatMinor:0,shippingVatMinor:0,vatMinor:0,totalMinor:0};
    expect(buildPositiveCorrectionChargeContractV1({...input,beforeComponents:zero}).componentDelta.totalMinor).toBe(110000);
    expect(()=>buildPositiveCorrectionChargeContractV1({...input,beforeComponents:zero,effectiveComponents:zero}))
      .toThrow(PositiveCorrectionChargeContractValidationErrorV1);
  });
  it("keeps a negative discount delta while allocating the positive headline exactly once", () => {
    const result = buildPositiveCorrectionChargeContractV1(input);

    expect(result).toMatchObject({
      schemaVersion: 1,
      sourceType: "order_correction",
      sourceId: "correction-a-1",
      roundingPolicy: "persisted_minor_snapshot_difference_no_recalculation",
      componentDelta: {
        taxMode: "inclusive",
        merchandiseGrossMinor: 0,
        discountMinor: -10_000,
        merchandiseNetMinor: 10_000,
        merchandiseVatMinor: 909,
        shippingVatMinor: 0,
        vatMinor: 909,
        vatIncludedInPriceMinor: 909,
        vatAddedToPriceMinor: 0,
        totalMinor: 10_000,
      },
      collectionAllocation: {
        allocationKind: "collection",
        amountMinor: 10_000,
        componentAttribution: "signed_commercial_delta",
      },
    });
    expect(result.componentDelta.discountMinor).toBeLessThan(0);
    expect(result.collectionAllocation.amountMinor).toBeGreaterThan(0);
    expect(result.contractFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.contractFingerprint).toBe("46a5f863c1f482c411b57b89400face86cd18e7957aa8e33df8a7f804b036ef6");
  });

  it("preserves mixed negative and positive components instead of hiding the net in unclassified", () => {
    const result = buildPositiveCorrectionChargeContractV1({
      ...input,
      effectiveComponents: {
        ...afterDiscountRemoval,
        merchandiseGrossMinor: 120_000,
        merchandiseNetMinor: 120_000,
        shippingMinor: 5_000,
        merchandiseVatMinor: 10_909,
        shippingVatMinor: 455,
        vatMinor: 11_364,
        unclassifiedMinor: 2_000,
        totalMinor: 127_000,
      },
    });

    expect(result.componentDelta).toMatchObject({
      merchandiseGrossMinor: 20_000,
      discountMinor: -10_000,
      merchandiseNetMinor: 30_000,
      shippingMinor: -5_000,
      merchandiseVatMinor: 2_727,
      shippingVatMinor: -454,
      vatMinor: 2_273,
      unclassifiedMinor: 2_000,
      totalMinor: 27_000,
    });
    expect(result.collectionAllocation.amountMinor).toBe(27_000);
  });

  it("adds exclusive VAT once and records it separately from inclusive VAT attribution", () => {
    const exclusiveBefore = {
      ...before,
      taxMode: "exclusive" as const,
      merchandiseGrossMinor: 90_000,
      discountMinor: 0,
      merchandiseNetMinor: 90_000,
      shippingMinor: 10_000,
      merchandiseVatMinor: 9_000,
      shippingVatMinor: 1_000,
      vatMinor: 10_000,
      totalMinor: 110_000,
    };
    const result = buildPositiveCorrectionChargeContractV1({
      ...input,
      beforeComponents: exclusiveBefore,
      effectiveComponents: {
        ...exclusiveBefore,
        merchandiseGrossMinor: 100_000,
        merchandiseNetMinor: 100_000,
        merchandiseVatMinor: 10_000,
        vatMinor: 11_000,
        totalMinor: 121_000,
      },
    });

    expect(result.componentDelta).toMatchObject({
      merchandiseNetMinor: 10_000,
      vatMinor: 1_000,
      vatIncludedInPriceMinor: 0,
      vatAddedToPriceMinor: 1_000,
      totalMinor: 11_000,
    });
    expect(result.collectionAllocation.amountMinor).toBe(11_000);
  });

  it("rejects tax-mode transitions because one signed allocation cannot prove two tax bases", () => {
    expect(() => buildPositiveCorrectionChargeContractV1({
      ...input,
      effectiveComponents: {
        ...afterDiscountRemoval,
        taxMode: "exclusive",
        totalMinor: 120_000,
      },
    })).toThrow(PositiveCorrectionChargeContractValidationErrorV1);
  });

  it("rejects zero and negative correction headlines without authorizing refund or payable behavior", () => {
    for (const effectiveComponents of [
      before,
      {
        ...before,
        merchandiseGrossMinor: 90_000,
        merchandiseNetMinor: 80_000,
        merchandiseVatMinor: 7_273,
        vatMinor: 8_182,
        totalMinor: 90_000,
      },
    ]) {
      expect(() => buildPositiveCorrectionChargeContractV1({
        ...input,
        effectiveComponents,
      })).toThrow(PositiveCorrectionChargeContractValidationErrorV1);
    }
  });

  it("rejects malformed component arithmetic, revision, currency, time and scope", () => {
    const invalid = [
      { ...input, merchantId: " merchant-a" },
      { ...input, effectiveCommercialRevision: 2 },
      { ...input, effectiveCommercialRevisionId: input.baseCommercialRevisionId },
      { ...input, currencyCode: "USD" },
      { ...input, minorUnitExponent: 2 },
      { ...input, sourceOccurredAt: "2026-08-06" },
      {
        ...input,
        effectiveComponents: {
          ...afterDiscountRemoval,
          totalMinor: 109_999,
        },
      },
    ];

    for (const value of invalid) {
      expect(() => buildPositiveCorrectionChargeContractV1(value as never)).toThrow(
        PositiveCorrectionChargeContractValidationErrorV1,
      );
    }
  });

  it("fingerprints exact revision/component lineage and defensively copies caller input", () => {
    const mutable = structuredClone(input);
    const first = buildPositiveCorrectionChargeContractV1(mutable);
    mutable.effectiveComponents.discountMinor = 1;
    mutable.effectiveComponents.merchandiseNetMinor = 99_999;

    expect(first.effectiveComponents).toEqual(afterDiscountRemoval);
    expect(buildPositiveCorrectionChargeContractV1(structuredClone(input))).toEqual(first);

    const changed = buildPositiveCorrectionChargeContractV1({
      ...input,
      correctionId: "correction-a-2",
    });
    expect(changed.contractFingerprint).not.toBe(first.contractFingerprint);
  });
});
