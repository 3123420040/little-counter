import { PlatformError } from "../errors/platform-error";
import type { PoolClient } from "../db/client";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import {
  recordAuditEntry,
  type AuditActor,
} from "../repositories/audit-repository";
import { createHash } from "node:crypto";

export interface SignedCorrectionDeltaPersistenceV1 {
  taxMode: "inclusive" | "exclusive";
  merchandiseGrossMinor: number;
  discountMinor: number;
  merchandiseNetMinor: number;
  shippingMinor: number;
  merchandiseVatMinor: number;
  shippingVatMinor: number;
  vatMinor: number;
  unclassifiedMinor: number;
  totalMinor: number;
  baseSnapshotFingerprint: string;
  effectiveSnapshotFingerprint: string;
  contractFingerprint: string;
}

export interface ManualBankCorrectionConfirmationBundleV1 {
  bundleFingerprint: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  correctionId: string;
  commercialRevisionId: string;
  baseCommercialRevisionId: string;
  priorPendingPaymentEventId: string;
  obligationId: string;
  currencyCode: string;
  minorUnitExponent: number;
  amountMinor: number;
  eventIdempotencyKey: string;
  eventSourceId: string;
  evidenceFingerprint: string;
  sourceSystem: "manual_bank_operator_attestation";
  sourceReference: string;
  confirmedAt: string;
  clientIntentFingerprint: string;
  delta: SignedCorrectionDeltaPersistenceV1;
}
export type SignedCorrectionDeltaPersistenceV2 =
  SignedCorrectionDeltaPersistenceV1 & {
    paymentFeeMinor: number;
    paymentFeeVatMinor: number;
  };
export type ManualBankCorrectionConfirmationBundleV2 = Omit<
  ManualBankCorrectionConfirmationBundleV1,
  "delta"
> & {
  schemaVersion: 2;
  delta: SignedCorrectionDeltaPersistenceV2;
};

export interface PersistedManualBankCorrectionConfirmationV1 {
  outcome: "inserted" | "replayed";
  paymentEventId: string;
  priorPendingPaymentEventId: string;
  obligationId: string;
}

type StateRow = Record<string, unknown>;

function asInteger(value: unknown, field: string, signed = false): number {
  const parsed = Number(String(value));
  if (!Number.isSafeInteger(parsed) || (!signed && parsed < 0)) {
    throw new Error(`manual-bank correction ${field} is invalid`);
  }
  return parsed;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`manual-bank correction ${field} is invalid`);
  }
  return value;
}

