import { describe, expect, it } from "vitest";
import { createCorrectionCommercialRevisionTaskV2, assertNormalizedCorrectionCommercialRevisionV2,
  type CorrectionCommercialRevisionInputV2 } from "../services/correction-commercial-revision-service";

const input: CorrectionCommercialRevisionInputV2 = {
  merchantId: "merchant-a", storeId: "store-a", orderId: "order-a", correctionId: "correction-a",
  revision: 1, sourceOccurredAt: "2026-10-26T00:00:00.000Z", currencyCode: "VND", minorUnitExponent: 0,
  taxMode: "inclusive", vatRatePpm: 100_000,
  beforeTotals: { subtotal: 240_000, discount: 24_000, merchandisePayable: 216_000, shippingFee: 20_000,
    merchandiseTax: 19_636, shippingTax: 1_818, tax: 21_847, total: 240_320,
    paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 216_000, paymentFeeMinor: 4_320, paymentFeeVatMinor: 393 },
  afterTotals: { subtotal: 360_000, discount: 24_000, merchandisePayable: 336_000, shippingFee: 5_000,
    merchandiseTax: 30_545, shippingTax: 455, tax: 31_611, total: 347_720,
    paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 336_000, paymentFeeMinor: 6_720, paymentFeeVatMinor: 611 },
  lines: [{ variantId: "variant-a", productId: "product-a", skuSnapshot: "SKU-A", titleSnapshot: "Fixture", quantity: 1, unitPriceMinor: 360_000 }],
};
const repository = { appendCorrectionRevision: async () => { throw new Error("no write during normalization"); } };
describe("fee-aware correction revision", () => {
  it("freezes both fee snapshots for a positive correction with reduced shipping", () => {
    const task = createCorrectionCommercialRevisionTaskV2({ repository }, input);
    expect(task.bundle).toMatchObject({ bundleVersion: 2, commercialCalculationVersion: 2, vatRatePpm: 100_000,
      baseComponents: { shippingMinor: 20_000, paymentFeeMinor: 4_320, paymentFeeVatMinor: 393, totalMinor: 240_320 },
      components: { shippingMinor: 5_000, paymentFeeMinor: 6_720, paymentFeeVatMinor: 611, totalMinor: 347_720 },
      paymentFee: { paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 336_000 } });
    expect(assertNormalizedCorrectionCommercialRevisionV2(task.bundle)).toEqual(task.bundle);
    const changed = structuredClone(task.bundle);
    changed.basePaymentFee.paymentFeeValue = 3;
    expect(() => assertNormalizedCorrectionCommercialRevisionV2(changed)).toThrow();
  });
  it.each(["beforeTotals", "afterTotals"] as const)("rejects a forged %s fee before writing", (side) => {
    expect(() => createCorrectionCommercialRevisionTaskV2({ repository }, {
      ...input, [side]: { ...input[side], paymentFeeBasisMinor: input[side].merchandisePayable + input[side].shippingFee },
    })).toThrow(/fee.*drift/);
  });
  it("rejects forged VAT context even when total and VAT attribution balance", () => {
    expect(() => createCorrectionCommercialRevisionTaskV2({ repository }, { ...input,
      afterTotals: { ...input.afterTotals, merchandiseTax: 30_544, tax: 31_610 },
    })).toThrow(/VAT/);
  });
});
