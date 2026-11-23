import { describe, expect, it, vi } from "vitest";
import {
  PaymentChargeBundleIntegrityErrorV1,
  PaymentChargeBundleValidationErrorV1,
  createPaymentChargeBundleTaskV1,
  type NormalizedPaymentChargeBundleV1,
  type PaymentChargeBundleRepositoryV1,
  type PersistedPaymentChargeBundleV1,
} from "../services/payment-charge-bundle-service";

const input = {
  merchantId: "merchant-a",
  storeId: "store-a",
  orderId: "order-a",
  commercialRevisionId: "revision-a-1",
  commercialRevision: 1,
  currencyCode: "VND",
  minorUnitExponent: 0,
  method: "cod" as const,
  status: "posted" as const,
  components: {
    taxMode: "exclusive" as const,
    merchandiseGrossMinor: 10_000,
    discountMinor: 1_000,
    merchandiseNetMinor: 9_000,
    shippingMinor: 2_000,
    merchandiseVatMinor: 900,
    shippingVatMinor: 0,
    vatMinor: 900,
    unclassifiedMinor: 100,
    totalMinor: 12_000,
  },
  evidence: {
    evidenceType: "cod_order_created" as const,
    evidenceFingerprint: "a".repeat(64),
    sourceSystem: "order_service",
    sourceReference: "order-a:create:1",
  },
  idempotencyKey: "payment:order-a:create:1",
  sourceType: "order_created",
  sourceId: "order-a:create:1",
  sourceOccurredAt: "2026-08-05T00:00:00.000Z",
};

class MemoryRepository implements PaymentChargeBundleRepositoryV1 {
  readonly calls: NormalizedPaymentChargeBundleV1[] = [];
  private readonly records = new Map<string, PersistedPaymentChargeBundleV1>();

