import { describe, expect, it } from "vitest";
import {
  PAYMENT_ENTRY_COMPATIBILITY_DEFAULT_CONFIG_V1,
  PaymentEntryCompatibilityPolicyErrorV1,
  selectPaymentEntryCompatibilityV1,
  type PaymentEntryCompatibilityInputV1,
} from "../services/payment-entry-compatibility-policy";

const recorded = {
  enabled: true as const,
  kind: "recorded" as const,
  outcome: "inserted" as const,
  obligationId: "00000000-0000-4000-8000-000000000201",
  paymentEventId: "00000000-0000-4000-8000-000000000301",
  amountMinor: 121_000,
  status: "posted" as const,
  method: "cod" as const,
};

function input(
  overrides: Partial<PaymentEntryCompatibilityInputV1> = {},
): PaymentEntryCompatibilityInputV1 {
  return {
    boundary: "order_created",
    paymentMethod: "cod",
    legacyStatus: "pending",
    legacyAmountMinor: 121_000,
    canonicalCharge: recorded,
    ...overrides,
  };
}

describe("PAY-COMPAT-01 legacy payment-entry compatibility policy", () => {
  it("is frozen default-on while preserving an explicit legacy-only compatibility seam", () => {
    expect(PAYMENT_ENTRY_COMPATIBILITY_DEFAULT_CONFIG_V1).toEqual({ enabled: true });
    expect(Object.isFrozen(PAYMENT_ENTRY_COMPATIBILITY_DEFAULT_CONFIG_V1)).toBe(true);
    expect(selectPaymentEntryCompatibilityV1(input({
      paymentMethod: "",
      legacyAmountMinor: -1,
    }), { enabled: false })).toEqual({
      enabled: false,
      writeMode: "legacy_only",
      legacyStatus: "pending",
      aggregateReadSource: "app.payment_entries",
      legacyMetadata: {},
    });
  });

  it("mirrors an immutable posted COD result instead of leaving legacy pending", () => {
    expect(selectPaymentEntryCompatibilityV1(input(), { enabled: true })).toEqual({
      enabled: true,
      writeMode: "canonical_plus_legacy_mirror",
      legacyStatus: "posted",
      aggregateReadSource: "app.payment_events",
      legacyMetadata: {
        canonicalPaymentEventId: recorded.paymentEventId,
        canonicalPaymentObligationId: recorded.obligationId,
        canonicalPaymentWriteOutcome: "inserted",
        compatibilityVersion: 1,
        financialAggregateSource: "app.payment_events",
      },
    });
  });

  it("keeps an unverified manual bank transfer pending in both ledgers", () => {
    expect(selectPaymentEntryCompatibilityV1(input({
      paymentMethod: "bank_transfer",
      legacyStatus: "posted",
      canonicalCharge: {
        ...recorded,
        method: "manual_bank",
        status: "pending",
      },
    }), { enabled: true })).toMatchObject({
      enabled: true,
      writeMode: "canonical_plus_legacy_mirror",
      legacyStatus: "pending",
      aggregateReadSource: "app.payment_events",
    });
  });

  it("mirrors a posted manual-bank charge only when canonical proof is already posted", () => {
    expect(selectPaymentEntryCompatibilityV1(input({
      paymentMethod: "bank_transfer",
      legacyStatus: "posted",
      canonicalCharge: {
        ...recorded,
        method: "manual_bank",
        status: "posted",
      },
    }), { enabled: true })).toMatchObject({
      enabled: true,
      legacyStatus: "posted",
      legacyMetadata: { canonicalPaymentEventId: recorded.paymentEventId },
    });
  });

  it("keeps reconciled cash posted and correlated to the canonical event", () => {
    expect(selectPaymentEntryCompatibilityV1(input({
      paymentMethod: "cash",
      legacyStatus: "posted",
      canonicalCharge: { ...recorded, method: "cash" },
    }), { enabled: true })).toMatchObject({
      enabled: true,
      legacyStatus: "posted",
      legacyMetadata: { canonicalPaymentEventId: recorded.paymentEventId },
    });
  });

  it("mirrors an external-provider charge only from PAY-02G recorded proof", () => {
    for (const paymentMethod of ["sepay_va", "nowpayments"]) {
      expect(selectPaymentEntryCompatibilityV1(input({
        paymentMethod,
        legacyStatus: "posted",
        canonicalCharge: {
          ...recorded,
          method: "provider",
          status: "posted",
        },
      }), { enabled: true })).toEqual({
        enabled: true,
        writeMode: "canonical_plus_legacy_mirror",
        legacyStatus: "posted",
        aggregateReadSource: "app.payment_events",
        legacyMetadata: {
          canonicalPaymentEventId: recorded.paymentEventId,
          canonicalPaymentObligationId: recorded.obligationId,
          canonicalPaymentWriteOutcome: "inserted",
          compatibilityVersion: 1,
          financialAggregateSource: "app.payment_events",
          providerChargeOwner: "provider_initial_posted_charge_caller",
        },
      });
    }
  });

  it("requires the canonical write whenever compatibility is enabled", () => {
    for (const canonicalCharge of [
      { enabled: false as const, status: "disabled" as const },
      undefined,
      { enabled: true as const, status: "delegated_provider" as const, method: "provider" as const },
    ]) {
      expect(() => selectPaymentEntryCompatibilityV1(input({ canonicalCharge }), {
        enabled: true,
      })).toThrow(PaymentEntryCompatibilityPolicyErrorV1);
    }
  });

  it("rejects method, status, amount and event identity drift", () => {
    const invalid: PaymentEntryCompatibilityInputV1[] = [
      input({ paymentMethod: "bank_transfer" }),
      input({ canonicalCharge: { ...recorded, status: "pending" } }),
      input({ canonicalCharge: { ...recorded, amountMinor: 120_999 } }),
      input({ canonicalCharge: { ...recorded, paymentEventId: "bad" } }),
      input({ boundary: "positive_correction" as never }),
      input({ paymentMethod: "voucher" }),
      input({ paymentMethod: "crypto_usdc", canonicalCharge: { ...recorded, method: "provider" } }),
      input({ paymentMethod: "crypto_usdt", canonicalCharge: { ...recorded, method: "provider" } }),
    ];
    for (const value of invalid) {
      expect(() => selectPaymentEntryCompatibilityV1(value, { enabled: true }))
        .toThrow(PaymentEntryCompatibilityPolicyErrorV1);
    }
  });

  it("makes double counting impossible by selecting exactly one aggregate source", () => {
    const disabled = selectPaymentEntryCompatibilityV1(input(), { enabled: false });
    const enabled = selectPaymentEntryCompatibilityV1(input(), { enabled: true });
    expect([disabled.aggregateReadSource]).toEqual(["app.payment_entries"]);
    expect([enabled.aggregateReadSource]).toEqual(["app.payment_events"]);
    expect(Object.keys(enabled)).not.toContain("aggregateReadSources");
  });
});
