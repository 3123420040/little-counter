import type { PoolClient } from "../db/client";
import {
  buildPositiveCorrectionChargeContractV1,
  buildPositiveCorrectionChargeContractV2,
  type PositiveCorrectionChargeContractV1,
  type PositiveCorrectionChargeContractV2,
} from "./payment-positive-correction-charge-contract";

export type PositiveCorrectionSettlementMethodV1 =
  | "cash"
  | "bank_transfer"
  | "cod";

export interface RecordPositiveCorrectionChargeInputV1 {
  contract: PositiveCorrectionChargeContractV1;
  settlementMethod: PositiveCorrectionSettlementMethodV1;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  transactionOwnership?: "repository" | "caller";
}
export type RecordPositiveCorrectionChargeInputV2 = Omit<
  RecordPositiveCorrectionChargeInputV1,
  "contract"
> & {
  contract: PositiveCorrectionChargeContractV2;
};

export interface PersistedPositiveCorrectionChargeV1 {
  outcome: "inserted" | "replayed";
  contractFingerprint: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  correctionId: string;
  paymentEventId: string;
  obligationId: string;
  amountMinor: number;
  status: "posted" | "pending";
  method: "cash" | "cod" | "manual_bank";
}

function bounded(value: number, field: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} must be between 1 and ${maximum}`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw new Error(`positive correction charge ${field} is invalid`);
  return value;
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`positive correction charge ${field} is invalid`);
  }
  return parsed;
}

function normalizeContract(
  value:
    | PositiveCorrectionChargeContractV1
    | PositiveCorrectionChargeContractV2,
) {
  const shared = {
    merchantId: value.merchantId,
    storeId: value.storeId,
    orderId: value.orderId,
    correctionId: value.correctionId,
    baseCommercialRevisionId: value.baseCommercialRevisionId,
    baseCommercialRevision: value.baseCommercialRevision,
    effectiveCommercialRevisionId: value.effectiveCommercialRevisionId,
    effectiveCommercialRevision: value.effectiveCommercialRevision,
    currencyCode: value.currencyCode,
    minorUnitExponent: value.minorUnitExponent,
    sourceOccurredAt: value.sourceOccurredAt,
  };
  const rebuilt =
    value.schemaVersion === 2
      ? buildPositiveCorrectionChargeContractV2({
          ...shared,
          beforeComponents: structuredClone(value.beforeComponents),
          effectiveComponents: structuredClone(value.effectiveComponents),
        })
      : value.schemaVersion === 1
        ? buildPositiveCorrectionChargeContractV1({
            ...shared,
            beforeComponents: structuredClone(value.beforeComponents),
            effectiveComponents: structuredClone(value.effectiveComponents),
          })
        : null;
  if (!rebuilt)
    throw new Error(
      "positive correction charge contract version is unsupported",
    );
  if (rebuilt.contractFingerprint !== value.contractFingerprint) {
    throw new Error("positive correction charge contract fingerprint drift");
  }
  return rebuilt;
}

async function assertV2RevisionComponents(
  client: PoolClient,
  contract: PositiveCorrectionChargeContractV2,
) {
  const result = await client.query<Record<string, unknown>>(
    `
    /* positive_correction_charge_revision_components_v2 */
    SELECT revisions.id::text, revisions.revision, revisions.source_type, revisions.source_id, revisions.metadata,
      to_jsonb(components) AS components
    FROM app.order_commercial_revisions revisions
    JOIN app.order_commercial_revision_components components ON components.revision_id=revisions.id
    WHERE revisions.merchant_id=$1 AND revisions.store_id=$2 AND revisions.order_id=$3
      AND revisions.id=ANY($4::uuid[]) AND revisions.currency_code=$5 AND revisions.minor_unit_exponent=$6
  `,
    [
      contract.merchantId,
      contract.storeId,
      contract.orderId,
      [
        contract.baseCommercialRevisionId,
        contract.effectiveCommercialRevisionId,
      ],
      contract.currencyCode,
      contract.minorUnitExponent,
    ],
  );
  const columns = {
    merchandiseGrossMinor: "merchandise_gross_minor",
    discountMinor: "discount_minor",
    merchandiseNetMinor: "merchandise_net_minor",
    shippingMinor: "shipping_minor",
    merchandiseVatMinor: "merchandise_vat_minor",
    shippingVatMinor: "shipping_vat_minor",
    vatMinor: "vat_minor",
    unclassifiedMinor: "unclassified_minor",
    totalMinor: "total_minor",
    paymentFeeMinor: "payment_fee_minor",
    paymentFeeVatMinor: "payment_fee_vat_minor",
  } as const;
  if (result.rows.length !== 2)
    throw new Error(
      "positive correction revision component lineage is unavailable",
    );
  for (const [id, revision, expected, effective] of [
    [
      contract.baseCommercialRevisionId,
      contract.baseCommercialRevision,
      contract.beforeComponents,
      false,
    ],
    [
      contract.effectiveCommercialRevisionId,
      contract.effectiveCommercialRevision,
      contract.effectiveComponents,
      true,
    ],
  ] as const) {
    const row = result.rows.find((row) => row.id === id),
      components = row?.components as Record<string, unknown> | undefined;
    const version = Number(components?.component_version ?? 1);
    if (
      !row ||
      !components ||
      Number(row.revision) !== revision ||
      components.tax_mode !== expected.taxMode ||
      (version !== 1 && version !== 2) ||
      (effective &&
        (version !== 2 ||
          (row.metadata as Record<string, unknown>)?.bundleVersion !== 2 ||
          row.source_type !== "order_correction" ||
          row.source_id !== contract.correctionId)) ||
      Object.entries(columns).some(
        ([key, column]) =>
          Number(
            components[column] ?? (column.startsWith("payment_fee_") ? 0 : NaN),
          ) !== expected[key as keyof typeof columns],
      )
    ) {
      throw new Error("positive correction revision component drift");
    }
  }
}

function paymentIdentity(method: PositiveCorrectionSettlementMethodV1) {
  if (method === "cash") {
    return {
      method: "cash" as const,
      status: "posted" as const,
      evidenceType: "cash_receipt" as const,
    };
  }
  if (method === "cod") {
    return {
      method: "cod" as const,
      status: "posted" as const,
      evidenceType: "cod_order_created" as const,
    };
  }
  if (method === "bank_transfer") {
    return {
      method: "manual_bank" as const,
      status: "pending" as const,
      evidenceType: null,
    };
  }
  throw new Error("positive correction settlement method is unsupported");
}

export async function recordPositiveCorrectionChargeV1(
  client: PoolClient,
  input: Omit<RecordPositiveCorrectionChargeInputV1, "contract"> & {
    contract:
      | PositiveCorrectionChargeContractV1
      | PositiveCorrectionChargeContractV2;
  },
): Promise<PersistedPositiveCorrectionChargeV1> {
  const settlement = paymentIdentity(input.settlementMethod);
  const contract = normalizeContract(structuredClone(input.contract));
  const statementTimeoutMs = bounded(
    input.statementTimeoutMs,
    "statement timeout",
    30_000,
  );
  const lockTimeoutMs = bounded(input.lockTimeoutMs, "lock timeout", 5_000);
  if (lockTimeoutMs > statementTimeoutMs) {
    throw new Error(
      "positive correction lock timeout cannot exceed statement timeout",
    );
  }
  const transactionOwnership = input.transactionOwnership ?? "repository";
  let transactionStarted = false;
  try {
    if (transactionOwnership === "repository") {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED");
      transactionStarted = true;
    }
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${statementTimeoutMs}ms`,
    ]);
    await client.query("SELECT set_config('lock_timeout', $1, true)", [
      `${lockTimeoutMs}ms`,
    ]);
    for (const key of [
      `payment-correction:${contract.merchantId}:${contract.storeId}:${contract.correctionId}`,
      `payment-order:${contract.merchantId}:${contract.storeId}:${contract.orderId}`,
    ].sort()) {
      await client.query(
        `
        /* positive_correction_charge_lock */
        SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
      `,
        [key],
      );
    }
    if (contract.schemaVersion === 2)
      await assertV2RevisionComponents(client, contract);

    const existing = await client.query<Record<string, unknown>>(
      `
      /* positive_correction_charge_existing */
      SELECT events.id::text AS payment_event_id,
             obligations.id::text AS obligation_id,
             events.amount_minor,
             events.status,
             events.method,
             events.evidence_type,
             events.metadata->>'contractFingerprint' AS contract_fingerprint
      FROM app.payment_events events
      JOIN app.commercial_obligations obligations
        ON obligations.merchant_id = events.merchant_id
       AND obligations.store_id = events.store_id
       AND obligations.source_type = events.source_type
       AND obligations.source_id = events.source_id
       AND obligations.obligation_kind = 'order_correction_charge'
      WHERE events.merchant_id = $1
        AND events.store_id = $2
        AND events.source_type = 'order_correction'
        AND events.source_id = $3
        AND events.kind = 'charge'
      ORDER BY events.id
    `,
      [contract.merchantId, contract.storeId, contract.correctionId],
    );
    if (existing.rows.length > 1) {
      throw new Error(
        "positive correction charge has conflicting persisted identities",
      );
    }
    if (existing.rows.length === 1) {
      const row = existing.rows[0]!;
      if (
        row.contract_fingerprint !== contract.contractFingerprint ||
        row.status !== settlement.status ||
        row.method !== settlement.method ||
        row.evidence_type !== settlement.evidenceType ||
        integer(row.amount_minor, "replay amount") !==
          contract.collectionAllocation.amountMinor
      ) {
        throw new Error("positive correction charge replay drift");
      }
      if (transactionStarted) await client.query("COMMIT");
      return {
        outcome: "replayed",
        contractFingerprint: contract.contractFingerprint,
        merchantId: contract.merchantId,
        storeId: contract.storeId,
        orderId: contract.orderId,
        correctionId: contract.correctionId,
        paymentEventId: uuid(row.payment_event_id, "payment event id"),
        obligationId: uuid(row.obligation_id, "obligation id"),
        amountMinor: contract.collectionAllocation.amountMinor,
        status: settlement.status,
        method: settlement.method,
      };
    }

    const eventInsert = await client.query<{ id: unknown }>(
      `
      /* positive_correction_charge_insert_event */
      INSERT INTO app.payment_events (
        merchant_id, store_id, order_id, commercial_revision_id,
        kind, status, method, evidence_type, evidence_fingerprint,
        currency_code, minor_unit_exponent, amount_minor, idempotency_key,
        source_type, source_id, source_occurred_at, metadata
      ) VALUES (
        $1, $2, $3, $4,
        'charge', $5, $6, $7, $8,
        $9, $10, $11, $12,
        'order_correction', $13, $14::timestamptz, $15::jsonb
      )
      RETURNING id::text AS id
    `,
      [
        contract.merchantId,
        contract.storeId,
        contract.orderId,
        contract.effectiveCommercialRevisionId,
        settlement.status,
        settlement.method,
        settlement.evidenceType,
        settlement.status === "posted" ? contract.contractFingerprint : null,
        contract.currencyCode,
        contract.minorUnitExponent,
        contract.collectionAllocation.amountMinor,
        contract.collectionAllocation.eventIdempotencyKey,
        contract.correctionId,
        contract.sourceOccurredAt,
        JSON.stringify({
          contractVersion: contract.schemaVersion,
          contractFingerprint: contract.contractFingerprint,
          componentAttribution:
            contract.collectionAllocation.componentAttribution,
        }),
      ],
    );
    if (eventInsert.rows.length !== 1)
      throw new Error("positive correction event insert coverage drift");
    const paymentEventId = uuid(eventInsert.rows[0]!.id, "payment event id");

    if (settlement.status === "posted") {
      const evidence = await client.query(
        `
        /* positive_correction_charge_insert_evidence */
        INSERT INTO app.payment_event_evidence (
          payment_event_id, merchant_id, store_id, evidence_type, source_system,
          source_reference, verification_status, evidence_fingerprint,
          source_occurred_at, evidence_payload
        ) VALUES (
          $1, $2, $3, $4, 'order_correction',
          $5, 'verified', $6, $7::timestamptz, $8::jsonb
        )
      `,
        [
          paymentEventId,
          contract.merchantId,
          contract.storeId,
          settlement.evidenceType,
          contract.correctionId,
          contract.contractFingerprint,
          contract.sourceOccurredAt,
          JSON.stringify({ contractFingerprint: contract.contractFingerprint }),
        ],
      );
      if (evidence.rowCount !== 1)
        throw new Error("positive correction evidence insert coverage drift");
    }

    const d = contract.componentDelta;
    const delta = await client.query(
      `
      /* positive_correction_charge_insert_delta */
      INSERT INTO app.payment_correction_component_deltas (
        payment_event_id, merchant_id, store_id, order_id,
        base_commercial_revision_id, effective_commercial_revision_id,
        currency_code, minor_unit_exponent, tax_mode,
        merchandise_gross_delta_minor, discount_delta_minor,
        merchandise_net_delta_minor, shipping_delta_minor,
        merchandise_vat_delta_minor, shipping_vat_delta_minor, vat_delta_minor,
        unclassified_delta_minor, total_delta_minor,
        base_snapshot_fingerprint, effective_snapshot_fingerprint,
        contract_fingerprint${contract.schemaVersion === 2 ? ", component_version, payment_fee_delta_minor, payment_fee_vat_delta_minor" : ""}
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21${contract.schemaVersion === 2 ? ", 2, $22, $23" : ""}
      )
    `,
      [
        paymentEventId,
        contract.merchantId,
        contract.storeId,
        contract.orderId,
        contract.baseCommercialRevisionId,
        contract.effectiveCommercialRevisionId,
        contract.currencyCode,
        contract.minorUnitExponent,
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
        contract.beforeComponentsFingerprint,
        contract.effectiveComponentsFingerprint,
        contract.contractFingerprint,
        ...(contract.schemaVersion === 2
          ? [
              contract.componentDelta.paymentFeeMinor,
              contract.componentDelta.paymentFeeVatMinor,
            ]
          : []),
      ],
    );
    if (delta.rowCount !== 1)
      throw new Error("positive correction delta insert coverage drift");

    const obligationInsert = await client.query<{ id: unknown }>(
      `
      /* positive_correction_charge_insert_obligation */
      INSERT INTO app.commercial_obligations (
        merchant_id, store_id, order_id, commercial_revision_id,
        obligation_kind, currency_code, minor_unit_exponent, amount_minor,
        idempotency_key, source_type, source_id, source_occurred_at, metadata
      ) VALUES (
        $1, $2, $3, $4, 'order_correction_charge', $5, $6, $7,
        $8, 'order_correction', $9, $10::timestamptz, $11::jsonb
      )
      RETURNING id::text AS id
    `,
      [
        contract.merchantId,
        contract.storeId,
        contract.orderId,
        contract.effectiveCommercialRevisionId,
        contract.currencyCode,
        contract.minorUnitExponent,
        contract.collectionAllocation.amountMinor,
        contract.collectionAllocation.obligationIdempotencyKey,
        contract.correctionId,
        contract.sourceOccurredAt,
        JSON.stringify({ contractFingerprint: contract.contractFingerprint }),
      ],
    );
    if (obligationInsert.rows.length !== 1)
      throw new Error("positive correction obligation insert coverage drift");
    const obligationId = uuid(obligationInsert.rows[0]!.id, "obligation id");

    if (settlement.status === "posted") {
      const allocation = await client.query(
        `
        /* positive_correction_charge_insert_allocation */
        INSERT INTO app.payment_event_allocations (
          merchant_id, store_id, obligation_id, payment_event_id,
          allocation_kind, currency_code, minor_unit_exponent, amount_minor,
          idempotency_key, allocated_at
        ) VALUES ($1, $2, $3, $4, 'collection', $5, $6, $7, $8, $9::timestamptz)
      `,
        [
          contract.merchantId,
          contract.storeId,
          obligationId,
          paymentEventId,
          contract.currencyCode,
          contract.minorUnitExponent,
          contract.collectionAllocation.amountMinor,
          contract.collectionAllocation.allocationIdempotencyKey,
          contract.sourceOccurredAt,
        ],
      );
      if (allocation.rowCount !== 1)
        throw new Error("positive correction allocation insert coverage drift");
    }
    if (transactionStarted) await client.query("COMMIT");
    return {
      outcome: "inserted",
      contractFingerprint: contract.contractFingerprint,
      merchantId: contract.merchantId,
      storeId: contract.storeId,
      orderId: contract.orderId,
      correctionId: contract.correctionId,
      paymentEventId,
      obligationId,
      amountMinor: contract.collectionAllocation.amountMinor,
      status: settlement.status,
      method: settlement.method,
    };
  } catch (error) {
    if (transactionStarted)
      await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
