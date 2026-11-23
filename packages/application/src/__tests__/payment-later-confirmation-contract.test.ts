import { describe, expect, it } from "vitest";
import {
  PaymentLaterConfirmationContractErrorV1,
  createPaymentLaterConfirmationTaskV1,
  createPaymentLaterConfirmationTaskV2,
  assertNormalizedPaymentLaterConfirmationV2,
} from "../services/payment-later-confirmation-contract";

const input = {
  merchantId: "merchant-a",
  storeId: "store-a",
  orderId: "order-a",
  commercialRevisionId: "00000000-0000-4000-8000-000000000101",
  commercialRevision: 1,
  currencyCode: "VND",
  minorUnitExponent: 0,
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
  obligation: {
    obligationId: "00000000-0000-4000-8000-000000000201",
    obligationIdempotencyKey: "payment:order-a:create:1:obligation",
    amountMinor: 12_000,
    collectedMinor: 0,
  },
  pendingAttempt: {
    paymentEventId: "00000000-0000-4000-8000-000000000301",
    idempotencyKey: "payment:order-a:create:1",
    method: "provider" as const,
    status: "pending" as const,
    amountMinor: 12_000,
    sourceType: "order_created" as const,
    sourceId: "order-a:create:1",
    sourceOccurredAt: "2026-08-05T00:00:00.000Z",
    evidenceType: null,
    evidenceFingerprint: null,
  },
  confirmation: {
    kind: "provider_success" as const,
    evidenceFingerprint: "c".repeat(64),
    sourceSystem: "sepay",
    sourceReference: "provider-confirmation-100",
    confirmedAt: "2026-08-05T01:00:00.000Z",
  },
};

describe("fee-aware later confirmation", () => {
  it.each(["provider", "manual_bank"] as const)("preserves the fee in a new posted %s event", (method) => {
    const value = { ...input, commercialRevision: 0,
      components: { taxMode: "inclusive" as const, merchandiseGrossMinor: 240_000, discountMinor: 24_000,
        merchandiseNetMinor: 216_000, shippingMinor: 20_000, merchandiseVatMinor: 19_636, shippingVatMinor: 1_818,
        paymentFeeMinor: 4_320, paymentFeeVatMinor: 393, vatMinor: 21_847, unclassifiedMinor: 0, totalMinor: 240_320 },
      obligation: { ...input.obligation, amountMinor: 240_320 },
      pendingAttempt: { ...input.pendingAttempt, method, amountMinor: 240_320 },
      confirmation: { ...input.confirmation, kind: method === "provider" ? "provider_success" as const : "manual_bank_verified" as const },
    };
    const task = createPaymentLaterConfirmationTaskV2(value, { enabled: true });
    if (!task.enabled) throw new Error("confirmation task must be enabled");
    expect(task.bundle).toMatchObject({ bundleVersion: 2, components: { paymentFeeMinor: 4_320, paymentFeeVatMinor: 393 },
      componentAllocation: { paymentFeeMinor: 4_320 }, event: { status: "posted", amountMinor: 240_320 }, allocation: { amountMinor: 240_320 } });
    expect(assertNormalizedPaymentLaterConfirmationV2(task.bundle)).toEqual(task.bundle);
    const changed = structuredClone(task.bundle); changed.componentAllocation.paymentFeeMinor++;
    expect(() => assertNormalizedPaymentLaterConfirmationV2(changed)).toThrow("identity drift");
    expect(() => createPaymentLaterConfirmationTaskV2({ ...value, obligation: { ...value.obligation, collectedMinor: 1 } }, { enabled: true })).toThrow();
    expect(() => createPaymentLaterConfirmationTaskV2({ ...value, components: { ...value.components, paymentFeeVatMinor: 392 } }, { enabled: true })).toThrow();
  });
});

