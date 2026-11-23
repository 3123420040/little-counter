import { describe, expect, it } from "vitest";
import { createPaymentChargeBundleTaskV2, assertNormalizedPaymentChargeBundleV2,
  type NormalizedPaymentChargeBundleV2 } from "../services/payment-charge-bundle-service";

const input = {
  merchantId: "merchant-a", storeId: "store-a", orderId: "order-a", commercialRevisionId: "revision-a",
  commercialRevision: 0, currencyCode: "VND", minorUnitExponent: 0, method: "provider" as const, status: "pending" as const,
  components: { taxMode: "inclusive" as const, merchandiseGrossMinor: 240_000, discountMinor: 24_000,
    merchandiseNetMinor: 216_000, shippingMinor: 20_000, paymentFeeMinor: 4_320, merchandiseVatMinor: 19_636,
    shippingVatMinor: 1_818, paymentFeeVatMinor: 393, vatMinor: 21_847, unclassifiedMinor: 0, totalMinor: 240_320 },
  idempotencyKey: "charge-fee-a", sourceType: "order_created", sourceId: "order-a", sourceOccurredAt: "2026-10-25T00:00:00.000Z",
};
describe("V2 charge bundle", () => {
  it.each(["pending", "posted"] as const)("records exact %s headline and fee allocation", async (status) => {
    let captured: NormalizedPaymentChargeBundleV2 | undefined;
    const task = createPaymentChargeBundleTaskV2({ config: { enabled: true }, repository: {
      appendChargeBundle: async (bundle) => {
        captured = bundle;
        return { outcome: "inserted", bundleFingerprint: bundle.bundleFingerprint, merchantId: bundle.merchantId,
          storeId: bundle.storeId, orderId: bundle.orderId, commercialRevisionId: bundle.commercialRevisionId,
          eventIdempotencyKey: bundle.event.idempotencyKey, obligationId: "obligation-a", paymentEventId: "event-a" };
      },
    } }, { ...input, status, method: status === "posted" ? "cod" : "provider", evidence: status === "posted"
      ? { evidenceType: "cod_order_created", evidenceFingerprint: "a".repeat(64), sourceSystem: "fixture", sourceReference: "order-a" } : undefined });
    if (!task.enabled) throw new Error("expected enabled task");
    expect(await task.execute()).toMatchObject({ amountMinor: 240_320, status });
    expect(captured).toMatchObject({ bundleVersion: 2, event: { amountMinor: 240_320 }, obligation: { amountMinor: 240_320 },
      componentAllocation: { paymentFeeMinor: 4_320, paymentFeeVatMinor: 393 } });
    expect(assertNormalizedPaymentChargeBundleV2(captured!)).toEqual(captured);
    const changed = structuredClone(captured!);
    changed.componentAllocation.paymentFeeMinor += 1;
    expect(() => assertNormalizedPaymentChargeBundleV2(changed)).toThrow("identity drift");
  });
});
