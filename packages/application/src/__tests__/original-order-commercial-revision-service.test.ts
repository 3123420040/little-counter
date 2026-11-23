import { describe, expect, it } from "vitest";
import {
  OriginalOrderCommercialRevisionValidationErrorV1,
  createOriginalOrderCommercialRevisionTaskV1,
  type NormalizedOriginalOrderCommercialRevisionV1,
  type OriginalOrderCommercialRevisionInputV1,
  type OriginalOrderCommercialRevisionRepositoryV1,
} from "../services/original-order-commercial-revision-service";

const inclusiveInput: OriginalOrderCommercialRevisionInputV1 = {
  merchantId: "merchant-a",
  storeId: "store-a",
  orderId: "order-a",
  orderCreatedInCurrentTransaction: true,
  currencyCode: "VND",
  minorUnitExponent: 0,
  sourceOccurredAt: "2026-08-05T04:00:00.000Z",
  totals: {
    taxMode: "inclusive",
    vatRatePpm: 100_000,
    commercialCalculationVersion: 1,
    subtotalMinor: 110_000,
    discountMinor: 0,
    merchandisePayableMinor: 110_000,
    shippingMinor: 11_000,
    merchandiseVatMinor: 10_000,
    shippingVatMinor: 1_000,
    vatMinor: 11_000,
    unclassifiedMinor: 2_000,
    totalMinor: 123_000,
  },
  lines: [
    {
      lineKey: "line-b",
      sourceLineId: "source-b",
      productId: "product-b",
      variantId: "variant-b",
      skuSnapshot: "SKU-B",
      titleSnapshot: "Product B",
      archivedVariant: false,
      quantity: 1,
      unitPriceMinor: 10_000,
      unitCostMinor: 5_000,
      costEvidenceId: "catalog-cost:variant-b:2026-08-05T04:00:00.000Z",
    },
    {
      lineKey: "line-a",
      sourceLineId: "source-a",
      productId: "product-a",
      variantId: "variant-a",
      skuSnapshot: "SKU-A",
      titleSnapshot: "Product A",
      archivedVariant: false,
      quantity: 1,
      unitPriceMinor: 100_000,
      unitCostMinor: 50_000,
      costEvidenceId: "catalog-cost:variant-a:2026-08-05T04:00:00.000Z",
    },
  ],
};

class MemoryRepository implements OriginalOrderCommercialRevisionRepositoryV1 {
  calls: NormalizedOriginalOrderCommercialRevisionV1[] = [];

  async appendOriginalRevision(bundle: NormalizedOriginalOrderCommercialRevisionV1) {
    this.calls.push(structuredClone(bundle));
    return {
      outcome: "inserted" as const,
      bundleFingerprint: bundle.bundleFingerprint,
      merchantId: bundle.merchantId,
      storeId: bundle.storeId,
      orderId: bundle.orderId,
      revisionId: "00000000-0000-4000-8000-000000000101",
      revision: 0 as const,
      idempotencyKey: bundle.idempotencyKey,
    };
  }
}

function enabledTask(
  input: OriginalOrderCommercialRevisionInputV1 = inclusiveInput,
  repository = new MemoryRepository(),
) {
  const task = createOriginalOrderCommercialRevisionTaskV1(
    { config: { enabled: true }, repository },
    input,
  );
  if (!task.enabled) throw new Error("expected enabled task");
  return { task, repository };
}

