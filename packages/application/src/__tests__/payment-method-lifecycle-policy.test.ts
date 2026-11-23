import { describe, expect, it } from "vitest";
import {
  PaymentMethodLifecyclePolicyErrorV1,
  selectOrderCreatedChargeLifecycleV1,
} from "../services/payment-method-lifecycle-policy";

const base = {
  merchantId: "merchant-a",
  storeId: "store-a",
  orderId: "order-a",
  currencyCode: "VND",
  minorUnitExponent: 0,
  chargeAmountMinor: 12_000,
  sourceType: "order_created" as const,
  sourceId: "order-a:create:1",
  sourceOccurredAt: "2026-08-05T00:00:00.000Z",
};

const proof = {
  evidenceFingerprint: "b".repeat(64),
  sourceSystem: "payment_boundary",
  sourceReference: "proof-order-a-1",
  confirmedAt: base.sourceOccurredAt,
};

describe("PAY-02A inactive order-create payment lifecycle policy", () => {
  it("is default-off before inspecting invalid input", () => {
    expect(selectOrderCreatedChargeLifecycleV1({
      ...base,
      merchantId: "",
      method: "cod",
    })).toEqual({ enabled: false, status: "disabled" });
  });

  it("posts COD immediately at successful order creation with deterministic evidence", () => {
    const first = selectOrderCreatedChargeLifecycleV1(
      { ...base, method: "cod" },
      { enabled: true },
    );
    const replay = selectOrderCreatedChargeLifecycleV1(
      structuredClone({ ...base, method: "cod" as const }),
      { enabled: true },
    );
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      enabled: true,
      status: "posted",
      method: "cod",
      assurance: "recorded_order_created_policy",
      evidence: {
        evidenceType: "cod_order_created",
        sourceSystem: "order_service",
        sourceReference: base.sourceId,
      },
    });
    if (!first.enabled || first.status !== "posted") throw new Error("expected posted");
    expect(first.evidence.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("posts cash only with sufficient tender and exact returned change", () => {
    const decision = selectOrderCreatedChargeLifecycleV1({
      ...base,
      method: "cash",
      confirmation: {
        kind: "cash_tender_confirmed",
        ...proof,
        amountReceivedMinor: 20_000,
        changeMinor: 8_000,
      },
    }, { enabled: true });
    expect(decision).toMatchObject({
      enabled: true,
      status: "posted",
      method: "cash",
      assurance: "cash_tender_confirmed",
      evidence: { evidenceType: "cash_receipt" },
    });

    for (const confirmation of [
      { kind: "cash_tender_confirmed" as const, ...proof, amountReceivedMinor: 11_999, changeMinor: 0 },
      { kind: "cash_tender_confirmed" as const, ...proof, amountReceivedMinor: 20_000, changeMinor: 7_999 },
    ]) {
      expect(() => selectOrderCreatedChargeLifecycleV1(
        { ...base, method: "cash", confirmation },
        { enabled: true },
      )).toThrow(PaymentMethodLifecyclePolicyErrorV1);
    }
  });

  it("blocks cash without tender proof and never creates an unreachable pending cash event", () => {
    expect(selectOrderCreatedChargeLifecycleV1(
      { ...base, method: "cash" },
      { enabled: true },
    )).toEqual({
      enabled: true,
      status: "blocked",
      method: "cash",
      reason: "cash_tender_confirmation_required",
    });
  });

  it("keeps manual bank and provider pending until their exact confirmation", () => {
    expect(selectOrderCreatedChargeLifecycleV1(
      { ...base, method: "manual_bank" },
      { enabled: true },
    )).toMatchObject({
      enabled: true,
      status: "pending",
      method: "manual_bank",
      assurance: "awaiting_manual_verification",
      evidence: null,
    });
    expect(selectOrderCreatedChargeLifecycleV1(
      { ...base, method: "provider" },
      { enabled: true },
    )).toMatchObject({
      enabled: true,
      status: "pending",
      method: "provider",
      assurance: "awaiting_provider_success",
      evidence: null,
    });

    expect(selectOrderCreatedChargeLifecycleV1({
      ...base,
      method: "manual_bank",
      confirmation: { kind: "manual_bank_verified", ...proof },
    }, { enabled: true })).toMatchObject({
      status: "posted",
      assurance: "manual_bank_verified",
      evidence: { evidenceType: "manual_verified" },
    });
    expect(selectOrderCreatedChargeLifecycleV1({
      ...base,
      method: "provider",
      confirmation: { kind: "provider_success", ...proof },
    }, { enabled: true })).toMatchObject({
      status: "posted",
      assurance: "provider_confirmed",
      evidence: { evidenceType: "provider_webhook_success" },
    });
  });

  it("blocks unknown and rejects cross-method or caller-supplied COD confirmation", () => {
    expect(selectOrderCreatedChargeLifecycleV1(
      { ...base, method: "unknown" },
      { enabled: true },
    )).toEqual({
      enabled: true,
      status: "blocked",
      method: "unknown",
      reason: "unknown_payment_method",
    });

    for (const value of [
      { ...base, method: "cod" as const, confirmation: { kind: "provider_success" as const, ...proof } },
      { ...base, method: "provider" as const, confirmation: { kind: "manual_bank_verified" as const, ...proof } },
      { ...base, method: "unknown" as const, confirmation: { kind: "provider_success" as const, ...proof } },
    ]) {
      expect(() => selectOrderCreatedChargeLifecycleV1(
        value,
        { enabled: true },
      )).toThrow(PaymentMethodLifecyclePolicyErrorV1);
    }
  });

  it("fails closed for scope, currency, amount, time and confirmation identity drift", () => {
    const invalid = [
      { ...base, method: "cod" as const, storeId: " store-a" },
      { ...base, method: "cod" as const, currencyCode: "USD" },
      { ...base, method: "cod" as const, minorUnitExponent: 2 },
      { ...base, method: "cod" as const, chargeAmountMinor: 0 },
      { ...base, method: "cod" as const, sourceType: "order_correction" as const },
      { ...base, method: "cod" as const, sourceOccurredAt: "invalid" },
      {
        ...base,
        method: "provider" as const,
        confirmation: { kind: "provider_success" as const, ...proof, confirmedAt: "2026-08-05T00:00:01.000Z" },
      },
      {
        ...base,
        method: "manual_bank" as const,
        confirmation: { kind: "manual_bank_verified" as const, ...proof, evidenceFingerprint: "bad" },
      },
    ];
    for (const value of invalid) {
      expect(() => selectOrderCreatedChargeLifecycleV1(
        value,
        { enabled: true },
      )).toThrow(PaymentMethodLifecyclePolicyErrorV1);
    }
  });
});