function assertState(
  row: StateRow | undefined,
  bundle:
    | ManualBankCorrectionConfirmationBundleV1
    | ManualBankCorrectionConfirmationBundleV2,
) {
  if (!row)
    throw new Error(
      "manual-bank correction authoritative state is unavailable",
    );
  const v2 = "schemaVersion" in bundle && bundle.schemaVersion === 2;
  if (
    asInteger(row.component_version ?? 1, "component version") !==
      (v2 ? 2 : 1) ||
    asInteger(row.payment_fee_delta_minor ?? 0, "payment fee delta", true) !==
      (v2 ? bundle.delta.paymentFeeMinor : 0) ||
    asInteger(
      row.payment_fee_vat_delta_minor ?? 0,
      "payment fee VAT delta",
      true,
    ) !== (v2 ? bundle.delta.paymentFeeVatMinor : 0)
  ) {
    throw new Error(
      "manual-bank correction fee component version or value drift",
    );
  }
  const exact: Array<[unknown, unknown, string]> = [
    [row.pending_event_id, bundle.priorPendingPaymentEventId, "pending event"],
    [row.merchant_id, bundle.merchantId, "merchant"],
    [row.store_id, bundle.storeId, "store"],
    [row.order_id, bundle.orderId, "order"],
    [row.correction_id, bundle.correctionId, "correction"],
    [
      row.commercial_revision_id,
      bundle.commercialRevisionId,
      "commercial revision",
    ],
    [
      row.base_commercial_revision_id,
      bundle.baseCommercialRevisionId,
      "base commercial revision",
    ],
    [row.obligation_id, bundle.obligationId, "obligation"],
    [row.status, "pending", "pending status"],
    [row.method, "manual_bank", "pending method"],
    [row.evidence_type, null, "pending evidence type"],
    [row.evidence_fingerprint, null, "pending evidence fingerprint"],
    [row.currency_code, bundle.currencyCode, "currency"],
    [row.tax_mode, bundle.delta.taxMode, "tax mode"],
    [
      row.base_snapshot_fingerprint,
      bundle.delta.baseSnapshotFingerprint,
      "base fingerprint",
    ],
    [
      row.effective_snapshot_fingerprint,
      bundle.delta.effectiveSnapshotFingerprint,
      "effective fingerprint",
    ],
    [
      row.contract_fingerprint,
      bundle.delta.contractFingerprint,
      "contract fingerprint",
    ],
  ];
  for (const [actual, expected, field] of exact) {
    if (actual !== expected)
      throw new Error(`manual-bank correction ${field} drift`);
  }
  const integers: Array<[unknown, number, string, boolean?]> = [
    [row.minor_unit_exponent, bundle.minorUnitExponent, "minor unit exponent"],
    [row.amount_minor, bundle.amountMinor, "pending amount"],
    [row.obligation_amount_minor, bundle.amountMinor, "obligation amount"],
    [
      row.merchandise_gross_delta_minor,
      bundle.delta.merchandiseGrossMinor,
      "merchandise gross delta",
      true,
    ],
    [
      row.discount_delta_minor,
      bundle.delta.discountMinor,
      "discount delta",
      true,
    ],
    [
      row.merchandise_net_delta_minor,
      bundle.delta.merchandiseNetMinor,
      "merchandise net delta",
      true,
    ],
    [
      row.shipping_delta_minor,
      bundle.delta.shippingMinor,
      "shipping delta",
      true,
    ],
    [
      row.merchandise_vat_delta_minor,
      bundle.delta.merchandiseVatMinor,
      "merchandise VAT delta",
      true,
    ],
    [
      row.shipping_vat_delta_minor,
      bundle.delta.shippingVatMinor,
      "shipping VAT delta",
      true,
    ],
    [row.vat_delta_minor, bundle.delta.vatMinor, "VAT delta", true],
    [
      row.unclassified_delta_minor,
      bundle.delta.unclassifiedMinor,
      "unclassified delta",
      true,
    ],
    [row.total_delta_minor, bundle.delta.totalMinor, "total delta", true],
  ];
  for (const [actual, expected, field, signed] of integers) {
    if (asInteger(actual, field, signed) !== expected) {
      throw new Error(`manual-bank correction ${field} drift`);
    }
  }
}

export class PostgresManualBankCorrectionConfirmationRepositoryV1 {
  constructor(
    private readonly client: PoolClient,
    private readonly options = {
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 1_000,
    },
  ) {}

