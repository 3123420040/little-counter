import { describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import {
  confirmInitialManualBankPaymentWithClientV1,
} from "../services/manual-bank-confirmation-service";

const revisionId = "00000000-0000-4000-8000-000000000101";
const pendingEventId = "00000000-0000-4000-8000-000000000201";
const obligationId = "00000000-0000-4000-8000-000000000301";
const insertedEventId = "00000000-0000-4000-8000-000000000401";

const scope = {
  organizationId: "org-a",
  merchantId: "merchant-a",
  storeId: "store-a",
  stockLocationId: "location-a",
};

const actor = {
  operatorId: "operator-accountant",
  role: "accountant",
  organizationId: "org-a",
  requestId: "request-manual-bank-1",
};

function authoritativeRow() {
  return {
    pending_event_id: pendingEventId,
    pending_idempotency_key: "payment:order-a:create:1",
    pending_source_id: "order-a:create:1",
    pending_source_occurred_at: "2026-08-05T00:00:00.000Z",
    obligation_id: obligationId,
    obligation_idempotency_key: "payment:order-a:create:1:obligation",
    obligation_amount_minor: "12000",
    commercial_revision_id: revisionId,
    commercial_revision: 0,
    currency_code: "VND",
    minor_unit_exponent: 0,
    tax_mode: "exclusive",
    merchandise_gross_minor: "10000",
    discount_minor: "1000",
    merchandise_net_minor: "9000",
    shipping_minor: "2000",
    merchandise_vat_minor: "900",
    shipping_vat_minor: "0",
    vat_minor: "900",
    unclassified_minor: "100",
    total_minor: "12000",
  };
}

function pendingRecord() {
  return {
    id: pendingEventId,
    merchant_id: scope.merchantId,
    store_id: scope.storeId,
    order_id: "order-a",
    commercial_revision_id: revisionId,
    kind: "charge",
    status: "pending",
    method: "manual_bank",
    evidence_type: null,
    evidence_fingerprint: null,
    currency_code: "VND",
    minor_unit_exponent: 0,
    amount_minor: 12000,
    idempotency_key: "payment:order-a:create:1",
    source_type: "order_created",
    source_id: "order-a:create:1",
    source_occurred_at: "2026-08-05T00:00:00.000Z",
  };
}

function obligationRecord() {
  return {
    id: obligationId,
    merchant_id: scope.merchantId,
    store_id: scope.storeId,
    order_id: "order-a",
    commercial_revision_id: revisionId,
    obligation_kind: "order_charge",
    currency_code: "VND",
    minor_unit_exponent: 0,
    amount_minor: 12000,
    idempotency_key: "payment:order-a:create:1:obligation",
    source_type: "order_created",
    source_id: "order-a:create:1",
    source_occurred_at: "2026-08-05T00:00:00.000Z",
  };
}

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];
  authoritativeRows: Array<Record<string, unknown>> = [authoritativeRow()];

  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql === "SELECT status FROM app.merchants WHERE id=$1 FOR SHARE"
      || sql === "SELECT status FROM app.stores WHERE merchant_id=$1 AND id=$2 FOR SHARE") {
      return { rows: [{ status: "active" }] as T[] };
    }
    if (sql.includes("manual_bank_confirmation_authoritative_initial")) {
      return { rows: this.authoritativeRows as T[] };
    }
    if (sql.includes("payment_later_confirmation_order_lock")) return { rows: [{ status: "completed" }] as T[] };
    if (sql.includes("payment_later_confirmation_state")) {
      return { rows: [{
        pending_record: { ...pendingRecord(), amount_minor: Number(this.authoritativeRows[0]?.total_minor ?? 12_000) },
        obligation_record: { ...obligationRecord(), amount_minor: Number(this.authoritativeRows[0]?.total_minor ?? 12_000) },
      }] as T[] };
    }
    if (sql.includes("payment_later_confirmation_components_v2")) return { rows: [{ valid: 1 }] as T[] };
    if (sql.includes("payment_later_confirmation_existing")) return { rows: [] as T[] };
    if (sql.includes("payment_later_confirmation_collected")) {
      return { rows: [{ collected_minor: "0" }] as T[] };
    }
    const ids: Record<string, string> = {
      insert_event: insertedEventId,
      insert_evidence: "00000000-0000-4000-8000-000000000501",
      insert_components: "00000000-0000-4000-8000-000000000601",
      insert_allocation: "00000000-0000-4000-8000-000000000701",
    };
    for (const [marker, id] of Object.entries(ids)) {
      if (sql.includes(marker)) return { rows: [{ id }] as T[] };
    }
    if (sql.includes("INSERT INTO audit.events")) {
      return { rows: [{
        id: "00000000-0000-4000-8000-000000000801",
        created_at: "2026-08-05T01:00:00.000Z",
      }] as T[] };
    }
    return { rows: [] as T[] };
  }
}

