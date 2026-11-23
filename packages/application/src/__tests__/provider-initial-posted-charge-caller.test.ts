import { describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import {
  PROVIDER_INITIAL_POSTED_CHARGE_CALLER_DEFAULT_CONFIG_V1,
  recordProviderInitialPostedChargeFromLockedStateV1,
  ProviderInitialPostedChargeCallerValidationErrorV1,
} from "../services/provider-initial-posted-charge-caller";

const obligationId = "00000000-0000-4000-8000-000000000201";
const eventId = "00000000-0000-4000-8000-000000000301";

function lockedRow(provider: "sepay_va" | "nowpayments" = "sepay_va") {
  const now = provider === "nowpayments";
  const providerConfigId = now ? "cfg-now-retail-primary" : "sepay-bank-primary";
  const providerAmount = now ? "5.000000" : "125000";
  const providerCurrency = now ? "usdttrc20" : "vnd";
  return {
    intent_id: now ? "pi-now-a" : "pi-sepay-a",
    intent_provider: provider,
    intent_status: "paid",
    intent_merchant_id: "merchant-a",
    intent_store_id: "store-a",
    intent_amount: "125000",
    intent_currency_code: "vnd",
    intent_reference_code: now ? "PINOWA" : "PISEPAYA",
    intent_business_purpose: "retail_order",
    intent_provider_config_purpose: "merchant_retail",
    intent_provider_config_id: providerConfigId,
    intent_completed_order_id: null,
    intent_metadata: {
      provider: now ? {
        expectedProviderAmount: "5.000000",
        expectedProviderCurrency: "usdttrc20",
        providerConfigPurpose: "merchant_retail",
        providerConfigId,
      } : {
        providerConfigPurpose: "merchant_retail",
        providerConfigId,
      },
    },
    provider_event_provider: provider,
    provider_event_id: now ? "now-event-1" : "sepay-event-1",
    provider_event_intent_id: now ? "pi-now-a" : "pi-sepay-a",
    provider_event_merchant_id: "merchant-a",
    provider_event_store_id: "store-a",
    provider_event_status: "received",
    provider_event_error: null,
    provider_event_order_id: null,
    provider_event_payment_entry_id: null,
    provider_event_amount: providerAmount,
    provider_event_currency_code: providerCurrency,
    provider_event_payload: {
      _normalized: {
        providerTransactionId: now ? "now-event-1" : null,
        providerTransactionHash: now ? "0xnow-payment-hash" : null,
        providerNetwork: now ? "trc20" : null,
        providerPayCurrency: now ? "usdttrc20" : null,
        providerOccurredAt: "2026-08-05T03:00:00.000Z",
        grossQuantity: now ? "5.000000" : null,
        direction: now ? null : "in",
      },
      _verification: now ? {
        authenticated: true,
        signatureAlgorithm: "hmac-sha512",
        signedPayloadSha256: "b".repeat(64),
        providerConfigPurpose: "merchant_retail",
        providerConfigId,
        terminal: true,
        paymentStatus: "finished",
      } : {
        authenticated: true,
        signatureAlgorithm: "hmac-sha256",
        signedPayloadSha256: "a".repeat(64),
        rawBodyPreserved: true,
        providerConfigPurpose: "merchant_retail",
        providerConfigId,
      },
    },
    order_id: now ? "order-now-a" : "order-a",
    order_merchant_id: "merchant-a",
    order_store_id: "store-a",
    revision_id: "00000000-0000-4000-8000-000000000101",
    revision: 0,
    revision_source_type: "original_order",
    revision_commercial_state: "active",
    revision_data_quality: "complete",
    revision_currency_code: "VND",
    revision_minor_unit_exponent: 0,
    tax_mode: "exclusive",
    merchandise_gross_minor: "120000",
    discount_minor: "10000",
    merchandise_net_minor: "110000",
    shipping_minor: "5000",
    merchandise_vat_minor: "10000",
    shipping_vat_minor: "0",
    vat_minor: "10000",
    unclassified_minor: "0",
    total_minor: "125000",
  };
}

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];
  row: Record<string, unknown> | null = lockedRow();
  failMarker: string | null = null;

  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (this.failMarker && sql.includes(this.failMarker)) {
      throw new Error(`forced failure at ${this.failMarker}`);
    }
    if (sql.includes("provider_initial_posted_charge_locked_state")) {
      return { rows: this.row ? [this.row as T] : [] as T[] };
    }
    if (sql.includes("payment_charge_bundle_existing")) return { rows: [] as T[] };
    if (sql.includes("payment_charge_bundle_revision_components_v2")) return { rows: [{ valid: 1 }] as T[] };
    if (sql.includes("payment_charge_bundle_insert_obligation")) {
      return { rows: [{ id: obligationId }] as T[] };
    }
    if (sql.includes("payment_charge_bundle_insert_event")) {
      return { rows: [{ id: eventId }] as T[] };
    }
    if (sql.includes("payment_charge_bundle_insert_evidence")) {
      return { rows: [{ id: "00000000-0000-4000-8000-000000000401" }] as T[] };
    }
    if (sql.includes("payment_charge_bundle_insert_components")) {
      return { rows: [{ id: "00000000-0000-4000-8000-000000000501" }] as T[] };
    }
    if (sql.includes("payment_charge_bundle_insert_allocation")) {
      return { rows: [{ id: "00000000-0000-4000-8000-000000000601" }] as T[] };
    }
    return { rows: [] as T[] };
  }
}

