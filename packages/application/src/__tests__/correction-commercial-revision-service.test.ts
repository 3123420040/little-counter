import { describe, expect, it } from "vitest";
import {
  createCorrectionCommercialRevisionTaskV1,
  type CorrectionCommercialRevisionRepositoryV1,
  type NormalizedCorrectionCommercialRevisionV1,
} from "../services/correction-commercial-revision-service";

const input = {
  merchantId: "merchant-a",
  storeId: "store-a",
  orderId: "order-a",
  correctionId: "correction-a-1",
  revision: 1,
  sourceOccurredAt: "2026-08-06T12:00:00.000Z",
  currencyCode: "VND" as const,
  minorUnitExponent: 0 as const,
  taxMode: "inclusive" as const,
  beforeTotals: {
    subtotal: 100_000,
    discount: 10_000,
    merchandisePayable: 90_000,
    shippingFee: 10_000,
    merchandiseTax: 8_182,
    shippingTax: 909,
    tax: 9_091,
    total: 100_000,
  },
  afterTotals: {
    subtotal: 120_000,
    discount: 10_000,
    merchandisePayable: 110_000,
    shippingFee: 5_000,
    merchandiseTax: 10_000,
    shippingTax: 455,
    tax: 10_455,
    total: 115_000,
  },
  lines: [
    {
      variantId: "variant-b",
      productId: "product-b",
      skuSnapshot: "SKU-B",
      titleSnapshot: "Product B",
      quantity: 1,
      unitPriceMinor: 20_000,
    },
    {
      variantId: "variant-a",
      productId: "product-a",
      skuSnapshot: "SKU-A",
      titleSnapshot: "Product A",
      quantity: 2,
      unitPriceMinor: 50_000,
    },
  ],
};

class MemoryRepository implements CorrectionCommercialRevisionRepositoryV1 {
  bundles: NormalizedCorrectionCommercialRevisionV1[] = [];

  async appendCorrectionRevision(bundle: NormalizedCorrectionCommercialRevisionV1) {
    this.bundles.push(structuredClone(bundle));
    return {
      outcome: "inserted" as const,
      bundleFingerprint: bundle.bundleFingerprint,
      merchantId: bundle.merchantId,
      storeId: bundle.storeId,
      orderId: bundle.orderId,
      correctionId: bundle.correctionId,
      revisionId: "123e4567-e89b-42d3-a456-426614174000",
      revision: bundle.revision,
      idempotencyKey: bundle.idempotencyKey,
    };
  }
}

describe("correction commercial revision", () => {
  it("persists zero-valued corrected quantities without authorizing a payment",async()=>{
    const zero={subtotal:0,discount:0,merchandisePayable:0,shippingFee:0,merchandiseTax:0,shippingTax:0,tax:0,total:0};
    const repository=new MemoryRepository();
    const task=createCorrectionCommercialRevisionTaskV1({repository},{...input,beforeTotals:zero,afterTotals:zero,
      lines:input.lines.map(line=>({...line,unitPriceMinor:0}))});
    await expect(task.execute()).resolves.toMatchObject({outcome:"inserted",revision:1});
    expect(repository.bundles[0].components.totalMinor).toBe(0);
    expect(repository.bundles[0].lines).toHaveLength(2);
  });
  it("persists one deterministic effective snapshot for an applied correction", async () => {
    const repository = new MemoryRepository();
    const task = createCorrectionCommercialRevisionTaskV1({ repository }, input);

    const result = await task.execute();

    expect(result).toMatchObject({ outcome: "inserted", revision: 1 });
    expect(repository.bundles).toHaveLength(1);
    expect(repository.bundles[0]).toMatchObject({
      sourceType: "order_correction",
      sourceId: "correction-a-1",
      correctionId: "correction-a-1",
      revision: 1,
      commercialState: "active",
      components: {
        merchandiseGrossMinor: 120_000,
        discountMinor: 10_000,
        merchandiseNetMinor: 110_000,
        shippingMinor: 5_000,
        merchandiseVatMinor: 10_000,
        shippingVatMinor: 455,
        vatMinor: 10_455,
        totalMinor: 115_000,
      },
      lines: [
        { lineKey: "variant:variant-a", quantity: 2, lineTotalMinor: 100_000 },
        { lineKey: "variant:variant-b", quantity: 1, lineTotalMinor: 20_000 },
      ],
    });
    expect(repository.bundles[0]!.bundleFingerprint).toBe("4dc72e284a5b0a20202761c5593561d8ef1016ee91693bb8b5bf4f1819c39594");
  });

  it("rejects a forged total, invalid revision and duplicate variant", () => {
    const repository = new MemoryRepository();
    for (const invalid of [
      { ...input, afterTotals: { ...input.afterTotals, total: 114_999 } },
      { ...input, revision: 0 },
      { ...input, lines: [input.lines[0], input.lines[0]] },
    ]) {
      expect(() => createCorrectionCommercialRevisionTaskV1({ repository }, invalid))
        .toThrow();
    }
  });

  it("defensively copies caller input before persistence", async () => {
    const repository = new MemoryRepository();
    const mutable = structuredClone(input);
    const task = createCorrectionCommercialRevisionTaskV1({ repository }, mutable);
    mutable.lines[0]!.quantity = 99;
    mutable.afterTotals.total = 1;

    await task.execute();

    expect(repository.bundles[0]!.components.totalMinor).toBe(115_000);
    expect(repository.bundles[0]!.lines.find((line) => line.variantId === "variant-b")?.quantity)
      .toBe(1);
  });
});
