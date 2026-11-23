import { describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import {
  createPaymentLaterConfirmationTaskV1,
  createPaymentLaterConfirmationTaskV2,
  type NormalizedPaymentLaterConfirmationV2,
  type NormalizedPaymentLaterConfirmationV1,
  type PaymentLaterConfirmationInputV1,
} from "../services/payment-later-confirmation-contract";
import {
  PostgresPaymentLaterConfirmationRepositoryV1,
} from "../services/postgres-payment-later-confirmation-repository";

const input: PaymentLaterConfirmationInputV1 = {
  merchantId: "merchant-a",
  storeId: "store-a",
  orderId: "order-a",
  commercialRevisionId: "00000000-0000-4000-8000-000000000101",
  commercialRevision: 1,
  currencyCode: "VND",
  minorUnitExponent: 0,
  components: {
    taxMode: "exclusive",
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
    method: "provider",
    status: "pending",
    amountMinor: 12_000,
    sourceType: "order_created",
    sourceId: "order-a:create:1",
    sourceOccurredAt: "2026-08-05T00:00:00.000Z",
    evidenceType: null,
    evidenceFingerprint: null,
  },
  confirmation: {
    kind: "provider_success",
    evidenceFingerprint: "c".repeat(64),
    sourceSystem: "sepay",
    sourceReference: "provider-confirmation-100",
    confirmedAt: "2026-08-05T01:00:00.000Z",
  },
};

function normalizedBundle(): NormalizedPaymentLaterConfirmationV1 {
  const task = createPaymentLaterConfirmationTaskV1(input, { enabled: true });
  if (!task.enabled) throw new Error("expected enabled task");
  return task.bundle;
}

function normalizedManualBankBundle(): NormalizedPaymentLaterConfirmationV1 {
  const task = createPaymentLaterConfirmationTaskV1({
    ...input,
    pendingAttempt: {
      ...input.pendingAttempt,
      method: "manual_bank",
    },
    confirmation: {
      kind: "manual_bank_verified",
      evidenceFingerprint: "d".repeat(64),
      sourceSystem: "manual_bank_operator_attestation",
      sourceReference: "bank-slip-100",
      confirmedAt: "2026-08-05T01:00:00.000Z",
    },
  }, { enabled: true });
  if (!task.enabled) throw new Error("expected enabled task");
  return task.bundle;
}

type LaterBundle = NormalizedPaymentLaterConfirmationV1 | NormalizedPaymentLaterConfirmationV2;

const eventId = "00000000-0000-4000-8000-000000000401";

function stateRow(bundle: LaterBundle) {
  return {
    pending_record: {
      id: bundle.priorPendingPaymentEventId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      order_id: bundle.orderId,
      commercial_revision_id: bundle.commercialRevisionId,
      kind: "charge",
      status: "pending",
      method: bundle.event.method,
      evidence_type: null,
      evidence_fingerprint: null,
      currency_code: bundle.currencyCode,
      minor_unit_exponent: bundle.minorUnitExponent,
      amount_minor: bundle.event.amountMinor,
      idempotency_key: bundle.priorPendingIdempotencyKey,
      source_type: bundle.priorPendingSourceType,
      source_id: bundle.priorPendingSourceId,
      source_occurred_at: bundle.priorPendingSourceOccurredAt,
    },
    obligation_record: {
      id: bundle.obligationId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      order_id: bundle.orderId,
      commercial_revision_id: bundle.commercialRevisionId,
      obligation_kind: "order_charge",
      currency_code: bundle.currencyCode,
      minor_unit_exponent: bundle.minorUnitExponent,
      amount_minor: bundle.components.totalMinor,
      idempotency_key: bundle.obligationIdempotencyKey,
      source_type: bundle.priorPendingSourceType,
      source_id: bundle.priorPendingSourceId,
      source_occurred_at: bundle.priorPendingSourceOccurredAt,
    },
  };
}

function replayRow(bundle: LaterBundle) {
  const metadata = {
    bundleVersion: bundle.bundleVersion,
    bundleFingerprint: bundle.bundleFingerprint,
    priorPendingPaymentEventId: bundle.priorPendingPaymentEventId,
    obligationId: bundle.obligationId,
  };
  return {
    event_record: {
      id: eventId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      order_id: bundle.orderId,
      commercial_revision_id: bundle.commercialRevisionId,
      kind: bundle.event.kind,
      status: bundle.event.status,
      method: bundle.event.method,
      evidence_type: bundle.event.evidenceType,
      evidence_fingerprint: bundle.event.evidenceFingerprint,
      currency_code: bundle.currencyCode,
      minor_unit_exponent: bundle.minorUnitExponent,
      amount_minor: bundle.event.amountMinor,
      idempotency_key: bundle.event.idempotencyKey,
      source_type: bundle.event.sourceType,
      source_id: bundle.event.sourceId,
      source_occurred_at: bundle.event.sourceOccurredAt,
      metadata,
    },
    component_record: {
      payment_event_id: eventId,
      commercial_revision_id: bundle.commercialRevisionId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      currency_code: bundle.currencyCode,
      minor_unit_exponent: bundle.minorUnitExponent,
      tax_mode: bundle.components.taxMode,
      merchandise_gross_minor: bundle.components.merchandiseGrossMinor,
      discount_minor: bundle.components.discountMinor,
      merchandise_net_minor: bundle.components.merchandiseNetMinor,
      shipping_minor: bundle.components.shippingMinor,
      merchandise_vat_minor: bundle.components.merchandiseVatMinor,
      shipping_vat_minor: bundle.components.shippingVatMinor,
      vat_minor: bundle.components.vatMinor,
      unclassified_minor: bundle.components.unclassifiedMinor,
      total_minor: bundle.components.totalMinor,
      ...(bundle.bundleVersion === 2 ? { component_version: 2, payment_fee_minor: bundle.components.paymentFeeMinor,
        payment_fee_vat_minor: bundle.components.paymentFeeVatMinor } : {}),
    },
    evidence_records: [{
      payment_event_id: eventId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      evidence_type: bundle.evidence.evidenceType,
      source_system: bundle.evidence.sourceSystem,
      source_reference: bundle.evidence.sourceReference,
      verification_status: bundle.evidence.verificationStatus,
      evidence_fingerprint: bundle.evidence.evidenceFingerprint,
      source_occurred_at: bundle.evidence.sourceOccurredAt,
      evidence_payload: metadata,
    }],
    allocation_records: [{
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      obligation_id: bundle.obligationId,
      payment_event_id: eventId,
      allocation_kind: bundle.allocation.allocationKind,
      currency_code: bundle.currencyCode,
      minor_unit_exponent: bundle.minorUnitExponent,
      amount_minor: bundle.allocation.amountMinor,
      idempotency_key: bundle.allocation.idempotencyKey,
      allocated_at: bundle.allocation.allocatedAt,
    }],
  };
}

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];
  bundle: LaterBundle = normalizedBundle();
  componentsMatch = true;
  existingRows: Array<Record<string, unknown>> = [];
  collectedMinor = "0";
  orderStatus = "completed";
  merchantStatus = "active";
  storeStatus = "active";
  failMarker: string | null = null;
  emptyReturnMarker: string | null = null;

  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql === "SELECT status FROM app.merchants WHERE id=$1 FOR SHARE") return { rows: [{ status: this.merchantStatus }] as T[] };
    if (sql === "SELECT status FROM app.stores WHERE merchant_id=$1 AND id=$2 FOR SHARE") return { rows: [{ status: this.storeStatus }] as T[] };
    if (this.failMarker && sql.includes(this.failMarker)) {
      throw new Error(`forced failure at ${this.failMarker}`);
    }
    if (this.emptyReturnMarker && sql.includes(this.emptyReturnMarker)) {
      return { rows: [] as T[] };
    }
    if (sql.includes("payment_later_confirmation_order_lock")) return { rows: [{ status: this.orderStatus }] as T[] };
    if (sql.includes("payment_later_confirmation_components_v2")) return { rows: this.componentsMatch ? [{ valid: 1 }] as T[] : [] as T[] };
    if (sql.includes("payment_later_confirmation_state")) {
      return { rows: [stateRow(this.bundle)] as T[] };
    }
    if (sql.includes("payment_later_confirmation_existing")) {
      return { rows: this.existingRows as T[] };
    }
    if (sql.includes("payment_later_confirmation_collected")) {
      return { rows: [{ collected_minor: this.collectedMinor }] as T[] };
    }
    const ids: Record<string, string> = {
      insert_event: eventId,
      insert_evidence: "00000000-0000-4000-8000-000000000501",
      insert_components: "00000000-0000-4000-8000-000000000601",
      insert_allocation: "00000000-0000-4000-8000-000000000701",
    };
    for (const [marker, id] of Object.entries(ids)) {
      if (sql.includes(marker)) return { rows: [{ id }] as T[] };
    }
    if (sql.includes("INSERT INTO audit.events")) {
      return {
        rows: [{
          id: "00000000-0000-4000-8000-000000000801",
          created_at: "2026-08-05T01:00:00.000Z",
        }] as T[],
      };
    }
    return { rows: [] as T[] };
  }
}

