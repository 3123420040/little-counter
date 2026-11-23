import { describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import {
  ORDER_CREATED_PAYMENT_CHARGE_CALLER_DEFAULT_CONFIG_V1,
  OrderCreatedPaymentChargeCallerValidationErrorV1,
  recordOrderCreatedPaymentChargeV1,
  recordOrderCreatedPaymentChargeV2,
  type OrderCreatedPaymentChargeCallerInputV1,
  type OrderCreatedPaymentChargeCallerInputV2,
} from "../services/order-created-payment-charge-caller";

const obligationId = "00000000-0000-4000-8000-000000000201";
const eventId = "00000000-0000-4000-8000-000000000301";

function input(method: string = "cod"): OrderCreatedPaymentChargeCallerInputV1 {
  return {
    merchantId: "merchant-a",
    storeId: "store-a",
    orderId: "order-a",
    orderCreatedAt: "2026-08-05T04:00:00.000Z",
    commercialRevisionId: "00000000-0000-4000-8000-000000000101",
    commercialRevision: 0,
    currencyCode: "VND",
    minorUnitExponent: 0,
    paymentMethod: method,
    amountReceivedMinor: method === "cash" ? 125_000 : 0,
    changeMinor: method === "cash" ? 4_000 : 0,
    components: {
      taxMode: "inclusive",
      merchandiseGrossMinor: 110_000,
      discountMinor: 0,
      merchandiseNetMinor: 110_000,
      shippingMinor: 11_000,
      merchandiseVatMinor: 10_000,
      shippingVatMinor: 1_000,
      vatMinor: 11_000,
      unclassifiedMinor: 0,
      totalMinor: 121_000,
    },
  };
}

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];
  failMarker: string | null = null;

  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (this.failMarker && sql.includes(this.failMarker)) {
      throw new Error(`forced failure at ${this.failMarker}`);
    }
    if (sql.includes("payment_charge_bundle_existing")) return { rows: [] as T[] };
    if (sql.includes("payment_charge_bundle_revision_components_v2")) return { rows: [{ valid: 1 }] as T[] };
    if (sql.includes("insert_obligation")) return { rows: [{ id: obligationId }] as T[] };
    if (sql.includes("insert_event")) return { rows: [{ id: eventId }] as T[] };
    if (sql.includes("insert_evidence")) {
      return { rows: [{ id: "00000000-0000-4000-8000-000000000401" }] as T[] };
    }
    if (sql.includes("insert_components")) {
      return { rows: [{ id: "00000000-0000-4000-8000-000000000501" }] as T[] };
    }
    if (sql.includes("insert_allocation")) {
      return { rows: [{ id: "00000000-0000-4000-8000-000000000601" }] as T[] };
    }
    return { rows: [] as T[] };
  }
}

function execute(
  fake: FakeClient,
  value: OrderCreatedPaymentChargeCallerInputV1 = input(),
  enabled = true,
) {
  return recordOrderCreatedPaymentChargeV1({
    client: fake as unknown as PoolClient,
    config: { enabled },
    transactionContext: {
      ownership: "caller",
      orderCreatedInCurrentTransaction: true,
    },
    repositoryOptions: { statementTimeoutMs: 5_000, lockTimeoutMs: 1_000 },
  }, value);
}