describe("PAY-02B inactive append-only later-confirmation contract", () => {
  it("is default-off before inspecting invalid input", () => {
    expect(createPaymentLaterConfirmationTaskV1({
      ...input,
      merchantId: "",
    })).toEqual({ enabled: false, status: "disabled" });
  });

  it("builds a distinct posted provider event allocated to the original obligation", () => {
    const task = createPaymentLaterConfirmationTaskV1(input, { enabled: true });
    expect(task).toMatchObject({
      enabled: true,
      bundle: {
        merchantId: "merchant-a",
        storeId: "store-a",
        orderId: "order-a",
        priorPendingPaymentEventId: input.pendingAttempt.paymentEventId,
        obligationId: input.obligation.obligationId,
        event: {
          kind: "charge",
          status: "posted",
          method: "provider",
          evidenceType: "provider_webhook_success",
          amountMinor: 12_000,
          sourceType: "provider_confirmation",
        },
        allocation: {
          allocationKind: "collection",
          amountMinor: 12_000,
        },
      },
    });
    if (!task.enabled) throw new Error("expected enabled task");
    expect(task.bundle.event.idempotencyKey).not.toBe(input.pendingAttempt.idempotencyKey);
    expect(task.bundle.event.sourceId).toMatch(/^[a-f0-9]{64}$/);
    expect(task.bundle.bundleFingerprint).toBe("22add4402a27d95495f7bac20e8293cca3b9c554fb807d8378eec5861498e618");
  });

  it("builds the exact manual-bank evidence variant without changing money", () => {
    const task = createPaymentLaterConfirmationTaskV1({
      ...input,
      pendingAttempt: { ...input.pendingAttempt, method: "manual_bank" as const },
      confirmation: {
        ...input.confirmation,
        kind: "manual_bank_verified" as const,
        sourceSystem: "operator_verification",
      },
    }, { enabled: true });
    expect(task).toMatchObject({
      enabled: true,
      bundle: {
        event: {
          method: "manual_bank",
          evidenceType: "manual_verified",
          amountMinor: 12_000,
          sourceType: "manual_bank_confirmation",
        },
        evidence: {
          verificationStatus: "verified",
          sourceSystem: "operator_verification",
        },
      },
    });
  });

  it("is deterministic for exact retry and binds the prior pending identity", () => {
    const first = createPaymentLaterConfirmationTaskV1(input, { enabled: true });
    const replay = createPaymentLaterConfirmationTaskV1(
      structuredClone(input),
      { enabled: true },
    );
    expect(first).toEqual(replay);
    const changedPending = createPaymentLaterConfirmationTaskV1({
      ...input,
      pendingAttempt: {
        ...input.pendingAttempt,
        paymentEventId: "00000000-0000-4000-8000-000000000302",
      },
    }, { enabled: true });
    expect(changedPending).not.toEqual(first);
  });

  it("rejects partial/already-collected or mismatched obligation snapshots", () => {
    const invalid = [
      { ...input, obligation: { ...input.obligation, collectedMinor: 1 } },
      { ...input, obligation: { ...input.obligation, amountMinor: 11_999 } },
      { ...input, pendingAttempt: { ...input.pendingAttempt, amountMinor: 11_999 } },
    ];
    for (const value of invalid) {
      expect(() => createPaymentLaterConfirmationTaskV1(
        value,
        { enabled: true },
      )).toThrow(PaymentLaterConfirmationContractErrorV1);
    }
  });

  it("rejects non-pending, evidenced or cross-method prior attempts and proof", () => {
    const invalid = [
      { ...input, pendingAttempt: { ...input.pendingAttempt, status: "posted" } },
      { ...input, pendingAttempt: { ...input.pendingAttempt, evidenceType: "provider_webhook_success" } },
      { ...input, pendingAttempt: { ...input.pendingAttempt, evidenceFingerprint: "d".repeat(64) } },
      { ...input, confirmation: { ...input.confirmation, kind: "manual_bank_verified" as const } },
      { ...input, pendingAttempt: { ...input.pendingAttempt, method: "cod" } },
      { ...input, pendingAttempt: { ...input.pendingAttempt, method: "cash" } },
      { ...input, pendingAttempt: { ...input.pendingAttempt, method: "unknown" } },
    ];
    for (const value of invalid) {
      expect(() => createPaymentLaterConfirmationTaskV1(
        value as never,
        { enabled: true },
      )).toThrow(PaymentLaterConfirmationContractErrorV1);
    }
  });

  it("fails closed for scope, UUID, components, currency, time and evidence drift", () => {
    const invalid = [
      { ...input, orderId: " order-a" },
      { ...input, commercialRevisionId: "revision-not-uuid" },
      { ...input, currencyCode: "USD" },
      { ...input, minorUnitExponent: 2 },
      { ...input, components: { ...input.components, vatMinor: 899 } },
      { ...input, confirmation: { ...input.confirmation, confirmedAt: "invalid" } },
      { ...input, confirmation: { ...input.confirmation, confirmedAt: "2026-08-04T23:59:59.999Z" } },
      { ...input, confirmation: { ...input.confirmation, evidenceFingerprint: "bad" } },
      { ...input, confirmation: { ...input.confirmation, sourceReference: "" } },
    ];
    for (const value of invalid) {
      expect(() => createPaymentLaterConfirmationTaskV1(
        value,
        { enabled: true },
      )).toThrow(PaymentLaterConfirmationContractErrorV1);
    }
  });
});
