import { describe, expect, it } from "vitest";
import { createOriginalOrderCommercialRevisionTaskV2, assertNormalizedOriginalOrderCommercialRevisionV2,
  type OriginalOrderCommercialRevisionInputV2 } from "../services/original-order-commercial-revision-service";

const input: OriginalOrderCommercialRevisionInputV2 = {
  merchantId: "merchant-a", storeId: "store-a", orderId: "fee-order-a", orderCreatedInCurrentTransaction: true,
  currencyCode: "VND", minorUnitExponent: 0, sourceOccurredAt: "2026-10-25T00:00:00.000Z",
  totals: { taxMode: "inclusive", vatRatePpm: 100_000, commercialCalculationVersion: 2,
    subtotalMinor: 240_000, discountMinor: 24_000, merchandisePayableMinor: 216_000,
    shippingMinor: 20_000, merchandiseVatMinor: 19_636, shippingVatMinor: 1_818,
    vatMinor: 21_847, unclassifiedMinor: 0, totalMinor: 240_320,
    paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 216_000,
    paymentFeeMinor: 4_320, paymentFeeVatMinor: 393 },
  lines: [{ lineKey: "line-a", sourceLineId: "source-a", productId: "product-a", variantId: "variant-a",
    skuSnapshot: "SKU-A", titleSnapshot: "Fixture", archivedVariant: false, quantity: 1,
    unitPriceMinor: 240_000, unitCostMinor: 50_000, costEvidenceId: "fixture-cost" }],
};
const repository = { appendOriginalRevision: async () => { throw new Error("validation must precede writes"); } };
function taskFor(value = input) {
  const task = createOriginalOrderCommercialRevisionTaskV2({ config: { enabled: true }, repository }, value);
  if (!task.enabled) throw new Error("expected enabled task");
  return task;
}
describe("V2 original revision with authoritative fee lineage", () => {
  it("freezes O1 descriptor, basis, tax context and separate fee component", () => {
    const task = taskFor();
    expect(task.bundle).toMatchObject({ bundleVersion: 2, commercialCalculationVersion: 2, vatRatePpm: 100_000,
      paymentFee: { paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 216_000 },
      components: { paymentFeeMinor: 4_320, paymentFeeVatMinor: 393, totalMinor: 240_320 } });
    expect(assertNormalizedOriginalOrderCommercialRevisionV2(task.bundle)).toEqual(task.bundle);
    const changed = structuredClone(task.bundle);
    changed.paymentFee.paymentFeeValue = 3;
    expect(() => assertNormalizedOriginalOrderCommercialRevisionV2(changed)).toThrow();
  });
  it.each([
    { paymentFeeBasisMinor: 236_000 }, { paymentFeeMinor: 4_720, totalMinor: 240_720 },
    { paymentFeeVatMinor: 392, vatMinor: 21_846 }, { paymentFeeValue: 2.001 },
    { merchandiseVatMinor: 19_635, vatMinor: 21_846 },
    { shippingVatMinor: 1_817, vatMinor: 21_846 },
    { commercialCalculationVersion: 1 }, { paymentFeeMinor: 0 },
  ])("rejects forged resolved fields before writes %j", (change) => {
    expect(() => taskFor({ ...input, totals: { ...input.totals, ...change } } as OriginalOrderCommercialRevisionInputV2)).toThrow();
  });
  it("retains default-off behaviour without validating or writing", () => {
    expect(createOriginalOrderCommercialRevisionTaskV2({ repository }, {} as OriginalOrderCommercialRevisionInputV2))
      .toEqual({ enabled: false, status: "disabled" });
  });
});