function feeInput(method: string): OrderCreatedPaymentChargeCallerInputV2 {
  return { ...input(method), amountReceivedMinor: method === "cash" ? 250_000 : 0,
    changeMinor: method === "cash" ? 9_680 : 0,
    components: { taxMode: "inclusive", merchandiseGrossMinor: 240_000, discountMinor: 24_000,
      merchandiseNetMinor: 216_000, shippingMinor: 20_000, merchandiseVatMinor: 19_636, shippingVatMinor: 1_818,
      vatMinor: 21_847, unclassifiedMinor: 0, totalMinor: 240_320, paymentFeeMinor: 4_320, paymentFeeVatMinor: 393 },
  };
}
function executeFee(fake: FakeClient, value: OrderCreatedPaymentChargeCallerInputV2) {
  return recordOrderCreatedPaymentChargeV2({ client: fake as unknown as PoolClient, config: { enabled: true },
    transactionContext: { ownership: "caller", orderCreatedInCurrentTransaction: true },
    repositoryOptions: { statementTimeoutMs: 5_000, lockTimeoutMs: 1_000 },
  }, value);
}
describe("order-created fee-aware payment caller", () => {
  it.each([["cod", "posted"], ["cash", "posted"], ["bank_transfer", "pending"]])("retains %s lifecycle including full fee", async (method, status) => {
    const fake = new FakeClient();
    expect(await executeFee(fake, feeInput(method))).toMatchObject({ kind: "recorded", status, amountMinor: 240_320 });
    const components = fake.calls.find((call) => call.sql.includes("insert_components"));
    expect(components?.params?.slice(-2)).toEqual([4_320, 393]);
    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql.trim()))).toBe(false);
  });
  it("keeps external provider settlement delegated with no SQL", async () => {
    const fake = new FakeClient();
    expect(await executeFee(fake, feeInput("sepay_va"))).toEqual({ enabled: true, status: "delegated_provider", method: "provider" });
    expect(fake.calls).toEqual([]);
  });
  it("requires the existing attestation for a posted manual bank fee-bearing charge", async () => {
    const fake = new FakeClient();
    expect(await executeFee(fake, { ...feeInput("bank_transfer"), manualBankConfirmation: {
      operatorId: "operator-a", policyVersion: 7, acknowledgmentVersion: 1,
    } })).toMatchObject({ kind: "recorded", status: "posted", method: "manual_bank", amountMinor: 240_320 });
    expect(fake.calls.find((call) => call.sql.includes("insert_evidence"))?.params).toContain("manual_verified");
  });
  it("checks cash against the full fee-bearing total before SQL", async () => {
    const fake = new FakeClient();
    await expect(executeFee(fake, { ...feeInput("cash"), amountReceivedMinor: 240_319, changeMinor: 0 })).rejects.toThrow("cash tender");
    expect(fake.calls).toEqual([]);
  });
});

