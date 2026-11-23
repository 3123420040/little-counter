import type { PoolClient } from "../db/client";
import {
  PaymentChargeBundleIntegrityErrorV1,
  assertNormalizedPaymentChargeBundleV1,
  assertNormalizedPaymentChargeBundleV2,
  type NormalizedPaymentChargeBundleV1,
  type NormalizedPaymentChargeBundleV2,
  type PaymentChargeBundleRepositoryV1,
  type PaymentChargeBundleRepositoryV2,
  type PersistedPaymentChargeBundleV1,
} from "./payment-charge-bundle-service";

type ChargeBundle = NormalizedPaymentChargeBundleV1 | NormalizedPaymentChargeBundleV2;

export const PAYMENT_CHARGE_STATEMENT_TIMEOUT_HARD_CAP_MS = 30_000;
export const PAYMENT_CHARGE_LOCK_TIMEOUT_HARD_CAP_MS = 5_000;

export interface PostgresPaymentChargeBundleRepositoryOptionsV1 {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  transactionOwnership?: "repository" | "caller";
}

type ExistingBundleRow = {
  event_record: unknown;
  obligation_record: unknown;
  component_record: unknown;
  evidence_records: unknown;
  allocation_records: unknown;
};

function boundedTimeout(value: number, field: string, hardCap: number): number {
  if (!Number.isInteger(value) || value < 1 || value > hardCap) {
    throw new Error(`${field} must be between 1 and ${hardCap}`);
  }
  return value;
}

function jsonValue(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PaymentChargeBundleIntegrityErrorV1(
      `persisted charge bundle ${field} is invalid`,
    );
  }
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  const parsed = jsonValue(value, field);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PaymentChargeBundleIntegrityErrorV1(
      `persisted charge bundle ${field} is invalid`,
    );
  }
  return parsed as Record<string, unknown>;
}

function arrayValue(value: unknown, field: string): unknown[] {
  const parsed = jsonValue(value, field);
  if (!Array.isArray(parsed)) {
    throw new PaymentChargeBundleIntegrityErrorV1(
      `persisted charge bundle ${field} is invalid`,
    );
  }
  return parsed;
}

function safeInteger(value: unknown, field: string): number {
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "bigint") parsed = Number(value);
  else if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) parsed = Number(value);
  else {
    throw new PaymentChargeBundleIntegrityErrorV1(
      `persisted charge bundle ${field} is invalid`,
    );
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PaymentChargeBundleIntegrityErrorV1(
      `persisted charge bundle ${field} is invalid`,
    );
  }
  return parsed;
}

function canonicalInstant(value: unknown, field: string): string {
  const date = value instanceof Date
    ? value
    : new Date(typeof value === "string" ? value : Number.NaN);
  if (!Number.isFinite(date.getTime())) {
    throw new PaymentChargeBundleIntegrityErrorV1(
      `persisted charge bundle ${field} is invalid`,
    );
  }
  return date.toISOString();
}

function assertEquivalent(actual: unknown, expected: unknown, field: string): void {
  if (typeof expected === "number") {
    if (safeInteger(actual, field) !== expected) {
      throw new PaymentChargeBundleIntegrityErrorV1(
        `persisted charge bundle ${field} drift`,
      );
    }
    return;
  }
  if (typeof expected === "string" && (
    field.endsWith("source_occurred_at") || field.endsWith("allocated_at")
  )) {
    if (canonicalInstant(actual, field) !== expected) {
      throw new PaymentChargeBundleIntegrityErrorV1(
        `persisted charge bundle ${field} drift`,
      );
    }
    return;
  }
  if (Array.isArray(expected)) {
    const actualArray = arrayValue(actual, field);
    if (actualArray.length !== expected.length) {
      throw new PaymentChargeBundleIntegrityErrorV1(
        `persisted charge bundle ${field} count drift`,
      );
    }
    expected.forEach((item, index) => {
      assertEquivalent(actualArray[index], item, `${field}[${index}]`);
    });
    return;
  }
  if (expected && typeof expected === "object") {
    const actualRecord = recordValue(actual, field);
    const expectedRecord = expected as Record<string, unknown>;
    const actualKeys = Object.keys(actualRecord).sort();
    const expectedKeys = Object.keys(expectedRecord).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new PaymentChargeBundleIntegrityErrorV1(
        `persisted charge bundle ${field} shape drift`,
      );
    }
    for (const key of expectedKeys) {
      assertEquivalent(actualRecord[key], expectedRecord[key], `${field}.${key}`);
    }
    return;
  }
  if (actual !== expected) {
    throw new PaymentChargeBundleIntegrityErrorV1(
      `persisted charge bundle ${field} drift`,
    );
  }
}