function execute(
  fake: FakeClient,
  provider: "sepay_va" | "nowpayments" = "sepay_va",
  enabled = true,
) {
  const row = fake.row || lockedRow(provider);
  return recordProviderInitialPostedChargeFromLockedStateV1({
    client: fake as unknown as PoolClient,
    config: { enabled },
    transactionContext: {
      ownership: "caller",
      orderCreatedInCurrentTransaction: true,
    },
    repositoryOptions: { statementTimeoutMs: 5_000, lockTimeoutMs: 1_000 },
  }, {
    paymentIntentId: String(row.intent_id),
    orderId: String(row.order_id),
    provider,
    providerEventId: String(row.provider_event_id),
  });
}

function feeRow(provider: "sepay_va" | "nowpayments" = "sepay_va") {
  return { ...lockedRow(provider), component_version: 2, tax_mode: "inclusive", merchandise_gross_minor: "240000", discount_minor: "24000",
    merchandise_net_minor: "216000", shipping_minor: "20000", merchandise_vat_minor: "19636", shipping_vat_minor: "1818",
    payment_fee_minor: "4320", payment_fee_vat_minor: "393", vat_minor: "21847", total_minor: "240320", intent_amount: "240320",
    ...(provider === "sepay_va" ? { provider_event_amount: "240320" } : {}),
  };
}
describe("locked provider caller with versioned fee components", () => {
  it.each(["sepay_va", "nowpayments"] as const)("selects V2 from actual locked %s state", async (provider) => {
    const fake = new FakeClient(); fake.row = feeRow(provider);
    expect(await execute(fake, provider)).toMatchObject({ enabled: true, kind: "recorded", amountMinor: 240_320, method: "provider", status: "posted" });
    expect(fake.calls.find((call) => call.sql.includes("insert_components"))?.params?.slice(-2)).toEqual([4_320, 393]);
    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql.trim()))).toBe(false);
  });
  it.each([1, 3])("does not hide a fee behind component version %i", async (component_version) => {
    const fake = new FakeClient(); fake.row = { ...feeRow(), component_version };
    await expect(execute(fake)).rejects.toThrow(/component version|fee/);
    expect(fake.calls.some((call) => /INSERT INTO/.test(call.sql))).toBe(false);
  });
});

