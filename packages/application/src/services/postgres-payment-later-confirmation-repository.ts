import { PlatformError } from "../errors/platform-error";
import type { PoolClient } from "../db/client";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { recordAuditEntry, type AuditActor } from "../repositories/audit-repository";
import {
  PaymentLaterConfirmationContractErrorV1,
  assertNormalizedPaymentLaterConfirmationV1,
  assertNormalizedPaymentLaterConfirmationV2,
  type NormalizedPaymentLaterConfirmationV2,
  type PaymentLaterConfirmationRepositoryV2,
  type NormalizedPaymentLaterConfirmationV1,
  type PaymentLaterConfirmationRepositoryV1,
  type PersistedPaymentLaterConfirmationV1,
} from "./payment-later-confirmation-contract";

type LaterBundle = NormalizedPaymentLaterConfirmationV1 | NormalizedPaymentLaterConfirmationV2;

export const PAYMENT_LATER_CONFIRMATION_STATEMENT_TIMEOUT_HARD_CAP_MS = 30_000;
export const PAYMENT_LATER_CONFIRMATION_LOCK_TIMEOUT_HARD_CAP_MS = 5_000;

export interface PostgresPaymentLaterConfirmationOptionsV1 {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}

export interface ManualBankConfirmationAuditContextV1 {
  actor: AuditActor;
  clientIntentFingerprint: string;
}

type StateRow = { pending_record: unknown; obligation_record: unknown };
type ExistingRow = {
  event_record: unknown;
  component_record: unknown;
  evidence_records: unknown;
  allocation_records: unknown;
};

function integrity(message: string): PaymentLaterConfirmationContractErrorV1 {
  return new PaymentLaterConfirmationContractErrorV1(
    `persisted later confirmation ${message}`,
  );
}

function boundedTimeout(value: number, field: string, cap: number): number {
  if (!Number.isInteger(value) || value < 1 || value > cap) {
    throw new Error(`${field} must be between 1 and ${cap}`);
  }
  return value;
}

function parsedJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw integrity(`${field} is invalid`);
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  const parsed = parsedJson(value, field);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw integrity(`${field} is invalid`);
  }
  return parsed as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  const parsed = parsedJson(value, field);
  if (!Array.isArray(parsed)) throw integrity(`${field} is invalid`);
  return parsed;
}

function safeInteger(value: unknown, field: string): number {
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "bigint") parsed = Number(value);
  else if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) parsed = Number(value);
  else throw integrity(`${field} is invalid`);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw integrity(`${field} is invalid`);
  return parsed;
}

function instant(value: unknown, field: string): string {
  const date = value instanceof Date
    ? value
    : new Date(typeof value === "string" ? value : Number.NaN);
  if (!Number.isFinite(date.getTime())) throw integrity(`${field} is invalid`);
  return date.toISOString();
}

function uuid(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw integrity(`${field} is invalid`);
  }
  return value;
}

function assertEquivalent(actual: unknown, expected: unknown, field: string): void {
  if (typeof expected === "number") {
    if (safeInteger(actual, field) !== expected) throw integrity(`${field} drift`);
    return;
  }
  if (typeof expected === "string" && (
    field.endsWith("source_occurred_at") || field.endsWith("allocated_at")
  )) {
    if (instant(actual, field) !== expected) throw integrity(`${field} drift`);
    return;
  }
  if (Array.isArray(expected)) {
    const actualArray = array(actual, field);
    if (actualArray.length !== expected.length) throw integrity(`${field} count drift`);
    expected.forEach((item, index) => {
      assertEquivalent(actualArray[index], item, `${field}[${index}]`);
    });
    return;
  }
  if (expected && typeof expected === "object") {
    const actualRecord = record(actual, field);
    const expectedRecord = expected as Record<string, unknown>;
    const actualKeys = Object.keys(actualRecord).sort();
    const expectedKeys = Object.keys(expectedRecord).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw integrity(`${field} shape drift`);
    }
    for (const key of expectedKeys) {
      assertEquivalent(actualRecord[key], expectedRecord[key], `${field}.${key}`);
    }
    return;
  }
  if (actual !== expected) throw integrity(`${field} drift`);
}