describe("ORD-REV-01 original-order commercial snapshot contract", () => {
  it("is default-off before inspecting input or repository", () => {
    expect(createOriginalOrderCommercialRevisionTaskV1(
      { repository: undefined as unknown as OriginalOrderCommercialRevisionRepositoryV1 },
      { ...inclusiveInput, merchantId: "" },
    )).toEqual({ enabled: false, status: "disabled" });
  });

  it("keeps inclusive VAT inside actual collection while preserving exact attribution", async () => {
    const { task, repository } = enabledTask();
    expect(task.bundle).toMatchObject({
      revision: 0,
      sourceType: "original_order",
      sourceId: "order-a",
      idempotencyKey: "order:order-a:commercial-revision:0",
      dataQuality: "complete",
      components: {
        taxMode: "inclusive",
        merchandiseGrossMinor: 110_000,
        merchandiseNetMinor: 110_000,
        shippingMinor: 11_000,
        merchandiseVatMinor: 10_000,
        shippingVatMinor: 1_000,
        vatMinor: 11_000,
        unclassifiedMinor: 2_000,
        totalMinor: 123_000,
      },
    });
    expect(task.bundle.lines.map((line) => line.lineKey)).toEqual(["line-a", "line-b"]);
    expect(task.bundle.bundleFingerprint).toBe("20761416056205e257424ca5e9b240322a718ce11075ddfd951ae7c892fe7be4");
    await expect(task.execute()).resolves.toMatchObject({
      outcome: "inserted",
      revision: 0,
      orderId: "order-a",
    });
    expect(repository.calls).toHaveLength(1);
  });

  it("persists a zero-value commercial snapshot with actual quantities and cost evidence", async () => {
    const input = structuredClone(inclusiveInput);
    for (const key of ["subtotalMinor","discountMinor","merchandisePayableMinor","shippingMinor",
      "merchandiseVatMinor","shippingVatMinor","vatMinor","unclassifiedMinor","totalMinor"] as const) input.totals[key]=0;
    input.lines.forEach(line => {line.unitPriceMinor=0;});
    const {task,repository}=enabledTask(input);
    expect(task.bundle.components.totalMinor).toBe(0);
    await expect(task.execute()).resolves.toMatchObject({outcome:"inserted",revision:0});
    expect(repository.calls[0].lines).toHaveLength(2);
    for (const quantity of [0,-1,0.5]) {
      const invalid=structuredClone(input);invalid.lines[0].quantity=quantity;
      expect(()=>enabledTask(invalid)).toThrow(OriginalOrderCommercialRevisionValidationErrorV1);
    }
    for (const amount of [-1,0.5]) {
      const invalid=structuredClone(input);invalid.totals.totalMinor=amount;
      expect(()=>enabledTask(invalid)).toThrow(OriginalOrderCommercialRevisionValidationErrorV1);
    }
  });

  it("adds VAT exactly once for exclusive pricing", () => {
    const { task } = enabledTask({
      ...inclusiveInput,
      totals: {
        taxMode: "exclusive",
        vatRatePpm: 100_000,
        commercialCalculationVersion: 1,
        subtotalMinor: 110_000,
        discountMinor: 0,
        merchandisePayableMinor: 110_000,
        shippingMinor: 11_000,
        merchandiseVatMinor: 10_000,
        shippingVatMinor: 1_000,
        vatMinor: 11_000,
        unclassifiedMinor: 2_000,
        totalMinor: 134_000,
      },
    });
    expect(task.bundle.components.totalMinor).toBe(134_000);
  });

  it("rejects VAT double-count, VAT split drift and line/subtotal drift", () => {
    for (const input of [
      {
        ...inclusiveInput,
        totals: { ...inclusiveInput.totals, totalMinor: 134_000 },
      },
      {
        ...inclusiveInput,
        totals: { ...inclusiveInput.totals, shippingVatMinor: 999 },
      },
      {
        ...inclusiveInput,
        totals: { ...inclusiveInput.totals, subtotalMinor: 109_999 },
      },
    ]) {
      expect(() => enabledTask(input)).toThrow(
        OriginalOrderCommercialRevisionValidationErrorV1,
      );
    }
  });

  it("requires exact transaction provenance, integer money and complete cost evidence", () => {
    const invalid = [
      { ...inclusiveInput, orderCreatedInCurrentTransaction: false },
      {
        ...inclusiveInput,
        lines: [{ ...inclusiveInput.lines[0]!, unitPriceMinor: 0.5 }],
      },
      {
        ...inclusiveInput,
        lines: [{ ...inclusiveInput.lines[0]!, costEvidenceId: "" }, inclusiveInput.lines[1]!],
      },
    ];
    for (const input of invalid) {
      expect(() => enabledTask(
        input as OriginalOrderCommercialRevisionInputV1,
      )).toThrow(OriginalOrderCommercialRevisionValidationErrorV1);
    }
  });

  it("preserves an unknown historical cost as a paired null and marks the revision partial", () => {
    const unknownCostInput = {
      ...inclusiveInput,
      lines: [
        {
          ...inclusiveInput.lines[0]!,
          unitCostMinor: null,
          costEvidenceId: null,
        },
        inclusiveInput.lines[1]!,
      ],
    } as unknown as OriginalOrderCommercialRevisionInputV1;
    const { task } = enabledTask(unknownCostInput);
    expect(task.bundle.dataQuality).toBe("partial");
    expect(task.bundle.lines.find((line) => line.lineKey === "line-b")).toMatchObject({
      unitCostMinor: null,
      costEvidenceId: null,
    });

    for (const lines of [
      [{
        ...inclusiveInput.lines[0]!,
        unitCostMinor: null,
      }, inclusiveInput.lines[1]!],
      [{
        ...inclusiveInput.lines[0]!,
        costEvidenceId: null,
      }, inclusiveInput.lines[1]!],
    ]) {
      expect(() => enabledTask({
        ...inclusiveInput,
        lines,
      } as unknown as OriginalOrderCommercialRevisionInputV1)).toThrow(
        OriginalOrderCommercialRevisionValidationErrorV1,
      );
    }
  });

  it("produces one stable fingerprint and rejects a forged repository receipt", async () => {
    const first = enabledTask().task.bundle;
    const second = enabledTask({
      ...inclusiveInput,
      lines: [...inclusiveInput.lines].reverse(),
    }).task.bundle;
    expect(second.bundleFingerprint).toBe(first.bundleFingerprint);

    const repository = new MemoryRepository();
    repository.appendOriginalRevision = async (bundle) => ({
      outcome: "replayed",
      bundleFingerprint: "f".repeat(64),
      merchantId: bundle.merchantId,
      storeId: bundle.storeId,
      orderId: bundle.orderId,
      revisionId: "00000000-0000-4000-8000-000000000101",
      revision: 0,
      idempotencyKey: bundle.idempotencyKey,
    });
    await expect(enabledTask(inclusiveInput, repository).task.execute()).rejects.toThrow(
      "persisted original revision identity drift",
    );
  });
});
