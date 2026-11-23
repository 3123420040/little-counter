import { describe, expect, it, vi } from "vitest";
import type {
  NormalizedPaymentChargeBundleV1,
  NormalizedPaymentChargeBundleV2,
  PersistedPaymentChargeBundleV1,
} from "../services/payment-charge-bundle-service";
import {
  createProviderInitialPostedChargeTaskV1,
  createProviderInitialPostedChargeTaskV2,
  validateProviderSettlementEvidenceV1,
  PROVIDER_INITIAL_POSTED_CHARGE_DEFAULT_CONFIG_V1,
  ProviderInitialPostedChargeValidationErrorV1,
  type CurrentTransactionPaymentChargeBundleRepositoryV1,
  type ProviderInitialPostedChargeInputV1,
} from "../services/provider-initial-posted-charge-bridge";

class CurrentTransactionRepository implements CurrentTransactionPaymentChargeBundleRepositoryV1 {
  readonly transactionOwnership = "caller" as const;
  readonly calls: NormalizedPaymentChargeBundleV1[] = [];

  async appendChargeBundle(bundle: NormalizedPaymentChargeBundleV1): Promise<PersistedPaymentChargeBundleV1> {
    this.calls.push(structuredClone(bundle));
    return {
      outcome: this.calls.length === 1 ? "inserted" : "replayed",
      bundleFingerprint: bundle.bundleFingerprint,
      merchantId: bundle.merchantId,
      storeId: bundle.storeId,
      orderId: bundle.orderId,
      commercialRevisionId: bundle.commercialRevisionId,
      eventIdempotencyKey: bundle.event.idempotencyKey,
      obligationId: "obligation-provider-1",
      paymentEventId: "event-provider-1",
    };
  }
}

const components = {
  taxMode: "exclusive" as const,
  merchandiseGrossMinor: 120_000,
  discountMinor: 10_000,
  merchandiseNetMinor: 110_000,
  shippingMinor: 5_000,
  merchandiseVatMinor: 10_000,
  shippingVatMinor: 0,
  vatMinor: 10_000,
  unclassifiedMinor: 0,
  totalMinor: 125_000,
};

const sepayInput: ProviderInitialPostedChargeInputV1 = {
  merchantId: "merchant-a",
  storeId: "store-a",
  paymentIntentId: "pi-sepay-a",
  orderId: "order-a",
  orderCreatedInCurrentTransaction: true,
  commercialRevisionId: "00000000-0000-4000-8000-000000000101",
  commercialRevision: 0,
  currencyCode: "VND",
  minorUnitExponent: 0,
  components,
  intentAmountMinor: 125_000,
  provider: "sepay_va",
  providerConfigPurpose: "merchant_retail",
  providerConfigId: "sepay-bank-primary",
  providerEventId: "sepay-event-1",
  referenceCode: "PISEPAYA",
  providerAmount: "125000",
  providerCurrencyCode: "VND",
  expectedProviderAmount: "125000",
  expectedProviderCurrencyCode: "VND",
  direction: "in",
  settlementOccurredAt: "2026-08-05T03:00:00.000Z",
  verification: {
    authenticated: true,
    signatureAlgorithm: "hmac-sha256",
    signedPayloadSha256: "a".repeat(64),
    rawBodyPreserved: true,
    providerConfigPurpose: "merchant_retail",
    providerConfigId: "sepay-bank-primary",
  },
};

const nowPaymentsInput: ProviderInitialPostedChargeInputV1 = {
  ...sepayInput,
  paymentIntentId: "pi-now-a",
  orderId: "order-now-a",
  provider: "nowpayments",
  providerConfigId: "cfg-now-retail-primary",
  providerEventId: "now-event-1",
  referenceCode: "PINOWA",
  providerAmount: "5.000000",
  providerCurrencyCode: "usdttrc20",
  expectedProviderAmount: "5.000000",
  expectedProviderCurrencyCode: "usdttrc20",
  direction: undefined,
  providerTransactionId: "now-event-1",
  providerTransactionHash: "0xnow-payment-hash",
  providerNetwork: "trc20",
  providerPayCurrency: "usdttrc20",
  verification: {
    authenticated: true,
    signatureAlgorithm: "hmac-sha512",
    signedPayloadSha256: "b".repeat(64),
    providerConfigPurpose: "merchant_retail",
    providerConfigId: "cfg-now-retail-primary",
    terminal: true,
    paymentStatus: "finished",
  },
};