describe("PAY-CREATE-01 order-created payment charge caller", () => {
  it("is frozen default-on and retains an explicit disabled no-SQL seam", async () => {
    const fake = new FakeClient();
    expect(ORDER_CREATED_PAYMENT_CHARGE_CALLER_DEFAULT_CONFIG_V1).toEqual({ enabled: true });
    expect(Object.isFrozen(ORDER_CREATED_PAYMENT_CHARGE_CALLER_DEFAULT_CONFIG_V1)).toBe(true);
    await expect(execute(fake, { ...input(), merchantId: "" }, false)).resolves.toEqual({
      enabled: false,
      status: "disabled",
    });
    expect(fake.calls).toEqual([]);
  });

  it("requires caller-owned order transaction provenance before SQL", async () => {
    const fake = new FakeClient();
    await expect(recordOrderCreatedPaymentChargeV1({
      client: fake as unknown as PoolClient,
      config: { enabled: true },
      transactionContext: {
        ownership: "repository" as never,
        orderCreatedInCurrentTransaction: true,
      },
      repositoryOptions: { statementTimeoutMs: 5_000, lockTimeoutMs: 1_000 },
    }, input())).rejects.toThrow("caller-owned order transaction context");
    expect(fake.calls).toEqual([]);
  });

  it("records COD as posted immediately from deterministic order-created evidence", async () => {
    const fake = new FakeClient();
    await expect(execute(fake)).resolves.toMatchObject({
      enabled: true,
      kind: "recorded",
      method: "cod",
      status: "posted",
      amountMinor: 121_000,
    });
    const eventInsert = fake.calls.find((call) => call.sql.includes("insert_event"));
    expect(eventInsert?.params).toContain("cod_order_created");
    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql.trim()))).toBe(false);
  });

  it("records reconciled cash tender as posted and rejects insufficient tender before SQL", async () => {
    const fake = new FakeClient();
    await expect(execute(fake, input("cash"))).resolves.toMatchObject({
      method: "cash",
      status: "posted",
    });
    const evidenceInsert = fake.calls.find((call) => call.sql.includes("insert_evidence"));
    expect(evidenceInsert?.params).toContain("cash_receipt");

    const invalid = new FakeClient();
    await expect(execute(invalid, {
      ...input("cash"),
      amountReceivedMinor: 120_999,
      changeMinor: 0,
    })).rejects.toBeInstanceOf(OrderCreatedPaymentChargeCallerValidationErrorV1);
    expect(invalid.calls).toEqual([]);
  });

  it("keeps unverified manual bank transfer pending without evidence/allocation", async () => {
    const fake = new FakeClient();
    await expect(execute(fake, input("bank_transfer"))).resolves.toMatchObject({
      enabled: true,
      kind: "recorded",
      method: "manual_bank",
      status: "pending",
      amountMinor: 121_000,
    });
    expect(fake.calls.some((call) => call.sql.includes("insert_evidence"))).toBe(false);
    expect(fake.calls.some((call) => call.sql.includes("insert_allocation"))).toBe(false);
  });

  it("records manual bank as posted only with trusted POS booking attestation", async () => {
    const fake = new FakeClient();
    await expect(execute(fake, {
      ...input("bank_transfer"),
      manualBankConfirmation: {
        operatorId: "op_cashier_a",
        policyVersion: 4,
        acknowledgmentVersion: 1,
      },
    })).resolves.toMatchObject({
      kind: "recorded",
      method: "manual_bank",
      status: "posted",
      amountMinor: 121_000,
    });
    const evidenceInsert = fake.calls.find((call) => call.sql.includes("insert_evidence"));
    expect(evidenceInsert?.params).toContain("manual_verified");
    expect(fake.calls.some((call) => call.sql.includes("insert_allocation"))).toBe(true);
  });

  it("delegates external provider settlement without writing a pending duplicate", async () => {
    for (const method of ["sepay_va", "nowpayments", "crypto_usdc", "crypto_usdt"]) {
      const fake = new FakeClient();
      await expect(execute(fake, input(method))).resolves.toEqual({
        enabled: true,
        status: "delegated_provider",
        method: "provider",
      });
      expect(fake.calls).toEqual([]);
    }
  });

  it("records a local mock settlement as a posted provider charge with deterministic evidence", async () => {
    const fake = new FakeClient();
    await expect(execute(fake, {
      ...input("mock"),
      localMockProviderSettlement: {
        paymentIntentId: "pi-local-a",
        providerEventId: "mock:pi-local-a:settled",
      },
    })).resolves.toMatchObject({
      enabled: true,
      kind: "recorded",
      method: "provider",
      status: "posted",
      amountMinor: 121_000,
    });
    const evidenceInsert = fake.calls.find((call) => call.sql.includes("insert_evidence"));
    expect(evidenceInsert?.params).toContain("provider_webhook_success");

    const missingEvidence = new FakeClient();
    await expect(execute(missingEvidence, input("mock"))).resolves.toEqual({
      enabled: true,
      status: "delegated_provider",
      method: "provider",
    });
    expect(missingEvidence.calls).toEqual([]);
  });

  it("rejects unknown methods, amount drift and revision drift before SQL", async () => {
    for (const value of [
      input("voucher"),
      { ...input(), amountReceivedMinor: 1 },
      { ...input(), commercialRevision: 1 },
      { ...input(), commercialRevisionId: "" },
    ]) {
      const fake = new FakeClient();
      await expect(execute(fake, value)).rejects.toBeInstanceOf(
        OrderCreatedPaymentChargeCallerValidationErrorV1,
      );
      expect(fake.calls).toEqual([]);
    }
  });

  it("propagates repository failure to the outer order transaction", async () => {
    const fake = new FakeClient();
    fake.failMarker = "insert_components";
    await expect(execute(fake)).rejects.toThrow("forced failure at insert_components");
    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql.trim()))).toBe(false);
  });
});
