import { describe, expect, it } from "vitest";
import {
  providerPaymentEventIdentityConflictV1,
  providerPaymentEventIdentityFingerprintV1,
  type ProviderPaymentEventInput,
} from "../services/payment-intent-service";

const event: ProviderPaymentEventInput = {
  provider: "sepay_va",
  providerEventId: "sepay-event-1",
  eventType: "sepay.transaction",
  amount: 125000,
  currencyCode: "vnd",
  referenceCode: "PISEPAYA",
  direction: "in",
  providerOccurredAt: "2026-08-05T03:00:00.000Z",
  verification: {
    authenticated: true,
    signatureAlgorithm: "hmac-sha256",
    signedPayloadSha256: "a".repeat(64),
    providerConfigPurpose: "merchant_retail",
    providerConfigId: "sepay-bank-primary",
  },
};

describe("PAY-02G provider event identity", () => {
  it("binds new event identity to occurrence, signed digest and provider config", () => {
    const baseline = providerPaymentEventIdentityFingerprintV1(event);
    for (const drift of [
      { providerOccurredAt: "2026-08-05T03:00:01.000Z" },
      { eventType: "sepay.transaction.corrected" },
      { verification: { ...event.verification, signedPayloadSha256: "b".repeat(64) } },
      { verification: { ...event.verification, providerConfigId: "sepay-bank-other" } },
    ]) {
      expect(providerPaymentEventIdentityFingerprintV1({ ...event, ...drift })).not.toBe(baseline);
    }
  });

  it("detects v2 replay drift and accepts an exact canonical replay", () => {
    const stored = {
      _identityFingerprintVersion: 2,
      _identityFingerprint: providerPaymentEventIdentityFingerprintV1(event),
    };
    expect(providerPaymentEventIdentityConflictV1(event, stored)).toBe(false);
    expect(providerPaymentEventIdentityConflictV1({
      ...event,
      providerOccurredAt: "2026-08-05T03:00:01.000Z",
    }, stored)).toBe(true);
  });

  it("preserves version-1 compatibility for already persisted provider inbox rows", () => {
    const legacy = {
      _identityFingerprint: providerPaymentEventIdentityFingerprintV1(event, 1),
    };
    expect(providerPaymentEventIdentityConflictV1(event, legacy)).toBe(false);
    expect(providerPaymentEventIdentityConflictV1({ ...event, amount: 125001 }, legacy)).toBe(true);
  });

  it("treats a missing stored fingerprint as unclaimed legacy state, not evidence", () => {
    expect(providerPaymentEventIdentityConflictV1(event, {})).toBe(false);
  });
});