describe("PAY-02G locked provider initial-posted caller", () => {
  it("is frozen default-on and retains an explicit disabled no-query seam", async () => {
    const fake = new FakeClient();
    expect(PROVIDER_INITIAL_POSTED_CHARGE_CALLER_DEFAULT_CONFIG_V1).toEqual({ enabled: true });
    expect(Object.isFrozen(PROVIDER_INITIAL_POSTED_CHARGE_CALLER_DEFAULT_CONFIG_V1)).toBe(true);
    await expect(execute(fake, "sepay_va", false)).resolves.toEqual({
      enabled: false,
      status: "disabled",
    });
    expect(fake.calls).toEqual([]);
  });

  it("requires explicit caller-owned same-transaction context before any query", async () => {
    const fake = new FakeClient();
    await expect(recordProviderInitialPostedChargeFromLockedStateV1({
      client: fake as unknown as PoolClient,
      config: { enabled: true },
      transactionContext: {
        ownership: "repository" as never,
        orderCreatedInCurrentTransaction: true,
      },
      repositoryOptions: { statementTimeoutMs: 5_000, lockTimeoutMs: 1_000 },
    }, {
      paymentIntentId: "pi-sepay-a",
      orderId: "order-a",
      provider: "sepay_va",
      providerEventId: "sepay-event-1",
    })).rejects.toThrow("caller-owned transaction context");
    expect(fake.calls).toEqual([]);
  });

  it("locks mutable settlement state and the parent revision before reading immutable components", async () => {
    const fake = new FakeClient();
    await expect(execute(fake)).resolves.toMatchObject({
      enabled: true,
      kind: "recorded",
      outcome: "inserted",
      amountMinor: 125000,
      status: "posted",
    });
    const lock = fake.calls[0]!;
    const normalizedSql = lock.sql.replace(/\s+/g, " ").toLowerCase();
    expect(normalizedSql).toContain("provider_initial_posted_charge_locked_state");
    expect(normalizedSql.match(/for update/g)).toHaveLength(4);
    for (const relation of [
      "app.payment_intents",
      "app.payment_provider_events",
      'public."order"',
      "app.order_commercial_revisions",
      "app.order_commercial_revision_components",
    ]) expect(normalizedSql).toContain(relation);
    expect(lock.params).toEqual(["pi-sepay-a", "order-a", "sepay_va", "sepay-event-1"]);
    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql))).toBe(false);
  });

  it("derives NOWPayments quote, occurrence and evidence only from locked rows", async () => {
    const fake = new FakeClient();
    fake.row = lockedRow("nowpayments");
    await expect(execute(fake, "nowpayments")).resolves.toMatchObject({
      kind: "recorded",
      amountMinor: 125000,
    });
    const evidenceInsert = fake.calls.find((call) => call.sql.includes("insert_evidence"));
    const payload = JSON.parse(String(evidenceInsert?.params?.[9]));
    expect(payload.evidence).toMatchObject({
      provider: "nowpayments",
      providerAmount: "5",
      expectedProviderAmount: "5",
      providerCurrencyCode: "usdttrc20",
      settlementOccurredAt: "2026-08-05T03:00:00.000Z",
      providerConfigId: "cfg-now-retail-primary",
    });
  });

  it("fails closed for missing locked state and every lifecycle/scope drift", async () => {
    const cases: Array<(row: ReturnType<typeof lockedRow>) => void> = [
      (row) => { row.intent_status = "completed"; },
      (row) => { row.intent_completed_order_id = "order-a"; },
      (row) => { row.provider_event_status = "matched"; },
      (row) => { row.provider_event_store_id = "store-b"; },
      (row) => { row.order_merchant_id = "merchant-b"; },
      (row) => { row.revision = 1; },
      (row) => { row.revision_source_type = "order_correction"; },
      (row) => { row.revision_data_quality = "partial"; },
    ];
    for (const mutate of cases) {
      const fake = new FakeClient();
      const row = lockedRow();
      mutate(row);
      fake.row = row;
      await expect(execute(fake)).rejects.toBeInstanceOf(
        ProviderInitialPostedChargeCallerValidationErrorV1,
      );
      expect(fake.calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
    }
    const missing = new FakeClient();
    missing.row = null;
    await expect(execute(missing)).rejects.toThrow("locked provider settlement state is unavailable");
  });

  it("rejects locked total, provider quote/config and provider-occurrence drift", async () => {
    const cases: Array<(row: ReturnType<typeof lockedRow>) => void> = [
      (row) => { row.total_minor = "124999"; },
      (row) => { row.provider_event_amount = "124999"; },
      (row) => {
        (row.provider_event_payload._verification as Record<string, unknown>).providerConfigId = "other";
      },
      (row) => {
        (row.provider_event_payload._normalized as Record<string, unknown>).providerOccurredAt = null;
      },
    ];
    for (const mutate of cases) {
      const fake = new FakeClient();
      const row = lockedRow();
      mutate(row);
      fake.row = row;
      await expect(execute(fake)).rejects.toBeInstanceOf(
        ProviderInitialPostedChargeCallerValidationErrorV1,
      );
      expect(fake.calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
    }
  });

  it("delegates insert failure to the outer transaction without local rollback", async () => {
    const fake = new FakeClient();
    fake.failMarker = "payment_charge_bundle_insert_event";
    await expect(execute(fake)).rejects.toThrow("forced failure");
    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql))).toBe(false);
  });
});