function requiredUuid(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw new PaymentChargeBundleIntegrityErrorV1(
      `persisted charge bundle ${field} is invalid`,
    );
  }
  return value;
}

function bundleMetadata(bundle: ChargeBundle) {
  return {
    bundleVersion: bundle.bundleVersion,
    bundleFingerprint: bundle.bundleFingerprint,
    commercialRevision: bundle.commercialRevision,
  };
}

function storedEvidencePayload(bundle: ChargeBundle) {
  const metadata = bundleMetadata(bundle);
  if (!bundle.evidence || Object.keys(bundle.evidence.evidencePayload).length === 0) {
    return metadata;
  }
  return {
    ...metadata,
    evidence: bundle.evidence.evidencePayload,
  };
}

function expectedReplayRecords(
  bundle: ChargeBundle,
  obligationId: string,
  paymentEventId: string,
) {
  const metadata = bundleMetadata(bundle);
  return {
    event: {
      id: paymentEventId,
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
      metadata,
    },
    obligation: {
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
      metadata,
    },
    component: {
      payment_event_id: paymentEventId,
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
      ...(bundle.bundleVersion === 2 ? { component_version: 2,
        payment_fee_minor: bundle.components.paymentFeeMinor, payment_fee_vat_minor: bundle.components.paymentFeeVatMinor } : {}),
    },
    evidence: bundle.evidence ? [{
      payment_event_id: paymentEventId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      evidence_type: bundle.evidence.evidenceType,
      source_system: bundle.evidence.sourceSystem,
      source_reference: bundle.evidence.sourceReference,
      verification_status: bundle.evidence.verificationStatus,
      evidence_fingerprint: bundle.evidence.evidenceFingerprint,
      source_occurred_at: bundle.evidence.sourceOccurredAt,
      evidence_payload: storedEvidencePayload(bundle),
    }] : [],
    allocation: bundle.allocation ? [{
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      obligation_id: obligationId,
      payment_event_id: paymentEventId,
      allocation_kind: bundle.allocation.allocationKind,
      currency_code: bundle.currencyCode,
      minor_unit_exponent: bundle.minorUnitExponent,
      amount_minor: bundle.allocation.amountMinor,
      idempotency_key: bundle.allocation.idempotencyKey,
      allocated_at: bundle.allocation.allocatedAt,
    }] : [],
  };
}

function validateExisting(
  rows: ExistingBundleRow[],
  bundle: ChargeBundle,
): PersistedPaymentChargeBundleV1 | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new PaymentChargeBundleIntegrityErrorV1(
      "persisted charge bundle has conflicting identities",
    );
  }
  const eventRecord = recordValue(rows[0]!.event_record, "event_record");
  const obligationRecord = recordValue(rows[0]!.obligation_record, "obligation_record");
  const paymentEventId = requiredUuid(eventRecord.id, "paymentEventId");
  const obligationId = requiredUuid(obligationRecord.id, "obligationId");
  const expected = expectedReplayRecords(bundle, obligationId, paymentEventId);
  assertEquivalent(eventRecord, expected.event, "event");
  assertEquivalent(obligationRecord, expected.obligation, "obligation");
  assertEquivalent(rows[0]!.component_record, expected.component, "component");
  assertEquivalent(rows[0]!.evidence_records, expected.evidence, "evidence");
  assertEquivalent(rows[0]!.allocation_records, expected.allocation, "allocation");
  return {
    outcome: "replayed",
    bundleFingerprint: bundle.bundleFingerprint,
    merchantId: bundle.merchantId,
    storeId: bundle.storeId,
    orderId: bundle.orderId,
    commercialRevisionId: bundle.commercialRevisionId,
    eventIdempotencyKey: bundle.event.idempotencyKey,
    obligationId,
    paymentEventId,
  };
}

async function insertedId(
  client: PoolClient,
  sql: string,
  params: unknown[],
  field: string,
): Promise<string> {
  const result = await client.query<{ id: unknown }>(sql, params);
  if (result.rows.length !== 1) {
    throw new PaymentChargeBundleIntegrityErrorV1(
      `persisted charge bundle ${field} insert coverage drift`,
    );
  }
  return requiredUuid(result.rows[0]!.id, field);
}