function metadata(bundle: LaterBundle) {
  return {
    bundleVersion: bundle.bundleVersion,
    bundleFingerprint: bundle.bundleFingerprint,
    priorPendingPaymentEventId: bundle.priorPendingPaymentEventId,
    obligationId: bundle.obligationId,
  };
}

function expectedState(bundle: LaterBundle) {
  return {
    pending: {
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
    obligation: {
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

function expectedExisting(
  bundle: LaterBundle,
  paymentEventId: string,
) {
  const bundleMetadata = metadata(bundle);
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
      source_type: bundle.event.sourceType,
      source_id: bundle.event.sourceId,
      source_occurred_at: bundle.event.sourceOccurredAt,
      metadata: bundleMetadata,
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
      ...(bundle.bundleVersion === 2 ? { component_version: 2, payment_fee_minor: bundle.components.paymentFeeMinor,
        payment_fee_vat_minor: bundle.components.paymentFeeVatMinor } : {}),
    },
    evidence: [{
      payment_event_id: paymentEventId,
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      evidence_type: bundle.evidence.evidenceType,
      source_system: bundle.evidence.sourceSystem,
      source_reference: bundle.evidence.sourceReference,
      verification_status: bundle.evidence.verificationStatus,
      evidence_fingerprint: bundle.evidence.evidenceFingerprint,
      source_occurred_at: bundle.evidence.sourceOccurredAt,
      evidence_payload: bundleMetadata,
    }],
    allocation: [{
      merchant_id: bundle.merchantId,
      store_id: bundle.storeId,
      obligation_id: bundle.obligationId,
      payment_event_id: paymentEventId,
      allocation_kind: bundle.allocation.allocationKind,
      currency_code: bundle.currencyCode,
      minor_unit_exponent: bundle.minorUnitExponent,
      amount_minor: bundle.allocation.amountMinor,
      idempotency_key: bundle.allocation.idempotencyKey,
      allocated_at: bundle.allocation.allocatedAt,
    }],
  };
}

function validateState(rows: StateRow[], bundle: LaterBundle): void {
  if (rows.length !== 1) throw integrity("authoritative state coverage drift");
  const expected = expectedState(bundle);
  assertEquivalent(rows[0]!.pending_record, expected.pending, "pending");
  assertEquivalent(rows[0]!.obligation_record, expected.obligation, "obligation");
}

function replayReceipt(
  rows: ExistingRow[],
  bundle: LaterBundle,
): PersistedPaymentLaterConfirmationV1 | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw integrity("has conflicting identities");
  const eventRecord = record(rows[0]!.event_record, "event_record");
  const paymentEventId = uuid(eventRecord.id, "paymentEventId");
  const expected = expectedExisting(bundle, paymentEventId);
  assertEquivalent(eventRecord, expected.event, "event");
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
    priorPendingPaymentEventId: bundle.priorPendingPaymentEventId,
    obligationId: bundle.obligationId,
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
  if (result.rows.length !== 1) throw integrity(`${field} insert coverage drift`);
  return uuid(result.rows[0]!.id, field);
}

export class PostgresPaymentLaterConfirmationRepositoryV1
  implements PaymentLaterConfirmationRepositoryV1, PaymentLaterConfirmationRepositoryV2 {
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly client: PoolClient,
    options: PostgresPaymentLaterConfirmationOptionsV1,
  ) {
    this.statementTimeoutMs = boundedTimeout(
      options.statementTimeoutMs,
      "later confirmation statement timeout",
      PAYMENT_LATER_CONFIRMATION_STATEMENT_TIMEOUT_HARD_CAP_MS,
    );
    this.lockTimeoutMs = boundedTimeout(
      options.lockTimeoutMs,
      "later confirmation lock timeout",
      PAYMENT_LATER_CONFIRMATION_LOCK_TIMEOUT_HARD_CAP_MS,
    );
    if (this.lockTimeoutMs > this.statementTimeoutMs) {
      throw new Error("later confirmation lock timeout cannot exceed statement timeout");
    }
  }

  async appendLaterConfirmation(
    value: LaterBundle,
    auditContext?: ManualBankConfirmationAuditContextV1,
  ): Promise<PersistedPaymentLaterConfirmationV1> {
    const bundle = structuredClone(value.bundleVersion === 2
      ? assertNormalizedPaymentLaterConfirmationV2(value) : assertNormalizedPaymentLaterConfirmationV1(value));
    const bundleMetadata = JSON.stringify(metadata(bundle));
    const lockKeys = [
      `confirmation-event:${bundle.merchantId}:${bundle.storeId}:${bundle.event.idempotencyKey}`,
      `confirmation-evidence:${bundle.merchantId}:${bundle.storeId}:${bundle.evidence.sourceSystem}:${bundle.evidence.sourceReference}`,
      `confirmation-source:${bundle.merchantId}:${bundle.storeId}:${bundle.event.sourceType}:${bundle.event.sourceId}`,
      `obligation:${bundle.merchantId}:${bundle.storeId}:${bundle.obligationId}`,
      `pending:${bundle.merchantId}:${bundle.storeId}:${bundle.priorPendingPaymentEventId}`,
    ].sort();
    let transactionStarted = false;
    try {
      await this.client.query("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED");
      transactionStarted = true;
      await this.client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${this.statementTimeoutMs}ms`],
      );
      await this.client.query(
        "SELECT set_config('lock_timeout', $1, true)",
        [`${this.lockTimeoutMs}ms`],
      );
      await lockActiveBusinessScopeForClient(this.client,
        { scopeType: "store", merchantId: bundle.merchantId, storeId: bundle.storeId });
      // Serialize collection with cancellation/correction before payment locks.
      const order = await this.client.query<{ status: string }>(`
        /* payment_later_confirmation_order_lock */
        SELECT status FROM public."order"
        WHERE id=$1 AND merchant_id=$2 AND store_id=$3 AND deleted_at IS NULL FOR UPDATE
      `, [bundle.orderId, bundle.merchantId, bundle.storeId]);
      if (order.rows.length !== 1) throw new PlatformError("resource_not_found", "Order not found", 404);
      for (const lockKey of lockKeys) {
        await this.client.query(`
          /* payment_later_confirmation_lock */
          SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
        `, [lockKey]);
      }

      const state = await this.client.query<StateRow>(`
        /* payment_later_confirmation_state */
        SELECT
          to_jsonb(pending) - 'recorded_at' - 'metadata' AS pending_record,
          to_jsonb(obligations) - 'recorded_at' - 'metadata' AS obligation_record
        FROM app.payment_events pending
        JOIN app.commercial_obligations obligations
          ON obligations.id = $4
         AND obligations.merchant_id = $1
         AND obligations.store_id = $2
        WHERE pending.id = $3
          AND pending.merchant_id = $1
          AND pending.store_id = $2
        FOR UPDATE OF pending, obligations
      `, [
        bundle.merchantId,
        bundle.storeId,
        bundle.priorPendingPaymentEventId,
        bundle.obligationId,
      ]);
      validateState(state.rows, bundle);

      if (bundle.bundleVersion === 2) {
        const c = bundle.components;
        const matches = await this.client.query(`
          /* payment_later_confirmation_components_v2 */
          SELECT 1 FROM app.order_commercial_revision_components c
          JOIN app.order_commercial_revisions r ON r.id=c.revision_id
          JOIN app.payment_event_component_allocations p ON p.payment_event_id=$20
            AND p.commercial_revision_id=c.revision_id AND p.merchant_id=c.merchant_id AND p.store_id=c.store_id
            AND p.currency_code=c.currency_code AND p.minor_unit_exponent=c.minor_unit_exponent
          JOIN app.payment_events pending ON pending.id=p.payment_event_id
          WHERE c.merchant_id=$1 AND c.store_id=$2 AND c.order_id=$3 AND c.revision_id=$4 AND c.revision=$5
            AND c.currency_code=$6 AND c.minor_unit_exponent=$7
            AND c.component_version=2 AND p.component_version=2
            AND r.metadata->>'bundleVersion'='2' AND pending.metadata->>'bundleVersion'='2'
            AND (c.tax_mode,c.merchandise_gross_minor,c.discount_minor,c.merchandise_net_minor,c.shipping_minor,
              c.merchandise_vat_minor,c.shipping_vat_minor,c.vat_minor,c.unclassified_minor,c.total_minor,c.payment_fee_minor,c.payment_fee_vat_minor)
              = ($8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            AND (p.tax_mode,p.merchandise_gross_minor,p.discount_minor,p.merchandise_net_minor,p.shipping_minor,
              p.merchandise_vat_minor,p.shipping_vat_minor,p.vat_minor,p.unclassified_minor,p.total_minor,p.payment_fee_minor,p.payment_fee_vat_minor)
              = (c.tax_mode,c.merchandise_gross_minor,c.discount_minor,c.merchandise_net_minor,c.shipping_minor,
              c.merchandise_vat_minor,c.shipping_vat_minor,c.vat_minor,c.unclassified_minor,c.total_minor,c.payment_fee_minor,c.payment_fee_vat_minor)
        `, [bundle.merchantId,bundle.storeId,bundle.orderId,bundle.commercialRevisionId,bundle.commercialRevision,
          bundle.currencyCode,bundle.minorUnitExponent,c.taxMode,c.merchandiseGrossMinor,c.discountMinor,c.merchandiseNetMinor,
          c.shippingMinor,c.merchandiseVatMinor,c.shippingVatMinor,c.vatMinor,c.unclassifiedMinor,c.totalMinor,
          c.paymentFeeMinor,c.paymentFeeVatMinor,bundle.priorPendingPaymentEventId]);
        if (matches.rows.length !== 1) throw integrity("revision/pending component version or amount drift");
      }

      const existing = await this.client.query<ExistingRow>(`
        /* payment_later_confirmation_existing */
        SELECT
          to_jsonb(events) - 'recorded_at' AS event_record,
          -- Freeze the V1 shape across additive migrations; never hide a fee-bearing row.
          CASE WHEN $8::int = 2 OR (
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
          ) || CASE WHEN $8::int = 2 THEN jsonb_build_object(
            'component_version', to_jsonb(components)->'component_version',
            'payment_fee_minor', to_jsonb(components)->'payment_fee_minor',
            'payment_fee_vat_minor', to_jsonb(components)->'payment_fee_vat_minor'
          ) ELSE '{}'::jsonb END
          ELSE to_jsonb(components) - 'id' - 'recorded_at' END AS component_record,
          COALESCE(evidence.records, '[]'::jsonb) AS evidence_records,
          COALESCE(allocations.records, '[]'::jsonb) AS allocation_records
        FROM app.payment_events events
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
            OR EXISTS (
              SELECT 1
              FROM app.payment_event_evidence event_evidence
              WHERE event_evidence.payment_event_id = events.id
                AND event_evidence.merchant_id = $1
                AND event_evidence.store_id = $2
                AND event_evidence.source_system = $6
                AND event_evidence.source_reference = $7
            )
          )
        ORDER BY events.id
      `, [
        bundle.merchantId,
        bundle.storeId,
        bundle.event.idempotencyKey,
        bundle.event.sourceType,
        bundle.event.sourceId,
        bundle.evidence.sourceSystem,
        bundle.evidence.sourceReference,
        bundle.bundleVersion,
      ]);
      const replay = replayReceipt(existing.rows, bundle);
      if (replay) {
        await this.client.query("COMMIT");
        return replay;
      }

      if (order.rows[0]!.status === "canceled") {
        throw new PlatformError("invalid_state_transition", "Cannot collect a canceled order", 409);
      }
      const collected = await this.client.query<{ collected_minor: unknown }>(`
        /* payment_later_confirmation_collected */
        SELECT COALESCE(SUM(amount_minor) FILTER (
          WHERE allocation_kind = 'collection'
        ), 0)::text AS collected_minor
        FROM app.payment_event_allocations
        WHERE merchant_id = $1
          AND store_id = $2
          AND obligation_id = $3
      `, [bundle.merchantId, bundle.storeId, bundle.obligationId]);
      if (
        collected.rows.length !== 1
        || safeInteger(collected.rows[0]!.collected_minor, "collected_minor") !== 0
      ) {
        throw integrity("obligation is already collected");
      }

      const paymentEventId = await insertedId(this.client, `
        /* payment_later_confirmation_insert_event */
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
        bundle.event.sourceType,
        bundle.event.sourceId,
        bundle.event.sourceOccurredAt,
        bundleMetadata,
      ], "paymentEventId");

      await insertedId(this.client, `
        /* payment_later_confirmation_insert_evidence */
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
        bundleMetadata,
      ], "evidenceId");

      await insertedId(this.client, `
        /* payment_later_confirmation_insert_components */
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
        ...(bundle.bundleVersion === 2 ? [bundle.componentAllocation.paymentFeeMinor,bundle.componentAllocation.paymentFeeVatMinor] : []),
      ], "componentAllocationId");

      await insertedId(this.client, `
        /* payment_later_confirmation_insert_allocation */
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
        bundle.obligationId,
        paymentEventId,
        bundle.allocation.allocationKind,
        bundle.currencyCode,
        bundle.minorUnitExponent,
        bundle.allocation.amountMinor,
        bundle.allocation.idempotencyKey,
        bundle.allocation.allocatedAt,
      ], "eventAllocationId");

      if (bundle.event.method === "manual_bank") {
        if (
          !auditContext
          || !auditContext.actor?.operatorId
          || !/^[a-f0-9]{64}$/.test(auditContext.clientIntentFingerprint)
        ) {
          throw integrity("manual-bank audit context is invalid");
        }
        await recordAuditEntry(
          this.client,
          auditContext.actor,
          "payment.manual_bank_confirmed",
          "order",
          bundle.orderId,
          {
            merchantId: bundle.merchantId,
            storeId: bundle.storeId,
            correlationId: auditContext.actor.requestId,
            after: {
              paymentEventId,
              priorPendingPaymentEventId: bundle.priorPendingPaymentEventId,
              obligationId: bundle.obligationId,
              method: bundle.event.method,
              evidenceType: bundle.evidence.evidenceType,
              sourceSystem: bundle.evidence.sourceSystem,
              sourceReference: bundle.evidence.sourceReference,
              sourceOccurredAt: bundle.evidence.sourceOccurredAt,
              clientIntentFingerprint: auditContext.clientIntentFingerprint,
            },
          },
        );
      }

      await this.client.query("COMMIT");
      return {
        outcome: "inserted",
        bundleFingerprint: bundle.bundleFingerprint,
        merchantId: bundle.merchantId,
        storeId: bundle.storeId,
        orderId: bundle.orderId,
        commercialRevisionId: bundle.commercialRevisionId,
        eventIdempotencyKey: bundle.event.idempotencyKey,
        priorPendingPaymentEventId: bundle.priorPendingPaymentEventId,
        obligationId: bundle.obligationId,
        paymentEventId,
      };
    } catch (error) {
      if (transactionStarted) await this.client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}
