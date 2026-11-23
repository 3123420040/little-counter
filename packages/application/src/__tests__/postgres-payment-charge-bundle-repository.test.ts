import { describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import {
  createPaymentChargeBundleTaskV1,
  type NormalizedPaymentChargeBundleV1,
  type PaymentChargeBundleInputV1,
  type PaymentChargeBundleRepositoryV1,
} from "../services/payment-charge-bundle-service";
import {
  PostgresPaymentChargeBundleRepositoryV1,
} from "../services/postgres-payment-charge-bundle-repository";

const input: PaymentChargeBundleInputV1 = {
  merchantId: "merchant-a",
  storeId: "store-a",
  orderId: "order-a",
  commercialRevisionId: "00000000-0000-4000-8000-000000000101",
  commercialRevision: 1,
  currencyCode: "VND",
  minorUnitExponent: 0,
  method: "cod",
  status: "posted",
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
  evidence: {
    evidenceType: "cod_order_created",
    evidenceFingerprint: "a".repeat(64),
    sourceSystem: "order_service",
    sourceReference: "order-a:create:1",
  },
  idempotencyKey: "payment:order-a:create:1",
  sourceType: "order_created",
  sourceId: "order-a:create:1",
  sourceOccurredAt: "2026-08-05T00:00:00.000Z",
};

async function normalizedBundle(
  overrides: Partial<PaymentChargeBundleInputV1> = {},
): Promise<NormalizedPaymentChargeBundleV1> {
  let captured: NormalizedPaymentChargeBundleV1 | undefined;
  const repository: PaymentChargeBundleRepositoryV1 = {
    appendChargeBundle: async (bundle) => {
      captured = bundle;
      return {
        outcome: "inserted",
        bundleFingerprint: bundle.bundleFingerprint,
        merchantId: bundle.merchantId,
        storeId: bundle.storeId,
        orderId: bundle.orderId,
        commercialRevisionId: bundle.commercialRevisionId,
        eventIdempotencyKey: bundle.event.idempotencyKey,
        obligationId: "capture-obligation",
        paymentEventId: "capture-event",
      };
    },
  };
  const task = createPaymentChargeBundleTaskV1(
    { config: { enabled: true }, repository },
    { ...input, ...overrides },
  );
  if (!task.enabled) throw new Error("expected enabled task");
  await task.execute();
  if (!captured) throw new Error("bundle was not captured");
  return captured;
}

const obligationId = "00000000-0000-4000-8000-000000000201";
const eventId = "00000000-0000-4000-8000-000000000301";

function metadata(bundle: NormalizedPaymentChargeBundleV1) {
  return {
    bundleVersion: 1,
    bundleFingerprint: bundle.bundleFingerprint,
    commercialRevision: bundle.commercialRevision,
  };
}

function replayRow(bundle: NormalizedPaymentChargeBundleV1) {
  const bundleMetadata = metadata(bundle);
  const evidencePayload = bundle.evidence
    && Object.keys(bundle.evidence.evidencePayload).length > 0
    ? { ...bundleMetadata, evidence: bundle.evidence.evidencePayload }
    : bundleMetadata;
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
      source_type: bundle.sourceType,
      source_id: bundle.sourceId,
      source_occurred_at: bundle.sourceOccurredAt,
      metadata: bundleMetadata,
    },
    obligation_record: {
      id: obligationId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      order_id: bundle.orderId,
      commercial_revision_id: bundle.commercialRevisionId,
      obligation_kind: bundle.obligation.obligationKind,
      currency_code: bundle.currencyCode,
      minor_unit_exponent: bundle.minorUnitExponent,
      amount_minor: bundle.obligation.amountMinor,
      idempotency_key: bundle.obligation.idempotencyKey,
      source_type: bundle.sourceType,
      source_id: bundle.sourceId,
      source_occurred_at: bundle.sourceOccurredAt,
      metadata: bundleMetadata,
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
    },
    evidence_records: bundle.evidence ? [{
      payment_event_id: eventId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      evidence_type: bundle.evidence.evidenceType,
      source_system: bundle.evidence.sourceSystem,
      source_reference: bundle.evidence.sourceReference,
      verification_status: bundle.evidence.verificationStatus,
      evidence_fingerprint: bundle.evidence.evidenceFingerprint,
      source_occurred_at: bundle.evidence.sourceOccurredAt,
      evidence_payload: evidencePayload,
    }] : [],
    allocation_records: bundle.allocation ? [{
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      obligation_id: obligationId,
      payment_event_id: eventId,
      allocation_kind: bundle.allocation.allocationKind,
      currency_code: bundle.currencyCode,
      minor_unit_exponent: bundle.minorUnitExponent,
      amount_minor: bundle.allocation.amountMinor,
      idempotency_key: bundle.allocation.idempotencyKey,
      allocated_at: bundle.allocation.allocatedAt,
    }] : [],
  };
}

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];
  existingRows: Array<Record<string, unknown>> = [];
  failMarker: string | null = null;
  emptyReturnMarker: string | null = null;

  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (this.failMarker && sql.includes(this.failMarker)) {
      throw new Error(`forced failure at ${this.failMarker}`);
    }
    if (this.emptyReturnMarker && sql.includes(this.emptyReturnMarker)) {
      return { rows: [] as T[] };
    }
    if (sql.includes("payment_charge_bundle_existing")) {
      return { rows: this.existingRows as T[] };
    }
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