export class PostgresPaymentChargeBundleRepositoryV1
  implements PaymentChargeBundleRepositoryV1, PaymentChargeBundleRepositoryV2 {
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  readonly transactionOwnership: "repository" | "caller";

  constructor(
    private readonly client: PoolClient,
    options: PostgresPaymentChargeBundleRepositoryOptionsV1,
  ) {
    this.statementTimeoutMs = boundedTimeout(
      options.statementTimeoutMs,
      "payment charge statement timeout",
      PAYMENT_CHARGE_STATEMENT_TIMEOUT_HARD_CAP_MS,
    );
    this.lockTimeoutMs = boundedTimeout(
      options.lockTimeoutMs,
      "payment charge lock timeout",
      PAYMENT_CHARGE_LOCK_TIMEOUT_HARD_CAP_MS,
    );
    if (this.lockTimeoutMs > this.statementTimeoutMs) {
      throw new Error("payment charge lock timeout cannot exceed statement timeout");
    }
    this.transactionOwnership = options.transactionOwnership ?? "repository";
    if (this.transactionOwnership !== "repository" && this.transactionOwnership !== "caller") {
      throw new Error("payment charge transaction ownership is invalid");
    }
  }

  async appendChargeBundle(
    value: ChargeBundle,
  ): Promise<PersistedPaymentChargeBundleV1> {
    const bundle = structuredClone(value.bundleVersion === 2
      ? assertNormalizedPaymentChargeBundleV2(value) : assertNormalizedPaymentChargeBundleV1(value));
    const metadata = JSON.stringify(bundleMetadata(bundle));
    const lockKeys = [
      `event:${bundle.merchantId}:${bundle.storeId}:${bundle.event.idempotencyKey}`,
      `source:${bundle.merchantId}:${bundle.storeId}:${bundle.sourceType}:${bundle.sourceId}:${bundle.event.kind}`,
    ].sort();
    let transactionStarted = false;
    try {
      if (this.transactionOwnership === "repository") {
        await this.client.query("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED");
        transactionStarted = true;
      }
      await this.client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${this.statementTimeoutMs}ms`],
      );
      await this.client.query(
        "SELECT set_config('lock_timeout', $1, true)",
        [`${this.lockTimeoutMs}ms`],
      );
      for (const lockKey of lockKeys) {
        await this.client.query(`
          /* payment_charge_bundle_lock */
          SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
        `, [lockKey]);
      }

      if (bundle.bundleVersion === 2) {
        const components = bundle.components;
        const revision = await this.client.query(`
          /* payment_charge_bundle_revision_components_v2 */
          SELECT 1 FROM app.order_commercial_revision_components c
          JOIN app.order_commercial_revisions r ON r.id = c.revision_id
          WHERE c.merchant_id = $1 AND c.store_id = $2 AND c.order_id = $3
            AND c.revision_id = $4 AND c.revision = $5
            AND c.currency_code = $6 AND c.minor_unit_exponent = $7
            AND c.component_version = 2 AND r.metadata->>'bundleVersion' = '2'
            AND (c.tax_mode, c.merchandise_gross_minor, c.discount_minor, c.merchandise_net_minor,
              c.shipping_minor, c.merchandise_vat_minor, c.shipping_vat_minor, c.vat_minor,
              c.unclassified_minor, c.total_minor, c.payment_fee_minor, c.payment_fee_vat_minor)
              = ($8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        `, [bundle.merchantId, bundle.storeId, bundle.orderId, bundle.commercialRevisionId,
          bundle.commercialRevision, bundle.currencyCode, bundle.minorUnitExponent,
          components.taxMode, components.merchandiseGrossMinor, components.discountMinor, components.merchandiseNetMinor,
          components.shippingMinor, components.merchandiseVatMinor, components.shippingVatMinor, components.vatMinor,
          components.unclassifiedMinor, components.totalMinor, components.paymentFeeMinor, components.paymentFeeVatMinor]);
        if (revision.rows.length !== 1) {
          throw new PaymentChargeBundleIntegrityErrorV1("V2 charge revision component/version drift");
        }
      }

      const existing = await this.client.query<ExistingBundleRow>(`
        /* payment_charge_bundle_existing */
        SELECT
          to_jsonb(events) - 'recorded_at' AS event_record,
          to_jsonb(obligations) - 'recorded_at' AS obligation_record,
          -- Freeze the V1 shape across additive migrations; never hide a fee-bearing row.
          CASE WHEN $7::int = 2 OR (
                 COALESCE((to_jsonb(components)->>'component_version')::int, 1) = 1
                 AND COALESCE((to_jsonb(components)->>'payment_fee_minor')::numeric, 0) = 0
                 AND COALESCE((to_jsonb(components)->>'payment_fee_vat_minor')::numeric, 0) = 0)
          THEN jsonb_build_object(
            'payment_event_id', components.payment_event_id,
            'commercial_revision_id', components.commercial_revision_id,
            'merchant_id', components.merchant_id, 'store_id', components.store_id,
            'currency_code', components.currency_code, 'minor_unit_exponent', components.minor_unit_exponent,
            'tax_mode', components.tax_mode,
            'merchandise_gross_minor', components.merchandise_gross_minor,
            'discount_minor', components.discount_minor,
            'merchandise_net_minor', components.merchandise_net_minor,
            'shipping_minor', components.shipping_minor,
            'merchandise_vat_minor', components.merchandise_vat_minor,
            'shipping_vat_minor', components.shipping_vat_minor,
            'vat_minor', components.vat_minor, 'unclassified_minor', components.unclassified_minor,
            'total_minor', components.total_minor
          ) || CASE WHEN $7::int = 2 THEN jsonb_build_object(
            'component_version', to_jsonb(components)->'component_version',
            'payment_fee_minor', to_jsonb(components)->'payment_fee_minor',
            'payment_fee_vat_minor', to_jsonb(components)->'payment_fee_vat_minor'
          ) ELSE '{}'::jsonb END
          ELSE to_jsonb(components) - 'id' - 'recorded_at' END AS component_record,
          COALESCE(evidence.records, '[]'::jsonb) AS evidence_records,
          COALESCE(allocations.records, '[]'::jsonb) AS allocation_records
        FROM app.payment_events events
        LEFT JOIN app.commercial_obligations obligations
          ON obligations.merchant_id = events.merchant_id
         AND obligations.store_id = events.store_id
         AND (
           obligations.idempotency_key = $6
           OR (
             obligations.source_type = $4
             AND obligations.source_id = $5
             AND obligations.obligation_kind = 'order_charge'
           )
         )
        LEFT JOIN app.payment_event_component_allocations components
          ON components.payment_event_id = events.id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            to_jsonb(event_evidence) - 'id' - 'captured_at'
            ORDER BY event_evidence.id
          ) AS records
          FROM app.payment_event_evidence event_evidence
          WHERE event_evidence.payment_event_id = events.id
        ) evidence ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            to_jsonb(event_allocations) - 'id' - 'recorded_at'
            ORDER BY event_allocations.id
          ) AS records
          FROM app.payment_event_allocations event_allocations
          WHERE event_allocations.payment_event_id = events.id
        ) allocations ON true
        WHERE events.merchant_id = $1
          AND events.store_id = $2
          AND (
            events.idempotency_key = $3
            OR (
              events.source_type = $4
              AND events.source_id = $5
              AND events.kind = 'charge'
            )
          )
        ORDER BY events.id
      `, [
        bundle.merchantId,
        bundle.storeId,
        bundle.event.idempotencyKey,
        bundle.sourceType,
        bundle.sourceId,
        bundle.obligation.idempotencyKey,
        bundle.bundleVersion,
      ]);
      const replay = validateExisting(existing.rows, bundle);
      if (replay) {
        if (this.transactionOwnership === "repository") {
          await this.client.query("COMMIT");
        }
        return replay;
      }

      const obligationId = await insertedId(this.client, `
        /* payment_charge_bundle_insert_obligation */
        INSERT INTO app.commercial_obligations (
          merchant_id, store_id, order_id, commercial_revision_id,
          obligation_kind, currency_code, minor_unit_exponent, amount_minor,
          idempotency_key, source_type, source_id, source_occurred_at, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12::timestamptz, $13::jsonb
        )
        RETURNING id::text AS id
      `, [
        bundle.merchantId,
        bundle.storeId,
        bundle.orderId,
        bundle.commercialRevisionId,
        bundle.obligation.obligationKind,
        bundle.currencyCode,
        bundle.minorUnitExponent,
        bundle.obligation.amountMinor,
        bundle.obligation.idempotencyKey,
        bundle.sourceType,
        bundle.sourceId,
        bundle.sourceOccurredAt,
        metadata,
      ], "obligationId");

      const paymentEventId = await insertedId(this.client, `
        /* payment_charge_bundle_insert_event */
        INSERT INTO app.payment_events (
          merchant_id, store_id, order_id, commercial_revision_id,
          kind, status, method, evidence_type, evidence_fingerprint,
          currency_code, minor_unit_exponent, amount_minor, idempotency_key,
          source_type, source_id, source_occurred_at, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16::timestamptz, $17::jsonb
        )
        RETURNING id::text AS id
      `, [
        bundle.merchantId,
        bundle.storeId,
        bundle.orderId,
        bundle.commercialRevisionId,
        bundle.event.kind,
        bundle.event.status,
        bundle.event.method,
        bundle.event.evidenceType,
        bundle.event.evidenceFingerprint,
        bundle.currencyCode,
        bundle.minorUnitExponent,
        bundle.event.amountMinor,
        bundle.event.idempotencyKey,
        bundle.sourceType,
        bundle.sourceId,
        bundle.sourceOccurredAt,
        metadata,
      ], "paymentEventId");

      if (bundle.evidence) {
        await insertedId(this.client, `
          /* payment_charge_bundle_insert_evidence */
          INSERT INTO app.payment_event_evidence (
            payment_event_id, merchant_id, store_id, evidence_type,
            source_system, source_reference, verification_status,
            evidence_fingerprint, source_occurred_at, evidence_payload
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb
          )
          RETURNING id::text AS id
        `, [
          paymentEventId,
          bundle.merchantId,
          bundle.storeId,
          bundle.evidence.evidenceType,
          bundle.evidence.sourceSystem,
          bundle.evidence.sourceReference,
          bundle.evidence.verificationStatus,
          bundle.evidence.evidenceFingerprint,
          bundle.evidence.sourceOccurredAt,
          JSON.stringify(storedEvidencePayload(bundle)),
        ], "evidenceId");
      }

      await insertedId(this.client, `
        /* payment_charge_bundle_insert_components */
        INSERT INTO app.payment_event_component_allocations (
          payment_event_id, commercial_revision_id, merchant_id, store_id,
          currency_code, minor_unit_exponent, tax_mode, merchandise_gross_minor,
          discount_minor, merchandise_net_minor, shipping_minor,
          merchandise_vat_minor, shipping_vat_minor, vat_minor,
          unclassified_minor, total_minor
          ${bundle.bundleVersion === 2 ? ", component_version, payment_fee_minor, payment_fee_vat_minor" : ""}
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14, $15, $16
          ${bundle.bundleVersion === 2 ? ", 2, $17, $18" : ""}
        )
        RETURNING id::text AS id
      `, [
        paymentEventId,
        bundle.commercialRevisionId,
        bundle.merchantId,
        bundle.storeId,
        bundle.currencyCode,
        bundle.minorUnitExponent,
        bundle.componentAllocation.taxMode,
        bundle.componentAllocation.merchandiseGrossMinor,
        bundle.componentAllocation.discountMinor,
        bundle.componentAllocation.merchandiseNetMinor,
        bundle.componentAllocation.shippingMinor,
        bundle.componentAllocation.merchandiseVatMinor,
        bundle.componentAllocation.shippingVatMinor,
        bundle.componentAllocation.vatMinor,
        bundle.componentAllocation.unclassifiedMinor,
        bundle.componentAllocation.totalMinor,
        ...(bundle.bundleVersion === 2 ? [bundle.componentAllocation.paymentFeeMinor, bundle.componentAllocation.paymentFeeVatMinor] : []),
      ], "componentAllocationId");

      if (bundle.allocation) {
        await insertedId(this.client, `
          /* payment_charge_bundle_insert_allocation */
          INSERT INTO app.payment_event_allocations (
            merchant_id, store_id, obligation_id, payment_event_id,
            allocation_kind, currency_code, minor_unit_exponent, amount_minor,
            idempotency_key, allocated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz
          )
          RETURNING id::text AS id
        `, [
          bundle.merchantId,
          bundle.storeId,
          obligationId,
          paymentEventId,
          bundle.allocation.allocationKind,
          bundle.currencyCode,
          bundle.minorUnitExponent,
          bundle.allocation.amountMinor,
          bundle.allocation.idempotencyKey,
          bundle.allocation.allocatedAt,
        ], "eventAllocationId");
      }

      if (this.transactionOwnership === "repository") {
        await this.client.query("COMMIT");
      }
      return {
        outcome: "inserted",
        bundleFingerprint: bundle.bundleFingerprint,
        merchantId: bundle.merchantId,
        storeId: bundle.storeId,
        orderId: bundle.orderId,
        commercialRevisionId: bundle.commercialRevisionId,
        eventIdempotencyKey: bundle.event.idempotencyKey,
        obligationId,
        paymentEventId,
      };
    } catch (error) {
      if (transactionStarted) await this.client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}