function call(fake: FakeClient, overrides: {
  headers?: Record<string, string>;
  body?: { sourceReference: string; confirmedAt: string };
  enabled?: boolean;
  orderId?: string;
} = {}) {
  return confirmInitialManualBankPaymentWithClientV1(
    fake as unknown as PoolClient,
    overrides.headers || { "idempotency-key": "manual-bank-intent-001" },
    overrides.orderId || "order-a",
    overrides.body || {
      sourceReference: "bank-slip-100",
      confirmedAt: "2026-08-05T01:00:00.000Z",
    },
    actor,
    scope,
    { enabled: overrides.enabled ?? true },
  );
}

describe("manual-bank confirmation application service", () => {
  function feeRow(component_version = 2) {
    return { ...authoritativeRow(), component_version, tax_mode: "inclusive", merchandise_gross_minor: "240000", discount_minor: "24000",
      merchandise_net_minor: "216000", shipping_minor: "20000", merchandise_vat_minor: "19636", shipping_vat_minor: "1818",
      payment_fee_minor: "4320", payment_fee_vat_minor: "393", vat_minor: "21847", unclassified_minor: "0",
      total_minor: "240320", obligation_amount_minor: "240320" };
  }
  it("confirms the full fee-bearing pending amount using only stored V2 components", async () => {
    const fake = new FakeClient(); fake.authoritativeRows = [feeRow()];
    expect(await call(fake)).toMatchObject({ statusCode: 201, response: { data: { status: "posted", method: "manual_bank", amountMinor: 240_320 } } });
    expect(fake.calls.find((entry) => entry.sql.includes("insert_components"))?.params?.slice(-2)).toEqual([4_320, 393]);
  });
  it.each([1, 3])("rejects inconsistent persisted component version %i before inserts", async (componentVersion) => {
    const fake = new FakeClient(); fake.authoritativeRows = [feeRow(componentVersion)];
    await expect(call(fake)).rejects.toMatchObject({ code: "manual_bank_confirmation_state_invalid", statusCode: 409 });
    expect(fake.calls.some((entry) => entry.sql.includes("INSERT INTO"))).toBe(false);
  });
  it("is default-off and performs no database read or write when disabled", async () => {
    const fake = new FakeClient();
    await expect(call(fake, { enabled: false })).rejects.toMatchObject({
      code: "manual_bank_confirmation_disabled",
      statusCode: 404,
    });
    expect(fake.calls).toEqual([]);
  });

  it("rejects non-exact bodies, malformed timestamps and missing stable intent keys", async () => {
    const cases = [
      () => confirmInitialManualBankPaymentWithClientV1(
        new FakeClient() as unknown as PoolClient,
        { "idempotency-key": "manual-bank-intent-001" },
        "order-a",
        { sourceReference: "bank-slip-100", confirmedAt: "2026-08-05T01:00:00Z", extra: true } as never,
        actor,
        scope,
        { enabled: true },
      ),
      () => call(new FakeClient(), {
        body: { sourceReference: "bank-slip-100", confirmedAt: "invalid" },
      }),
      () => call(new FakeClient(), { headers: {} }),
    ];
    for (const candidate of cases) {
      await expect(candidate()).rejects.toBeInstanceOf(PlatformError);
    }
  });

  it("derives scope, money and payment identity server-side, then writes audit before commit", async () => {
    const fake = new FakeClient();
    await expect(call(fake)).resolves.toEqual({
      statusCode: 201,
      response: {
        data: {
          orderId: "order-a",
          status: "posted",
          method: "manual_bank",
          outcome: "inserted",
          paymentEventId: insertedEventId,
          priorPendingPaymentEventId: pendingEventId,
          amountMinor: 12000,
          currencyCode: "VND",
          minorUnitExponent: 0,
          sourceReference: "bank-slip-100",
          confirmedAt: "2026-08-05T01:00:00.000Z",
        },
      },
    });

    const authoritative = fake.calls.find((entry) =>
      entry.sql.includes("manual_bank_confirmation_authoritative_initial"),
    );
    expect(authoritative?.params).toEqual([scope.merchantId, scope.storeId, "order-a"]);
    const eventInsert = fake.calls.find((entry) =>
      entry.sql.includes("payment_later_confirmation_insert_event"),
    );
    expect(eventInsert?.params).toEqual(expect.arrayContaining([
      scope.merchantId,
      scope.storeId,
      "order-a",
      "manual_bank",
      "manual_verified",
      12000,
    ]));
    const auditIndex = fake.calls.findIndex((entry) => entry.sql.includes("INSERT INTO audit.events"));
    const commitIndex = fake.calls.findIndex((entry) => entry.sql === "COMMIT");
    expect(auditIndex).toBeGreaterThan(0);
    expect(auditIndex).toBeLessThan(commitIndex);
  });

  it("fails closed when scoped authoritative state is missing or confirmation predates order", async () => {
    const missing = new FakeClient();
    missing.authoritativeRows = [];
    await expect(call(missing)).rejects.toMatchObject({
      code: "manual_bank_confirmation_unavailable",
      statusCode: 409,
    });

    const predated = new FakeClient();
    await expect(call(predated, {
      body: {
        sourceReference: "bank-slip-100",
        confirmedAt: "2026-08-04T23:59:59.999Z",
      },
    })).rejects.toMatchObject({
      code: "manual_bank_confirmation_conflict",
      statusCode: 409,
    });
    expect(predated.calls.some((entry) => entry.sql === "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED")).toBe(false);
  });
});