function repository(
  fake: FakeClient,
  transactionOwnership: "repository" | "caller" = "repository",
) {
  return new PostgresPaymentChargeBundleRepositoryV1(
    fake as unknown as PoolClient,
    { statementTimeoutMs: 5_000, lockTimeoutMs: 1_000, transactionOwnership },
  );
}

describe("PAY-01B fake-boundary PostgreSQL charge bundle repository", () => {
  it("writes one posted bundle in bounded transaction order and commits after all rows", async () => {
    const bundle = await normalizedBundle();
    const fake = new FakeClient();

    await expect(repository(fake).appendChargeBundle(bundle)).resolves.toEqual({
      outcome: "inserted",
      bundleFingerprint: bundle.bundleFingerprint,
      merchantId: bundle.merchantId,
      storeId: bundle.storeId,
      orderId: bundle.orderId,
      commercialRevisionId: bundle.commercialRevisionId,
      eventIdempotencyKey: bundle.event.idempotencyKey,
      obligationId,
      paymentEventId: eventId,
    });

    expect(fake.calls.map((call) => call.sql.trim().split("\n")[0])).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT set_config('lock_timeout', $1, true)",
      "/* payment_charge_bundle_lock */",
      "/* payment_charge_bundle_lock */",
      "/* payment_charge_bundle_existing */",
      "/* payment_charge_bundle_insert_obligation */",
      "/* payment_charge_bundle_insert_event */",
      "/* payment_charge_bundle_insert_evidence */",
      "/* payment_charge_bundle_insert_components */",
      "/* payment_charge_bundle_insert_allocation */",
      "COMMIT",
    ]);
    expect(fake.calls[1]?.params).toEqual(["5000ms"]);
    expect(fake.calls[2]?.params).toEqual(["1000ms"]);
    expect(fake.calls[3]?.params).toEqual([
      "event:merchant-a:store-a:payment:order-a:create:1",
    ]);
    expect(fake.calls[4]?.params).toEqual([
      "source:merchant-a:store-a:order_created:order-a:create:1:charge",
    ]);
    for (const call of fake.calls.filter((entry) => entry.sql.includes("INSERT INTO"))) {
      expect(call.sql).not.toContain(bundle.merchantId);
      expect(call.params).toContain(bundle.merchantId);
    }
  });

  it("writes pending provider components without evidence or collection allocation", async () => {
    const bundle = await normalizedBundle({
      method: "provider",
      status: "pending",
      evidence: undefined,
      idempotencyKey: "payment:order-a:provider:1",
      sourceId: "order-a:provider:1",
    });
    const fake = new FakeClient();

    await expect(repository(fake).appendChargeBundle(bundle)).resolves.toMatchObject({
      outcome: "inserted",
    });
    const sql = fake.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("payment_charge_bundle_insert_components");
    expect(sql).not.toContain("payment_charge_bundle_insert_evidence");
    expect(sql).not.toContain("payment_charge_bundle_insert_allocation");
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("joins a caller-owned transaction and persists only normalized provider evidence", async () => {
    const evidencePayload = {
      authenticated: true,
      provider: "sepay_va",
      providerConfigId: "sepay-bank-primary",
      providerEventId: "sepay-event-1",
      signedPayloadSha256: "b".repeat(64),
    };
    const bundle = await normalizedBundle({
      method: "provider",
      evidence: {
        evidenceType: "provider_webhook_success",
        evidenceFingerprint: "c".repeat(64),
        sourceSystem: "sepay_va",
        sourceReference: "merchant_retail:sepay-bank-primary:sepay-event-1",
        evidencePayload,
      },
      idempotencyKey: "payment:order-a:provider:sepay-event-1",
      sourceId: "sepay_va:sepay-bank-primary:sepay-event-1:intent-a",
    });
    const fake = new FakeClient();

    await expect(repository(fake, "caller").appendChargeBundle(bundle)).resolves.toMatchObject({
      outcome: "inserted",
    });

    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql))).toBe(false);
    const evidenceInsert = fake.calls.find((call) => call.sql.includes("insert_evidence"));
    expect(JSON.parse(String(evidenceInsert?.params?.[9]))).toEqual({
      ...metadata(bundle),
      evidence: evidencePayload,
    });

    const replay = new FakeClient();
    replay.existingRows = [replayRow(bundle)];
    await expect(repository(replay, "caller").appendChargeBundle(bundle)).resolves.toMatchObject({
      outcome: "replayed",
      paymentEventId: eventId,
    });
    expect(replay.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql))).toBe(false);
  });

  it("leaves rollback responsibility with the caller when an insert fails", async () => {
    const bundle = await normalizedBundle();
    const fake = new FakeClient();
    fake.failMarker = "insert_event";

    await expect(repository(fake, "caller").appendChargeBundle(bundle)).rejects.toThrow(
      "forced failure at insert_event",
    );
    expect(fake.calls.some((call) => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql))).toBe(false);
  });

  it("returns exact replay after locks without issuing any insert", async () => {
    const bundle = await normalizedBundle();
    const fake = new FakeClient();
    fake.existingRows = [replayRow(bundle)];

    await expect(repository(fake).appendChargeBundle(bundle)).resolves.toMatchObject({
      outcome: "replayed",
      obligationId,
      paymentEventId: eventId,
    });
    expect(fake.calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("rejects replay component/evidence/allocation drift and rolls back", async () => {
    const bundle = await normalizedBundle();
    for (const mutate of [
      (row: ReturnType<typeof replayRow>) => {
        row.component_record.vat_minor = 899;
      },
      (row: ReturnType<typeof replayRow>) => {
        row.evidence_records = [];
      },
      (row: ReturnType<typeof replayRow>) => {
        row.allocation_records[0]!.amount_minor = 11_999;
      },
    ]) {
      const fake = new FakeClient();
      const row = replayRow(bundle);
      mutate(row);
      fake.existingRows = [row];
      await expect(repository(fake).appendChargeBundle(bundle)).rejects.toThrow(
        /persisted charge bundle/i,
      );
      expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
    }
  });

  it("rolls back an injected failure at every insert boundary and never commits", async () => {
    const bundle = await normalizedBundle();
    for (const marker of [
      "insert_obligation",
      "insert_event",
      "insert_evidence",
      "insert_components",
      "insert_allocation",
    ]) {
      const fake = new FakeClient();
      fake.failMarker = marker;
      await expect(repository(fake).appendChargeBundle(bundle)).rejects.toThrow("forced failure");
      expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
      expect(fake.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    }

    const missingComponent = new FakeClient();
    missingComponent.emptyReturnMarker = "insert_components";
    await expect(repository(missingComponent).appendChargeBundle(bundle)).rejects.toThrow(
      /insert coverage drift/i,
    );
    expect(missingComponent.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("fails before BEGIN for a forged normalized fingerprint or unsafe timeouts", async () => {
    const bundle = await normalizedBundle();
    const fake = new FakeClient();
    await expect(repository(fake).appendChargeBundle({
      ...bundle,
      bundleFingerprint: "b".repeat(64),
    })).rejects.toThrow(/normalized charge bundle/i);
    expect(fake.calls).toEqual([]);

    expect(() => new PostgresPaymentChargeBundleRepositoryV1(
      fake as unknown as PoolClient,
      { statementTimeoutMs: 0, lockTimeoutMs: 1 },
    )).toThrow();
    expect(() => new PostgresPaymentChargeBundleRepositoryV1(
      fake as unknown as PoolClient,
      { statementTimeoutMs: 1_000, lockTimeoutMs: 1_001 },
    )).toThrow();
    expect(fake.calls).toEqual([]);
  });

  it("sanitizes rollback failure while preserving the original storage error", async () => {
    const bundle = await normalizedBundle();
    const fake = new FakeClient();
    fake.failMarker = "insert_event";
    const originalQuery = fake.query.bind(fake);
    fake.query = async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql === "ROLLBACK") throw new Error("rollback transport failed");
      return originalQuery<T>(sql, params);
    };

    await expect(repository(fake).appendChargeBundle(bundle)).rejects.toThrow(
      "forced failure at insert_event",
    );
  });
});