  async append(
    bundle:
      | ManualBankCorrectionConfirmationBundleV1
      | ManualBankCorrectionConfirmationBundleV2,
    actor: AuditActor,
  ): Promise<PersistedManualBankCorrectionConfirmationV1> {
    if (!actor.operatorId || !/^[a-f0-9]{64}$/.test(bundle.bundleFingerprint)) {
      throw new Error("manual-bank correction confirmation bundle is invalid");
    }
    const version = "schemaVersion" in bundle ? bundle.schemaVersion : 1;
    if (version !== 1 && version !== 2)
      throw new Error(
        "manual-bank correction confirmation version is unsupported",
      );
    if (version === 2) {
      const { bundleFingerprint, ...body } = bundle;
      if (
        createHash("sha256").update(JSON.stringify(body)).digest("hex") !==
        bundleFingerprint
      )
        throw new Error(
          "manual-bank correction confirmation fingerprint drift",
        );
    }
    let started = false;
    try {
      await this.client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED",
      );
      started = true;
      await this.client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${this.options.statementTimeoutMs}ms`],
      );
      await this.client.query("SELECT set_config('lock_timeout', $1, true)", [
        `${this.options.lockTimeoutMs}ms`,
      ]);
      await lockActiveBusinessScopeForClient(this.client,
        { scopeType: "store", merchantId: bundle.merchantId, storeId: bundle.storeId });
      // Serialize collection with cancellation/correction before payment locks.
      const order = await this.client.query<{ status: string }>(
        `
        /* manual_bank_correction_confirmation_order_lock */
        SELECT status FROM public."order"
        WHERE id=$1 AND merchant_id=$2 AND store_id=$3 AND deleted_at IS NULL FOR UPDATE
      `,
        [bundle.orderId, bundle.merchantId, bundle.storeId],
      );
      if (order.rows.length !== 1)
        throw new PlatformError("resource_not_found", "Order not found", 404);
      for (const key of [
        `confirmation-evidence:${bundle.merchantId}:${bundle.storeId}:${bundle.sourceSystem}:${bundle.sourceReference}`,
        `confirmation-event:${bundle.merchantId}:${bundle.storeId}:${bundle.eventIdempotencyKey}`,
        `obligation:${bundle.merchantId}:${bundle.storeId}:${bundle.obligationId}`,
        `pending:${bundle.merchantId}:${bundle.storeId}:${bundle.priorPendingPaymentEventId}`,
      ].sort()) {
        await this.client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [key],
        );
      }

      const state = await this.client.query<StateRow>(
        `
        /* manual_bank_correction_confirmation_state */
        SELECT pending.id::text AS pending_event_id,
               pending.merchant_id,
               pending.store_id,
               pending.order_id,
               pending.source_id AS correction_id,
               pending.commercial_revision_id::text AS commercial_revision_id,
               deltas.base_commercial_revision_id::text AS base_commercial_revision_id,
               obligations.id::text AS obligation_id,
               pending.status,
               pending.method,
               pending.evidence_type,
               pending.evidence_fingerprint,
               pending.currency_code,
               pending.minor_unit_exponent,
               pending.amount_minor,
               obligations.amount_minor AS obligation_amount_minor,
               coalesce(collections.collected_minor, 0) AS collected_minor,
               deltas.tax_mode,
               COALESCE((to_jsonb(deltas)->>'component_version')::int,1) AS component_version,
               COALESCE((to_jsonb(deltas)->>'payment_fee_delta_minor')::text,'0') AS payment_fee_delta_minor,
               COALESCE((to_jsonb(deltas)->>'payment_fee_vat_delta_minor')::text,'0') AS payment_fee_vat_delta_minor,
               deltas.merchandise_gross_delta_minor,
               deltas.discount_delta_minor,
               deltas.merchandise_net_delta_minor,
               deltas.shipping_delta_minor,
               deltas.merchandise_vat_delta_minor,
               deltas.shipping_vat_delta_minor,
               deltas.vat_delta_minor,
               deltas.unclassified_delta_minor,
               deltas.total_delta_minor,
               deltas.base_snapshot_fingerprint,
               deltas.effective_snapshot_fingerprint,
               deltas.contract_fingerprint
        FROM app.payment_events pending
        JOIN app.commercial_obligations obligations
          ON obligations.id = $4::uuid
         AND obligations.merchant_id = pending.merchant_id
         AND obligations.store_id = pending.store_id
         AND obligations.order_id = pending.order_id
         AND obligations.commercial_revision_id = pending.commercial_revision_id
         AND obligations.source_type = pending.source_type
         AND obligations.source_id = pending.source_id
         AND obligations.obligation_kind = 'order_correction_charge'
        JOIN app.payment_correction_component_deltas deltas
          ON deltas.payment_event_id = pending.id
        LEFT JOIN LATERAL (
          SELECT coalesce(sum(allocations.amount_minor), 0) AS collected_minor
          FROM app.payment_event_allocations allocations
          WHERE allocations.merchant_id = pending.merchant_id
            AND allocations.store_id = pending.store_id
            AND allocations.obligation_id = obligations.id
            AND allocations.allocation_kind = 'collection'
        ) collections ON true
        WHERE pending.id = $3::uuid
          AND pending.merchant_id = $1
          AND pending.store_id = $2
          AND pending.source_type = 'order_correction'
        FOR UPDATE OF pending, obligations
      `,
        [
          bundle.merchantId,
          bundle.storeId,
          bundle.priorPendingPaymentEventId,
          bundle.obligationId,
        ],
      );
      assertState(state.rows[0], bundle);

      const existing = await this.client.query<Record<string, unknown>>(
        `
        /* manual_bank_correction_confirmation_existing */
        SELECT events.id::text AS payment_event_id,
               events.metadata->>'bundleFingerprint' AS bundle_fingerprint,
               count(DISTINCT evidence.id)::int AS evidence_count,
               count(DISTINCT deltas.payment_event_id)::int AS delta_count,
               count(DISTINCT allocations.id)::int AS allocation_count,
               coalesce(max(allocations.amount_minor), 0)::text AS allocated_minor
        FROM app.payment_events events
        LEFT JOIN app.payment_event_evidence evidence
          ON evidence.payment_event_id = events.id
        LEFT JOIN app.payment_correction_component_deltas deltas
          ON deltas.payment_event_id = events.id
        LEFT JOIN app.payment_event_allocations allocations
          ON allocations.payment_event_id = events.id
        WHERE events.merchant_id = $1
          AND events.store_id = $2
          AND (
            events.idempotency_key = $3
            OR (
              events.source_type = 'manual_bank_correction_confirmation'
              AND events.source_id = $4
            )
            OR EXISTS (
              SELECT 1
              FROM app.payment_event_evidence source_evidence
              WHERE source_evidence.payment_event_id = events.id
                AND source_evidence.merchant_id = $1
                AND source_evidence.store_id = $2
                AND source_evidence.source_system = $5
                AND source_evidence.source_reference = $6
            )
          )
        GROUP BY events.id
        ORDER BY events.id
      `,
        [
          bundle.merchantId,
          bundle.storeId,
          bundle.eventIdempotencyKey,
          bundle.eventSourceId,
          bundle.sourceSystem,
          bundle.sourceReference,
        ],
      );
      if (existing.rows.length > 1)
        throw new Error(
          "manual-bank correction confirmation identity collision",
        );
      if (existing.rows.length === 1) {
        const row = existing.rows[0]!;
        if (
          row.bundle_fingerprint !== bundle.bundleFingerprint ||
          asInteger(row.evidence_count, "replay evidence count") !== 1 ||
          asInteger(row.delta_count, "replay delta count") !== 1 ||
          asInteger(row.allocation_count, "replay allocation count") !== 1 ||
          asInteger(row.allocated_minor, "replay allocated amount") !==
            bundle.amountMinor
        ) {
          throw new Error("manual-bank correction confirmation replay drift");
        }
        await this.client.query("COMMIT");
        return {
          outcome: "replayed",
          paymentEventId: text(row.payment_event_id, "replay payment event"),
          priorPendingPaymentEventId: bundle.priorPendingPaymentEventId,
          obligationId: bundle.obligationId,
        };
      }
      if (order.rows[0]!.status === "canceled") {
        throw new PlatformError(
          "invalid_state_transition",
          "Cannot collect a canceled order",
          409,
        );
      }
      if (asInteger(state.rows[0]!.collected_minor, "collected amount") !== 0) {
        throw new Error(
          "manual-bank correction obligation is already collected",
        );
      }

      const metadata = JSON.stringify({
        schemaVersion: version,
        bundleFingerprint: bundle.bundleFingerprint,
        priorPendingPaymentEventId: bundle.priorPendingPaymentEventId,
        obligationId: bundle.obligationId,
        correctionId: bundle.correctionId,
        contractFingerprint: bundle.delta.contractFingerprint,
        clientIntentFingerprint: bundle.clientIntentFingerprint,
      });
      const event = await this.client.query<{ id: string }>(
        `
        /* manual_bank_correction_confirmation_insert_event */
        INSERT INTO app.payment_events (
          merchant_id, store_id, order_id, commercial_revision_id,
          kind, status, method, evidence_type, evidence_fingerprint,
          currency_code, minor_unit_exponent, amount_minor, idempotency_key,
          source_type, source_id, source_occurred_at, metadata
        ) VALUES (
          $1, $2, $3, $4::uuid,
          'charge', 'posted', 'manual_bank', 'manual_verified', $5,
          $6, $7, $8, $9,
          'manual_bank_correction_confirmation', $10, $11::timestamptz, $12::jsonb
        )
        RETURNING id::text
      `,
        [
          bundle.merchantId,
          bundle.storeId,
          bundle.orderId,
          bundle.commercialRevisionId,
          bundle.evidenceFingerprint,
          bundle.currencyCode,
          bundle.minorUnitExponent,
          bundle.amountMinor,
          bundle.eventIdempotencyKey,
          bundle.eventSourceId,
          bundle.confirmedAt,
          metadata,
        ],
      );
      if (event.rows.length !== 1)
        throw new Error("manual-bank correction event insert drift");
      const paymentEventId = text(event.rows[0]!.id, "payment event");

      const evidence = await this.client.query(
        `
        INSERT INTO app.payment_event_evidence (
          payment_event_id, merchant_id, store_id, evidence_type,
          source_system, source_reference, verification_status,
          evidence_fingerprint, source_occurred_at, evidence_payload
        ) VALUES (
          $1::uuid, $2, $3, 'manual_verified', $4, $5, 'verified',
          $6, $7::timestamptz, $8::jsonb
        )
      `,
        [
          paymentEventId,
          bundle.merchantId,
          bundle.storeId,
          bundle.sourceSystem,
          bundle.sourceReference,
          bundle.evidenceFingerprint,
          bundle.confirmedAt,
          metadata,
        ],
      );
      if (evidence.rowCount !== 1)
        throw new Error("manual-bank correction evidence insert drift");

      const d = bundle.delta;
      const delta = await this.client.query(
        `
        INSERT INTO app.payment_correction_component_deltas (
          payment_event_id, merchant_id, store_id, order_id,
          base_commercial_revision_id, effective_commercial_revision_id,
          currency_code, minor_unit_exponent, tax_mode,
          merchandise_gross_delta_minor, discount_delta_minor,
          merchandise_net_delta_minor, shipping_delta_minor,
          merchandise_vat_delta_minor, shipping_vat_delta_minor, vat_delta_minor,
          unclassified_delta_minor, total_delta_minor,
          base_snapshot_fingerprint, effective_snapshot_fingerprint,
          contract_fingerprint${version === 2 ? ", component_version, payment_fee_delta_minor, payment_fee_vat_delta_minor" : ""}
        ) VALUES (
          $1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21${version === 2 ? ", 2, $22, $23" : ""}
        )
      `,
        [
          paymentEventId,
          bundle.merchantId,
          bundle.storeId,
          bundle.orderId,
          bundle.baseCommercialRevisionId,
          bundle.commercialRevisionId,
          bundle.currencyCode,
          bundle.minorUnitExponent,
          d.taxMode,
          d.merchandiseGrossMinor,
          d.discountMinor,
          d.merchandiseNetMinor,
          d.shippingMinor,
          d.merchandiseVatMinor,
          d.shippingVatMinor,
          d.vatMinor,
          d.unclassifiedMinor,
          d.totalMinor,
          d.baseSnapshotFingerprint,
          d.effectiveSnapshotFingerprint,
          d.contractFingerprint,
          ...("schemaVersion" in bundle && bundle.schemaVersion === 2
            ? [bundle.delta.paymentFeeMinor, bundle.delta.paymentFeeVatMinor]
            : []),
        ],
      );
      if (delta.rowCount !== 1)
        throw new Error("manual-bank correction delta insert drift");

      const allocation = await this.client.query(
        `
        INSERT INTO app.payment_event_allocations (
          merchant_id, store_id, obligation_id, payment_event_id,
          allocation_kind, currency_code, minor_unit_exponent, amount_minor,
          idempotency_key, allocated_at
        ) VALUES (
          $1, $2, $3::uuid, $4::uuid, 'collection', $5, $6, $7, $8, $9::timestamptz
        )
      `,
        [
          bundle.merchantId,
          bundle.storeId,
          bundle.obligationId,
          paymentEventId,
          bundle.currencyCode,
          bundle.minorUnitExponent,
          bundle.amountMinor,
          `${bundle.eventIdempotencyKey}:allocation`,
          bundle.confirmedAt,
        ],
      );
      if (allocation.rowCount !== 1)
        throw new Error("manual-bank correction allocation insert drift");

      await recordAuditEntry(
        this.client,
        actor,
        "payment.manual_bank_correction_confirmed",
        "order",
        bundle.orderId,
        {
          merchantId: bundle.merchantId,
          storeId: bundle.storeId,
          correlationId: actor.requestId,
          after: {
            paymentEventId,
            priorPendingPaymentEventId: bundle.priorPendingPaymentEventId,
            obligationId: bundle.obligationId,
            correctionId: bundle.correctionId,
            sourceSystem: bundle.sourceSystem,
            sourceReference: bundle.sourceReference,
            sourceOccurredAt: bundle.confirmedAt,
            clientIntentFingerprint: bundle.clientIntentFingerprint,
          },
        },
      );
      await this.client.query("COMMIT");
      return {
        outcome: "inserted",
        paymentEventId,
        priorPendingPaymentEventId: bundle.priorPendingPaymentEventId,
        obligationId: bundle.obligationId,
      };
    } catch (error) {
      if (started) await this.client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}