  async appendChargeBundle(
    bundle: NormalizedPaymentChargeBundleV1,
  ): Promise<PersistedPaymentChargeBundleV1> {
    this.calls.push(bundle);
    const key = `${bundle.merchantId}\0${bundle.storeId}\0${bundle.event.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing) return { ...existing, outcome: "replayed" };
    const stored: PersistedPaymentChargeBundleV1 = {
      outcome: "inserted",
      bundleFingerprint: bundle.bundleFingerprint,
      merchantId: bundle.merchantId,
      storeId: bundle.storeId,
      orderId: bundle.orderId,
      commercialRevisionId: bundle.commercialRevisionId,
      eventIdempotencyKey: bundle.event.idempotencyKey,
      obligationId: `obl-${this.records.size + 1}`,
      paymentEventId: `evt-${this.records.size + 1}`,
    };
    this.records.set(key, stored);
    return stored;
  }
}

describe("PAY-01A inactive payment charge/obligation bundle", () => {
  it("is disabled by default before validation and repository access", () => {
    const repository = new MemoryRepository();
    const task = createPaymentChargeBundleTaskV1({ repository }, {
      ...input,
      merchantId: "",
    });

    expect(task).toEqual({ enabled: false, status: "disabled" });
    expect(repository.calls).toHaveLength(0);
  });

  it("builds one exact posted COD obligation/event/evidence/component/allocation bundle", async () => {
    const repository = new MemoryRepository();
    const mutable = structuredClone(input);
    const task = createPaymentChargeBundleTaskV1(
      { config: { enabled: true }, repository },
      mutable,
    );
    if (!task.enabled) throw new Error("expected enabled task");
    mutable.components.vatMinor = 999;

    await expect(task.execute()).resolves.toMatchObject({
      kind: "recorded",
      outcome: "inserted",
      obligationId: "obl-1",
      paymentEventId: "evt-1",
      amountMinor: 12_000,
      status: "posted",
      method: "cod",
    });
    expect(repository.calls).toHaveLength(1);
    const bundle = repository.calls[0]!;
    expect(bundle.bundleFingerprint).toBe("27f726814c75703aca9be273c967ce6cb205ee028ef39123142514b2eeac5ec2");
    expect(bundle.components).toEqual(input.components);
    expect(bundle.obligation).toMatchObject({
      amountMinor: 12_000,
      idempotencyKey: "payment:order-a:create:1:obligation",
    });
    expect(bundle.event).toMatchObject({
      kind: "charge",
      status: "posted",
      method: "cod",
      evidenceType: "cod_order_created",
      evidenceFingerprint: "a".repeat(64),
      amountMinor: 12_000,
    });
    expect(bundle.evidence).toMatchObject({
      verificationStatus: "verified",
      evidenceType: "cod_order_created",
    });
    expect(bundle.componentAllocation.totalMinor).toBe(12_000);
    expect(bundle.allocation).toMatchObject({
      allocationKind: "collection",
      amountMinor: 12_000,
      idempotencyKey: "payment:order-a:create:1:allocation",
    });
  });

  it("keeps provider and unknown charges pending without inventing collection evidence", async () => {
    for (const method of ["provider", "unknown"] as const) {
      const repository = new MemoryRepository();
      const task = createPaymentChargeBundleTaskV1(
        { config: { enabled: true }, repository },
        {
          ...input,
          method,
          status: "pending",
          evidence: undefined,
          idempotencyKey: `payment:order-a:${method}:1`,
        },
      );
      if (!task.enabled) throw new Error("expected enabled task");
      await expect(task.execute()).resolves.toMatchObject({
        kind: "recorded",
        status: "pending",
        method,
      });
      expect(repository.calls[0]).toMatchObject({
        event: { status: "pending", method },
        evidence: null,
        allocation: null,
      });
    }
  });

  it("returns stable identities for exact replay and detects conflicting reuse", async () => {
    const repository = new MemoryRepository();
    const first = createPaymentChargeBundleTaskV1(
      { config: { enabled: true }, repository },
      input,
    );
    const replay = createPaymentChargeBundleTaskV1(
      { config: { enabled: true }, repository },
      structuredClone(input),
    );
    if (!first.enabled || !replay.enabled) throw new Error("expected enabled tasks");
    const inserted = await first.execute();
    const repeated = await replay.execute();
    expect(inserted).toMatchObject({ outcome: "inserted", paymentEventId: "evt-1" });
    expect(repeated).toMatchObject({ outcome: "replayed", paymentEventId: "evt-1" });

    const conflict = createPaymentChargeBundleTaskV1(
      { config: { enabled: true }, repository },
      {
        ...input,
        components: {
          ...input.components,
          merchandiseVatMinor: 800,
          vatMinor: 800,
          totalMinor: 11_900,
        },
      },
    );
    if (!conflict.enabled) throw new Error("expected enabled task");
    await expect(conflict.execute()).rejects.toBeInstanceOf(PaymentChargeBundleIntegrityErrorV1);
  });

  it("rejects posted method/evidence drift before repository access", () => {
    const repository = new MemoryRepository();
    const invalid = [
      { ...input, evidence: { ...input.evidence, evidenceType: "provider_webhook_success" as const } },
      { ...input, method: "provider" as const },
      { ...input, method: "unknown" as const },
      { ...input, evidence: undefined },
    ];
    for (const value of invalid) {
      expect(() => createPaymentChargeBundleTaskV1(
        { config: { enabled: true }, repository },
        value,
      )).toThrow(PaymentChargeBundleValidationErrorV1);
    }
    expect(repository.calls).toHaveLength(0);
  });

  it("rejects arithmetic, scope, currency, exponent, time and identity drift before writes", () => {
    const repository = new MemoryRepository();
    const invalid = [
      { ...input, merchantId: " merchant-a" },
      { ...input, commercialRevision: -1 },
      { ...input, currencyCode: "USD" },
      { ...input, minorUnitExponent: 2 },
      { ...input, status: "settled" },
      { ...input, sourceOccurredAt: "not-an-instant" },
      { ...input, sourceType: "order_correction" },
      { ...input, idempotencyKey: "" },
      { ...input, components: { ...input.components, totalMinor: 11_999 } },
      {
        ...input,
        components: {
          taxMode: "exclusive",
          merchandiseGrossMinor: 0,
          discountMinor: 0,
          merchandiseNetMinor: 0,
          shippingMinor: 0,
          merchandiseVatMinor: 0,
          shippingVatMinor: 0,
          vatMinor: 0,
          unclassifiedMinor: 0,
          totalMinor: 0,
        },
      },
    ];
    for (const value of invalid) {
      expect(() => createPaymentChargeBundleTaskV1(
        { config: { enabled: true }, repository },
        value as never,
      )).toThrow(PaymentChargeBundleValidationErrorV1);
    }
    expect(repository.calls).toHaveLength(0);
  });

  it("canonicalizes bounded provider evidence and rejects secret-bearing payloads", async () => {
    const repository = new MemoryRepository();
    const task = createPaymentChargeBundleTaskV1(
      { config: { enabled: true }, repository },
      {
        ...input,
        method: "provider",
        evidence: {
          evidenceType: "provider_webhook_success",
          evidenceFingerprint: "b".repeat(64),
          sourceSystem: "sepay_va",
          sourceReference: "merchant_retail:config-a:event-a",
          evidencePayload: {
            zeta: 3,
            nested: { zeta: 2, alpha: 1 },
            alpha: true,
          },
        },
        idempotencyKey: "payment:order-a:provider:event-a",
        sourceId: "sepay_va:config-a:event-a:intent-a",
      },
    );
    if (!task.enabled) throw new Error("expected enabled task");
    await task.execute();
    expect(repository.calls[0]?.evidence?.evidencePayload).toEqual({
      alpha: true,
      nested: { alpha: 1, zeta: 2 },
      zeta: 3,
    });

    for (const evidencePayload of [
      { rawBody: "signed bytes" },
      { nested: { authorization: "credential" } },
      { signature: "provider signature" },
      { token: "provider token" },
      { value: "x".repeat(16_385) },
    ]) {
      expect(() => createPaymentChargeBundleTaskV1(
        { config: { enabled: true }, repository },
        {
          ...input,
          method: "provider",
          evidence: {
            evidenceType: "provider_webhook_success",
            evidenceFingerprint: "b".repeat(64),
            sourceSystem: "sepay_va",
            sourceReference: "merchant_retail:config-a:event-a",
            evidencePayload,
          },
          idempotencyKey: "payment:order-a:provider:event-a",
          sourceId: "sepay_va:config-a:event-a:intent-a",
        },
      )).toThrow(PaymentChargeBundleValidationErrorV1);
    }
  });

  it("fails closed when a repository returns forged identity or fingerprint", async () => {
    const appendChargeBundle = vi.fn(async (bundle: NormalizedPaymentChargeBundleV1) => ({
      outcome: "inserted" as const,
      bundleFingerprint: "b".repeat(64),
      merchantId: "merchant-b",
      storeId: bundle.storeId,
      orderId: bundle.orderId,
      commercialRevisionId: bundle.commercialRevisionId,
      eventIdempotencyKey: bundle.event.idempotencyKey,
      obligationId: "obl-forged",
      paymentEventId: "evt-forged",
    }));
    const task = createPaymentChargeBundleTaskV1(
      { config: { enabled: true }, repository: { appendChargeBundle } },
      input,
    );
    if (!task.enabled) throw new Error("expected enabled task");

    await expect(task.execute()).rejects.toBeInstanceOf(PaymentChargeBundleIntegrityErrorV1);

    const storageFailure = new Error("storage transaction aborted");
    const failedTask = createPaymentChargeBundleTaskV1(
      {
        config: { enabled: true },
        repository: { appendChargeBundle: vi.fn().mockRejectedValue(storageFailure) },
      },
      input,
    );
    if (!failedTask.enabled) throw new Error("expected enabled task");
    await expect(failedTask.execute()).rejects.toBe(storageFailure);
  });
});