function repository(fake: FakeClient) {
  return new PostgresPaymentLaterConfirmationRepositoryV1(
    fake as unknown as PoolClient,
    { statementTimeoutMs: 5_000, lockTimeoutMs: 1_000 },
  );
}

function feeBundle(): NormalizedPaymentLaterConfirmationV2 {
  const task = createPaymentLaterConfirmationTaskV2({ ...input, components: {
    taxMode: "inclusive", merchandiseGrossMinor: 240_000, discountMinor: 24_000, merchandiseNetMinor: 216_000,
    shippingMinor: 20_000, merchandiseVatMinor: 19_636, shippingVatMinor: 1_818, vatMinor: 21_847,
    unclassifiedMinor: 0, totalMinor: 240_320, paymentFeeMinor: 4_320, paymentFeeVatMinor: 393 },
    obligation: { ...input.obligation, amountMinor: 240_320 }, pendingAttempt: { ...input.pendingAttempt, amountMinor: 240_320 },
  }, { enabled: true });
  if (!task.enabled) throw new Error("confirmation must be enabled");
  return task.bundle;
}
describe("V2 later-confirmation repository", () => {
  it("writes full fee components and replays the frozen event", async () => {
    const fake = new FakeClient(); fake.bundle = feeBundle();
    expect(await repository(fake).appendLaterConfirmation(fake.bundle)).toMatchObject({ outcome: "inserted" });
    expect(fake.calls.find((call) => call.sql.includes("insert_components"))?.params?.slice(-2)).toEqual([4_320, 393]);
    fake.existingRows = [replayRow(fake.bundle)];
    expect(await repository(fake).appendLaterConfirmation(fake.bundle)).toMatchObject({ outcome: "replayed" });
  });
  it("rejects mismatched pending/revision components before inserts", async () => {
    const fake = new FakeClient(); fake.bundle = feeBundle(); fake.componentsMatch = false;
    await expect(repository(fake).appendLaterConfirmation(fake.bundle)).rejects.toThrow("revision/pending component");
    expect(fake.calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});

describe("PAY-02C fake-boundary PostgreSQL later-confirmation repository", () => {
  it.each(["merchantStatus", "storeStatus"] as const)("refuses collection under an inactive %s before payment locks or writes", async field => {
    const fake = new FakeClient(); fake[field] = "suspended";
    await expect(repository(fake).appendLaterConfirmation(fake.bundle)).rejects.toMatchObject({ code: "scope_suspended" });
    expect(fake.calls.some(call => call.sql.includes("INSERT INTO") || call.sql.includes("confirmation_order_lock"))).toBe(false);
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("rejects a new collection on a canceled order but preserves a committed replay", async () => {
    const fake = new FakeClient(); fake.orderStatus = "canceled";
    await expect(repository(fake).appendLaterConfirmation(fake.bundle)).rejects.toMatchObject({ code: "invalid_state_transition" });
    expect(fake.calls.some((c) => c.sql.includes("INSERT INTO"))).toBe(false);
    fake.existingRows = [replayRow(fake.bundle)];
    expect((await repository(fake).appendLaterConfirmation(fake.bundle)).outcome).toBe("replayed");
  });

  it("locks authoritative state then writes one posted bundle in exact order", async () => {
    const fake = new FakeClient();
    const bundle = fake.bundle;
    await expect(repository(fake).appendLaterConfirmation(bundle)).resolves.toMatchObject({
      outcome: "inserted",
      bundleFingerprint: bundle.bundleFingerprint,
      paymentEventId: eventId,
      obligationId: bundle.obligationId,
    });
    expect(fake.calls.map((call) => call.sql.trim().split("\n")[0])).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT set_config('lock_timeout', $1, true)",
      "SAVEPOINT business_lifecycle_guard; RELEASE SAVEPOINT business_lifecycle_guard",
      "SELECT status FROM app.merchants WHERE id=$1 FOR SHARE",
      "SELECT status FROM app.stores WHERE merchant_id=$1 AND id=$2 FOR SHARE",
      "/* payment_later_confirmation_order_lock */",
      "/* payment_later_confirmation_lock */",
      "/* payment_later_confirmation_lock */",
      "/* payment_later_confirmation_lock */",
      "/* payment_later_confirmation_lock */",
      "/* payment_later_confirmation_lock */",
      "/* payment_later_confirmation_state */",
      "/* payment_later_confirmation_existing */",
      "/* payment_later_confirmation_collected */",
      "/* payment_later_confirmation_insert_event */",
      "/* payment_later_confirmation_insert_evidence */",
      "/* payment_later_confirmation_insert_components */",
      "/* payment_later_confirmation_insert_allocation */",
      "COMMIT",
    ]);
    expect(fake.calls.find(call => call.sql.includes("payment_later_confirmation_state"))!.sql).toContain("FOR UPDATE OF pending, obligations");
    expect(fake.calls.filter(call => call.sql.includes("/* payment_later_confirmation_lock */")).map((call) => call.params?.[0])).toContain(
      `confirmation-evidence:${bundle.merchantId}:${bundle.storeId}:${bundle.evidence.sourceSystem}:${bundle.evidence.sourceReference}`,
    );
  });

  it("returns exact replay before requiring zero current collection", async () => {
    const fake = new FakeClient();
    fake.existingRows = [replayRow(fake.bundle)];
    fake.collectedMinor = "12000";
    await expect(repository(fake).appendLaterConfirmation(fake.bundle)).resolves.toMatchObject({
      outcome: "replayed",
      paymentEventId: eventId,
    });
    expect(fake.calls.some((call) => call.sql.includes("payment_later_confirmation_collected"))).toBe(false);
    expect(fake.calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("requires and appends immutable manual-bank operator audit inside the write transaction", async () => {
    const fake = new FakeClient();
    fake.bundle = normalizedManualBankBundle();
    await expect(repository(fake).appendLaterConfirmation(fake.bundle, {
      actor: {
        operatorId: "operator-accountant",
        role: "accountant",
        requestId: "request-manual-bank-1",
      },
      clientIntentFingerprint: "e".repeat(64),
    })).resolves.toMatchObject({ outcome: "inserted" });

    const auditIndex = fake.calls.findIndex((call) => call.sql.includes("INSERT INTO audit.events"));
    const commitIndex = fake.calls.findIndex((call) => call.sql === "COMMIT");
    expect(auditIndex).toBeGreaterThan(0);
    expect(auditIndex).toBeLessThan(commitIndex);
    expect(fake.calls[auditIndex]?.params).toEqual(expect.arrayContaining([
      fake.bundle.merchantId,
      fake.bundle.storeId,
      "operator-accountant",
      "payment.manual_bank_confirmed",
      "order",
      fake.bundle.orderId,
    ]));
    expect(String(fake.calls[auditIndex]?.params?.[9])).toContain("clientIntentFingerprint");
  });

  it("rolls back manual-bank persistence when its required audit context is missing", async () => {
    const fake = new FakeClient();
    fake.bundle = normalizedManualBankBundle();
    await expect(repository(fake).appendLaterConfirmation(fake.bundle)).rejects.toThrow(
      /manual-bank audit context is invalid/i,
    );
    expect(fake.calls.some((call) => call.sql.includes("INSERT INTO audit.events"))).toBe(false);
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects pending/obligation authoritative-state drift", async () => {
    for (const mutate of [
      (fake: FakeClient) => {
        fake.bundle = { ...fake.bundle, priorPendingSourceId: "different-source" };
      },
      (fake: FakeClient) => {
        fake.bundle = { ...fake.bundle, obligationIdempotencyKey: "different-obligation" };
      },
    ]) {
      const fake = new FakeClient();
      const requested = fake.bundle;
      mutate(fake);
      await expect(repository(fake).appendLaterConfirmation(requested)).rejects.toThrow(
        /persisted later confirmation/i,
      );
      expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
    }
  });

  it("rejects a newly observed prior collection before inserts", async () => {
    const fake = new FakeClient();
    fake.collectedMinor = "1";
    await expect(repository(fake).appendLaterConfirmation(fake.bundle)).rejects.toThrow(
      /already collected/i,
    );
    expect(fake.calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects existing event/component/evidence/allocation drift", async () => {
    const fake = new FakeClient();
    const row = replayRow(fake.bundle);
    row.allocation_records[0]!.amount_minor = 11_999;
    fake.existingRows = [row];
    await expect(repository(fake).appendLaterConfirmation(fake.bundle)).rejects.toThrow(
      /persisted later confirmation/i,
    );
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects reuse of a provider evidence source identity by another event", async () => {
    const fake = new FakeClient();
    const row = replayRow(fake.bundle);
    row.event_record = {
      ...row.event_record,
      idempotency_key: "payment_confirmation:v1:conflicting",
      source_id: "conflicting",
    };
    fake.existingRows = [row];
    await expect(repository(fake).appendLaterConfirmation(fake.bundle)).rejects.toThrow(
      /persisted later confirmation/i,
    );
    const existingQuery = fake.calls.find((call) =>
      call.sql.includes("payment_later_confirmation_existing"),
    );
    expect(existingQuery?.sql).toContain("event_evidence.source_system");
    expect(existingQuery?.params).toEqual([
      fake.bundle.merchantId,
      fake.bundle.storeId,
      fake.bundle.event.idempotencyKey,
      fake.bundle.event.sourceType,
      fake.bundle.event.sourceId,
      fake.bundle.evidence.sourceSystem,
      fake.bundle.evidence.sourceReference,
      fake.bundle.bundleVersion,
    ]);
    expect(fake.calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rolls back failures and zero-row writes without masking the original error", async () => {
    const bundle = normalizedBundle();
    for (const marker of ["insert_event", "insert_evidence", "insert_components", "insert_allocation"]) {
      const fake = new FakeClient();
      fake.failMarker = marker;
      await expect(repository(fake).appendLaterConfirmation(bundle)).rejects.toThrow("forced failure");
      expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
    }
    const missing = new FakeClient();
    missing.emptyReturnMarker = "insert_components";
    await expect(repository(missing).appendLaterConfirmation(bundle)).rejects.toThrow(
      /insert coverage drift/i,
    );
    expect(missing.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("fails before BEGIN for forged normalized input or unsafe timeout", async () => {
    const fake = new FakeClient();
    await expect(repository(fake).appendLaterConfirmation({
      ...fake.bundle,
      bundleFingerprint: "d".repeat(64),
    })).rejects.toThrow(/normalized later confirmation/i);
    expect(fake.calls).toEqual([]);
    expect(() => new PostgresPaymentLaterConfirmationRepositoryV1(
      fake as unknown as PoolClient,
      { statementTimeoutMs: 1_000, lockTimeoutMs: 1_001 },
    )).toThrow();
    expect(fake.calls).toEqual([]);
  });
});