describe("provider evidence validation before commercial facts exist", () => {
  it.each([sepayInput, nowPaymentsInput])("validates $provider proof without requiring fabricated order/revision/components", input => {
    const { provider, providerConfigPurpose, providerConfigId, intentAmountMinor, providerAmount,
      expectedProviderAmount, providerCurrencyCode, expectedProviderCurrencyCode, direction, verification } = input;
    expect(validateProviderSettlementEvidenceV1({ provider, providerConfigPurpose, providerConfigId,
      intentAmountMinor, providerAmount, expectedProviderAmount, providerCurrencyCode,
      expectedProviderCurrencyCode, direction, verification })).toMatchObject({
      signatureAlgorithm: verification.signatureAlgorithm, authenticatedPayloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it.each([
    { verification: { ...sepayInput.verification, authenticated: false } },
    { verification: { ...sepayInput.verification, providerConfigId: "foreign-config" } },
    { verification: { ...sepayInput.verification, rawBodyPreserved: false } },
    { direction: "out" }, { providerAmount: "1" }, { intentAmountMinor: 1 },
    { providerConfigPurpose: "platform_billing" },
  ])("rejects unauthenticated or mismatched standalone proof %j", change => {
    expect(() => validateProviderSettlementEvidenceV1({ ...sepayInput, ...change } as never))
      .toThrow(ProviderInitialPostedChargeValidationErrorV1);
  });
});

describe("fee-aware provider bridge", () => {
  it.each(["sepay_va", "nowpayments"] as const)("keeps %s verification and carries the full fee", async (provider) => {
    let captured: NormalizedPaymentChargeBundleV2 | undefined;
    const repository = { transactionOwnership: "caller" as const, appendChargeBundle: async (bundle: NormalizedPaymentChargeBundleV2) => {
      captured = structuredClone(bundle);
      return { outcome: "inserted" as const, bundleFingerprint: bundle.bundleFingerprint, merchantId: bundle.merchantId,
        storeId: bundle.storeId, orderId: bundle.orderId, commercialRevisionId: bundle.commercialRevisionId,
        eventIdempotencyKey: bundle.event.idempotencyKey, obligationId: "provider-fee-obligation", paymentEventId: "provider-fee-event" };
    } };
    const legacy = provider === "sepay_va" ? sepayInput : nowPaymentsInput;
    const value = { ...legacy, intentAmountMinor: 240_320,
      ...(provider === "sepay_va" ? { providerAmount: "240320", expectedProviderAmount: "240320" } : {}),
      components: { taxMode: "inclusive" as const, merchandiseGrossMinor: 240_000, discountMinor: 24_000,
        merchandiseNetMinor: 216_000, shippingMinor: 20_000, merchandiseVatMinor: 19_636, shippingVatMinor: 1_818,
        paymentFeeMinor: 4_320, paymentFeeVatMinor: 393, vatMinor: 21_847, unclassifiedMinor: 0, totalMinor: 240_320 },
    };
    const task = createProviderInitialPostedChargeTaskV2({ repository }, value);
    if (!task.enabled) throw new Error("provider task must be enabled");
    expect(await task.execute()).toMatchObject({ status: "posted", method: "provider", amountMinor: 240_320 });
    expect(captured).toMatchObject({ bundleVersion: 2, componentAllocation: { paymentFeeMinor: 4_320, paymentFeeVatMinor: 393 },
      evidence: { evidenceType: "provider_webhook_success" } });
    captured = undefined;
    expect(() => createProviderInitialPostedChargeTaskV2({ repository }, { ...value,
      verification: { ...value.verification, authenticated: false } })).toThrow();
    expect(captured).toBeUndefined();
  });
});

describe("PAY-02F provider initial-posted charge bridge", () => {
  it("is frozen default-on and retains an explicit disabled no-write seam", () => {
    expect(PROVIDER_INITIAL_POSTED_CHARGE_DEFAULT_CONFIG_V1).toEqual({ enabled: true });
    expect(Object.isFrozen(PROVIDER_INITIAL_POSTED_CHARGE_DEFAULT_CONFIG_V1)).toBe(true);
    const repository = new CurrentTransactionRepository();
    const task = createProviderInitialPostedChargeTaskV1(
      { config: { enabled: false }, repository },
      sepayInput,
    );

    expect(task).toEqual({ enabled: false, status: "disabled" });
    expect(repository.calls).toEqual([]);
  });

  it("maps authenticated incoming SePay into one initial posted provider bundle", async () => {
    const repository = new CurrentTransactionRepository();
    const task = createProviderInitialPostedChargeTaskV1(
      { config: { enabled: true }, repository },
      sepayInput,
    );
    if (!task.enabled) throw new Error("expected enabled bridge");

    await expect(task.execute()).resolves.toMatchObject({
      kind: "recorded",
      outcome: "inserted",
      status: "posted",
      method: "provider",
      amountMinor: 125_000,
    });
    expect(repository.calls).toHaveLength(1);
    expect(repository.calls[0]).toMatchObject({
      merchantId: "merchant-a",
      storeId: "store-a",
      orderId: "order-a",
      sourceType: "order_created",
      event: {
        status: "posted",
        method: "provider",
        evidenceType: "provider_webhook_success",
        amountMinor: 125_000,
      },
      evidence: {
        sourceSystem: "sepay_va",
        sourceReference: "merchant_retail:sepay-bank-primary:sepay-event-1",
        evidencePayload: expect.objectContaining({
          provider: "sepay_va",
          providerEventId: "sepay-event-1",
          paymentIntentId: "pi-sepay-a",
          signedPayloadSha256: "a".repeat(64),
        }),
      },
      componentAllocation: components,
      allocation: { amountMinor: 125_000 },
    });
  });

  it("maps only terminal purpose/config-bound NOWPayments evidence", async () => {
    const repository = new CurrentTransactionRepository();
    const task = createProviderInitialPostedChargeTaskV1(
      { config: { enabled: true }, repository },
      nowPaymentsInput,
    );
    if (!task.enabled) throw new Error("expected enabled bridge");

    await task.execute();
    expect(repository.calls[0]?.evidence).toMatchObject({
      sourceSystem: "nowpayments",
      sourceReference: "merchant_retail:cfg-now-retail-primary:now-event-1",
      evidencePayload: expect.objectContaining({
        paymentStatus: "finished",
        terminal: true,
        providerAmount: "5",
        expectedProviderAmount: "5",
        providerTransactionHash: "0xnow-payment-hash",
      }),
    });
  });

  it("requires a caller-owned transaction repository and same-transaction order creation", () => {
    const appendChargeBundle = vi.fn();
    expect(() => createProviderInitialPostedChargeTaskV1({
      config: { enabled: true },
      repository: { appendChargeBundle } as never,
    }, sepayInput)).toThrow("caller-owned transaction repository");
    expect(() => createProviderInitialPostedChargeTaskV1({
      config: { enabled: true },
      repository: new CurrentTransactionRepository(),
    }, { ...sepayInput, orderCreatedInCurrentTransaction: false })).toThrow(
      "same settlement transaction",
    );
    expect(appendChargeBundle).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated, nonterminal, wrong-direction and config-drift evidence", () => {
    const repository = new CurrentTransactionRepository();
    const invalid: ProviderInitialPostedChargeInputV1[] = [
      { ...sepayInput, verification: { ...sepayInput.verification, authenticated: false } },
      { ...sepayInput, direction: "out" },
      { ...sepayInput, providerConfigId: "" },
      { ...nowPaymentsInput, verification: { ...nowPaymentsInput.verification, terminal: false } },
      { ...nowPaymentsInput, verification: { ...nowPaymentsInput.verification, paymentStatus: "confirmed" } },
      { ...nowPaymentsInput, verification: { ...nowPaymentsInput.verification, providerConfigId: "cfg-other" } },
    ];
    for (const input of invalid) {
      expect(() => createProviderInitialPostedChargeTaskV1(
        { config: { enabled: true }, repository },
        input,
      )).toThrow(ProviderInitialPostedChargeValidationErrorV1);
    }
    expect(repository.calls).toEqual([]);
  });

  it("binds SePay verification to the same retail config identity as the intent", () => {
    const repository = new CurrentTransactionRepository();
    expect(() => createProviderInitialPostedChargeTaskV1(
      { config: { enabled: true }, repository },
      {
        ...sepayInput,
        verification: {
          ...sepayInput.verification,
          providerConfigPurpose: "merchant_retail",
          providerConfigId: "sepay-bank-other",
        },
      },
    )).toThrow("verification config differs from locked intent");
    expect(repository.calls).toEqual([]);
  });

  it("rejects scope, commercial and provider amount/currency drift before persistence", () => {
    const repository = new CurrentTransactionRepository();
    const invalid: ProviderInitialPostedChargeInputV1[] = [
      { ...sepayInput, merchantId: " merchant-a" },
      { ...sepayInput, intentAmountMinor: 124_999 },
      { ...sepayInput, providerAmount: "124999" },
      { ...sepayInput, providerCurrencyCode: "USD" },
      { ...nowPaymentsInput, providerAmount: "5.1" },
      { ...nowPaymentsInput, providerCurrencyCode: "usdcmatic" },
      { ...nowPaymentsInput, settlementOccurredAt: "not-an-instant" },
    ];
    for (const input of invalid) {
      expect(() => createProviderInitialPostedChargeTaskV1(
        { config: { enabled: true }, repository },
        input,
      )).toThrow(ProviderInitialPostedChargeValidationErrorV1);
    }
    expect(repository.calls).toEqual([]);
  });

  it("snapshots safe evidence without raw bodies, signatures or secrets", async () => {
    const repository = new CurrentTransactionRepository();
    const mutable = structuredClone(nowPaymentsInput);
    const task = createProviderInitialPostedChargeTaskV1(
      { config: { enabled: true }, repository },
      mutable,
    );
    if (!task.enabled) throw new Error("expected enabled bridge");
    mutable.verification.signedPayloadSha256 = "c".repeat(64);
    mutable.providerTransactionHash = "mutated";

    await task.execute();
    const serialized = JSON.stringify(repository.calls[0]?.evidence?.evidencePayload);
    expect(serialized).toContain("0xnow-payment-hash");
    expect(serialized).toContain("b".repeat(64));
    expect(serialized).not.toMatch(/rawBody|authorization|secret|apiKey|signature"/i);
  });

  it("delegates exact replay while preserving one stable provider identity", async () => {
    const repository = new CurrentTransactionRepository();
    for (const expectedOutcome of ["inserted", "replayed"] as const) {
      const task = createProviderInitialPostedChargeTaskV1(
        { config: { enabled: true }, repository },
        structuredClone(nowPaymentsInput),
      );
      if (!task.enabled) throw new Error("expected enabled bridge");
      await expect(task.execute()).resolves.toMatchObject({ outcome: expectedOutcome });
    }
    expect(repository.calls).toHaveLength(2);
    expect(repository.calls[0]?.bundleFingerprint).toBe(repository.calls[1]?.bundleFingerprint);
    expect(repository.calls[0]?.event.idempotencyKey).toBe(repository.calls[1]?.event.idempotencyKey);
  });
});
