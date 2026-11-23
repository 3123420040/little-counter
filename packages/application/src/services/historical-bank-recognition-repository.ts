import type { ClientBase } from "pg";
import { recordAuditEntry } from "../repositories/audit-repository";
import {
  parseHistoricalBankRecognitionItemV1,
  parseHistoricalBankRecognitionManifestV1,
  sha256Canonical,
  type HistoricalBankRecognitionItemV1,
  type HistoricalBankRecognitionManifestV1,
} from "./historical-bank-recognition-contract";

export interface HistoricalBankRecognitionApplyContextV1 {
  runId: string;
  manifestSha256: string;
  actor: string;
  ownerDeclarationSha256: string;
}

export interface HistoricalBankRecognitionApplyResultV1 {
  outcome: "inserted" | "replayed";
  itemId: string;
  paymentEventId: string | null;
}

type SourceState = {
  pendingEventId: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  commercialRevisionId: string;
  baseCommercialRevisionId: string | null;
  sourceType: string;
  sourceId: string;
  obligationId: string;
  obligationKind: string;
  currencyCode: string;
  minorUnitExponent: number;
  amountMinor: number;
  sourceOccurredAt: string;
  collectedMinor: number;
  components: Record<string, unknown> | null;
  delta: Record<string, unknown> | null;
};

function numberValue(value: unknown, field: string, signed = false): number {
  const parsed = Number(String(value));
  if (!Number.isSafeInteger(parsed) || (!signed && parsed < 0)) {
    throw new Error(`historical bank recognition ${field} is invalid`);
  }
  return parsed;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`historical bank recognition ${field} is invalid`);
  return value;
}

function instant(value: unknown, field: string): string {
  const parsed = new Date(value instanceof Date ? value : String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`historical bank recognition ${field} is invalid`);
  return parsed.toISOString();
}

function componentRecord(row: Record<string, unknown>): Record<string, unknown> {
  return {
    taxMode: text(row.tax_mode, "component tax mode"),
    merchandiseGrossMinor: numberValue(row.merchandise_gross_minor, "component merchandise gross"),
    discountMinor: numberValue(row.discount_minor, "component discount"),
    merchandiseNetMinor: numberValue(row.merchandise_net_minor, "component merchandise net"),
    shippingMinor: numberValue(row.shipping_minor, "component shipping"),
    merchandiseVatMinor: numberValue(row.merchandise_vat_minor, "component merchandise VAT"),
    shippingVatMinor: numberValue(row.shipping_vat_minor, "component shipping VAT"),
    vatMinor: numberValue(row.vat_minor, "component VAT"),
    unclassifiedMinor: numberValue(row.unclassified_minor, "component unclassified"),
    totalMinor: numberValue(row.total_minor, "component total"),
  };
}

function deltaRecord(row: Record<string, unknown>): Record<string, unknown> {
  return {
    taxMode: text(row.delta_tax_mode, "delta tax mode"),
    merchandiseGrossMinor: numberValue(row.merchandise_gross_delta_minor, "delta merchandise gross", true),
    discountMinor: numberValue(row.discount_delta_minor, "delta discount", true),
    merchandiseNetMinor: numberValue(row.merchandise_net_delta_minor, "delta merchandise net", true),
    shippingMinor: numberValue(row.shipping_delta_minor, "delta shipping", true),
    merchandiseVatMinor: numberValue(row.merchandise_vat_delta_minor, "delta merchandise VAT", true),
    shippingVatMinor: numberValue(row.shipping_vat_delta_minor, "delta shipping VAT", true),
    vatMinor: numberValue(row.vat_delta_minor, "delta VAT", true),
    unclassifiedMinor: numberValue(row.unclassified_delta_minor, "delta unclassified", true),
    totalMinor: numberValue(row.total_delta_minor, "delta total"),
    baseSnapshotFingerprint: text(row.base_snapshot_fingerprint, "delta base fingerprint"),
    effectiveSnapshotFingerprint: text(row.effective_snapshot_fingerprint, "delta effective fingerprint"),
    contractFingerprint: text(row.contract_fingerprint, "delta contract fingerprint"),
  };
}

export function isHistoricalBankRecognitionBasisV1(
  value: unknown,
  kind: "initial" | "positive_correction",
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const fee = kind === "initial" ? "payment_fee_minor" : "payment_fee_delta_minor";
  const vat = kind === "initial" ? "payment_fee_vat_minor" : "payment_fee_vat_delta_minor";
  return Number(row.component_version ?? 1) === 1
    && Number(row[fee] ?? 0) === 0 && Number(row[vat] ?? 0) === 0;
}

export function historicalBankRecognitionSourceFingerprintV1(state: {
  pendingEventId?: string;
  sourcePendingPaymentEventId?: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  commercialRevisionId?: string;
  sourceCommercialRevisionId?: string;
  baseCommercialRevisionId: string | null;
  sourceType: string;
  sourceId: string;
  obligationId?: string;
  sourceObligationId?: string;
  obligationKind: string;
  currencyCode: string;
  minorUnitExponent: number;
  amountMinor: number;
  sourceOccurredAt: string;
  components: Record<string, unknown> | null;
  delta: Record<string, unknown> | null;
}): string {
  return sha256Canonical({
    sourcePendingPaymentEventId: state.pendingEventId || state.sourcePendingPaymentEventId,
    sourceObligationId: state.obligationId || state.sourceObligationId,
    sourceCommercialRevisionId: state.commercialRevisionId || state.sourceCommercialRevisionId,
    baseCommercialRevisionId: state.baseCommercialRevisionId,
    sourceType: state.sourceType,
    sourceId: state.sourceId,
    merchantId: state.merchantId,
    storeId: state.storeId,
    orderId: state.orderId,
    obligationKind: state.obligationKind,
    currencyCode: state.currencyCode,
    minorUnitExponent: state.minorUnitExponent,
    amountMinor: state.amountMinor,
    sourceOccurredAt: state.sourceOccurredAt,
    components: state.components,
    delta: state.delta,
  });
}

async function authoritativeSource(
  client: ClientBase,
  item: HistoricalBankRecognitionItemV1,
  lock = true,
): Promise<SourceState> {
  const order = await client.query<{ status: string; canceled_at: unknown; deleted_at: unknown }>(`
    SELECT status, canceled_at, deleted_at FROM public."order"
    WHERE id = $1 AND merchant_id = $2 AND store_id = $3
    ${lock ? "FOR UPDATE" : ""}
  `, [item.orderId, item.merchantId, item.storeId]);
  if (order.rows.length !== 1) throw new Error("historical bank recognition order timeline requires an exception");
  const timeline = order.rows[0]!;
  const closed = timeline.status === "canceled" || timeline.canceled_at || timeline.deleted_at;
  if (closed && item.decision !== 'already_satisfied') {
    const observedHash = sha256Canonical({ status: timeline.status,
      canceled_at: timeline.canceled_at ? instant(timeline.canceled_at, 'canceled timestamp') : null,
      deleted_at: timeline.deleted_at ? instant(timeline.deleted_at, 'deleted timestamp') : null });
    if (item.decision !== 'recognize' || item.closedOrderTimelineSha256 !== observedHash) {
      throw new Error("historical bank recognition order timeline requires an exception");
    }
  }
  const result = await client.query<Record<string, unknown>>(`
    /* historical_bank_recognition_authoritative_source */
    SELECT pending.id::text AS pending_event_id,
           pending.merchant_id,
           pending.store_id,
           pending.order_id,
           pending.commercial_revision_id::text AS commercial_revision_id,
           pending.source_type,
           pending.source_id,
           pending.currency_code,
           pending.minor_unit_exponent,
           pending.amount_minor,
           pending.source_occurred_at,
           obligations.id::text AS obligation_id,
           obligations.obligation_kind,
           obligations.amount_minor AS obligation_amount_minor,
           COALESCE((
             SELECT SUM(allocations.amount_minor)
             FROM app.payment_event_allocations allocations
             JOIN app.payment_events allocation_events
               ON allocation_events.id = allocations.payment_event_id
             WHERE allocations.obligation_id = obligations.id
               AND allocations.allocation_kind = 'collection'
               AND allocation_events.status = 'posted'
           ), 0) AS collected_minor,
           components.tax_mode AS component_tax_mode,
           to_jsonb(components) AS component_record,
           to_jsonb(deltas) AS delta_record,
           components.merchandise_gross_minor AS component_merchandise_gross_minor,
           components.discount_minor AS component_discount_minor,
           components.merchandise_net_minor AS component_merchandise_net_minor,
           components.shipping_minor AS component_shipping_minor,
           components.merchandise_vat_minor AS component_merchandise_vat_minor,
           components.shipping_vat_minor AS component_shipping_vat_minor,
           components.vat_minor AS component_vat_minor,
           components.unclassified_minor AS component_unclassified_minor,
           components.total_minor AS component_total_minor,
           deltas.base_commercial_revision_id::text AS base_commercial_revision_id,
           deltas.tax_mode AS delta_tax_mode,
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
      ON obligations.id = $2::uuid
     AND obligations.merchant_id = pending.merchant_id
     AND obligations.store_id = pending.store_id
     AND obligations.order_id = pending.order_id
     AND obligations.commercial_revision_id = pending.commercial_revision_id
    LEFT JOIN app.payment_event_component_allocations components
      ON components.payment_event_id = pending.id
    LEFT JOIN app.payment_correction_component_deltas deltas
      ON deltas.payment_event_id = pending.id
    WHERE pending.id = $1::uuid
      AND pending.kind = 'charge'
      AND pending.status = 'pending'
      AND pending.method = 'manual_bank'
      AND pending.evidence_type IS NULL
      AND pending.evidence_fingerprint IS NULL
    ${lock ? "FOR UPDATE OF pending, obligations" : ""}
  `, [item.sourcePendingPaymentEventId, item.sourceObligationId]);
  if (result.rows.length !== 1) throw new Error("historical bank recognition source is unavailable or not pending");
  const row = result.rows[0]!;
  const componentFields = Object.fromEntries(Object.entries(row)
    .filter(([key]) => key.startsWith("component_"))
    .map(([key, value]) => [key.slice("component_".length), value]));
  const hasComponents = componentFields.tax_mode !== null && componentFields.tax_mode !== undefined;
  const hasDelta = row.delta_tax_mode !== null && row.delta_tax_mode !== undefined;
  if (hasComponents === hasDelta) throw new Error("historical bank recognition source component basis is ambiguous");
  if (!isHistoricalBankRecognitionBasisV1(hasComponents ? row.component_record : row.delta_record,
    hasComponents ? "initial" : "positive_correction")) {
    throw new Error("historical bank recognition requires a V1 fee0 source basis");
  }
  const components = hasComponents ? componentRecord(componentFields) : null;
  const delta = hasDelta ? deltaRecord(row) : null;
  const state: SourceState = {
    pendingEventId: text(row.pending_event_id, "pending event"),
    merchantId: text(row.merchant_id, "merchant"),
    storeId: text(row.store_id, "store"),
    orderId: text(row.order_id, "order"),
    commercialRevisionId: text(row.commercial_revision_id, "commercial revision"),
    baseCommercialRevisionId: row.base_commercial_revision_id ? text(row.base_commercial_revision_id, "base commercial revision") : null,
    sourceType: text(row.source_type, "source type"),
    sourceId: text(row.source_id, "source id"),
    obligationId: text(row.obligation_id, "obligation"),
    obligationKind: text(row.obligation_kind, "obligation kind"),
    currencyCode: text(row.currency_code, "currency"),
    minorUnitExponent: numberValue(row.minor_unit_exponent, "minor exponent"),
    amountMinor: numberValue(row.amount_minor, "amount"),
    sourceOccurredAt: instant(row.source_occurred_at, "source occurred at"),
    collectedMinor: numberValue(row.collected_minor, "collected"),
    components,
    delta,
  };
  if (numberValue(row.obligation_amount_minor, "obligation amount") !== state.amountMinor) {
    throw new Error("historical bank recognition obligation amount drift");
  }
  return state;
}

function assertSourceMatchesItem(state: SourceState, item: HistoricalBankRecognitionItemV1): void {
  if (item.decision !== "recognize") {
    throw new Error("historical bank recognition source assertion requires a recognition item");
  }
  const exact: Array<[unknown, unknown, string]> = [
    [state.pendingEventId, item.sourcePendingPaymentEventId, "pending event"],
    [state.obligationId, item.sourceObligationId, "obligation"],
    [state.commercialRevisionId, item.sourceCommercialRevisionId, "commercial revision"],
    [state.merchantId, item.merchantId, "merchant"],
    [state.storeId, item.storeId, "store"],
    [state.orderId, item.orderId, "order"],
    [state.currencyCode, item.currencyCode, "currency"],
    [state.minorUnitExponent, item.minorUnitExponent, "minor exponent"],
    [state.amountMinor, item.amountMinor, "amount"],
    [state.sourceOccurredAt, item.economicOccurredAt, "economic time"],
    [historicalBankRecognitionSourceFingerprintV1(state), item.sourcePayloadSha256, "source payload fingerprint"],
  ];
  for (const [actual, expected, field] of exact) {
    if (actual !== expected) {
      throw new Error(field === "economic time"
        ? `historical bank recognition economic time drift (${String(actual)} != ${String(expected)})`
        : `historical bank recognition ${field} drift`);
    }
  }
  if (state.collectedMinor !== 0) throw new Error("historical bank recognition obligation already has a posted collection");
  if (item.recognitionKind === "initial") {
    if (state.sourceType !== "order_created" || state.obligationKind !== "order_charge" || !state.components || state.delta) {
      throw new Error("historical initial recognition lineage drift");
    }
    if (sha256Canonical(state.components) !== item.componentBasisFingerprint
      || sha256Canonical(state.components) !== sha256Canonical(item.components)) {
      throw new Error("historical initial recognition component drift");
    }
  } else {
    if (state.sourceType !== "order_correction" || state.obligationKind !== "order_correction_charge" || !state.delta || state.components
      || state.baseCommercialRevisionId !== item.baseCommercialRevisionId) {
      throw new Error("historical correction recognition lineage drift");
    }
    if (sha256Canonical(state.delta) !== item.componentBasisFingerprint
      || sha256Canonical(state.delta) !== sha256Canonical(item.delta)) {
      throw new Error("historical correction recognition component drift");
    }
  }
}

async function insertRegistryItem(
  client: ClientBase,
  context: HistoricalBankRecognitionApplyContextV1,
  item: HistoricalBankRecognitionItemV1,
): Promise<void> {
  const recognized = item.decision === "recognize";
  await client.query(`
    INSERT INTO app.historical_bank_recognition_items (
      id, run_id, manifest_row_number, merchant_id, store_id, order_id, decision, reason_code,
      source_pending_payment_event_id, source_obligation_id, source_commercial_revision_id,
      base_commercial_revision_id, recognition_kind, target_payment_event_id, target_source_type,
      target_source_id, target_idempotency_key, evidence_fingerprint, source_payload_sha256,
      component_basis_fingerprint, owner_declaration_reference_sha256, currency_code,
      minor_unit_exponent, amount_minor, economic_occurred_at, metadata
    ) VALUES (
      $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
      $9::uuid, $10::uuid, $11::uuid, $12::uuid, $13, $14::uuid, $15,
      $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::timestamptz, $26::jsonb
    )
  `, [
    item.itemId, context.runId, item.rowNumber, item.merchantId, item.storeId, item.orderId,
    item.decision, item.reasonCode, item.sourcePendingPaymentEventId, item.sourceObligationId,
    item.sourceCommercialRevisionId, item.recognitionKind === "positive_correction" ? item.baseCommercialRevisionId : null,
    item.recognitionKind, recognized ? item.targetPaymentEventId : null,
    recognized ? item.targetSourceType : null, recognized ? item.targetSourceId : null,
    recognized ? item.targetIdempotencyKey : null, recognized ? item.evidenceFingerprint : null,
    item.sourcePayloadSha256, item.componentBasisFingerprint, item.ownerDeclarationReferenceSha256,
    item.currencyCode, item.minorUnitExponent, item.amountMinor, item.economicOccurredAt,
    JSON.stringify({ manifestSha256: context.manifestSha256, ownerDeclarationSha256: context.ownerDeclarationSha256, itemSha256: sha256Canonical(item) }),
  ]);
}

async function insertRecognitionBundle(
  client: ClientBase,
  context: HistoricalBankRecognitionApplyContextV1,
  item: Extract<HistoricalBankRecognitionItemV1, { decision: "recognize" }>,
  state: SourceState,
): Promise<void> {
  const metadata = {
    bundleVersion: 1,
    historicalRecognitionItemId: item.itemId,
    historicalManifestSha256: context.manifestSha256,
    priorPendingPaymentEventId: item.sourcePendingPaymentEventId,
    sourcePayloadSha256: item.sourcePayloadSha256,
    ...(item.recognitionKind === "positive_correction" ? {
      correctionId: state.sourceId,
      contractFingerprint: item.delta.contractFingerprint,
    } : {}),
  };
  await client.query(`
    INSERT INTO app.payment_events (
      id, merchant_id, store_id, order_id, commercial_revision_id,
      kind, status, method, evidence_type, evidence_fingerprint,
      currency_code, minor_unit_exponent, amount_minor, idempotency_key,
      source_type, source_id, source_occurred_at, metadata
    ) VALUES (
      $1::uuid, $2, $3, $4, $5::uuid,
      'charge', 'posted', 'manual_bank', 'owner_historical_recognition', $6,
      $7, $8, $9, $10, $11, $12, $13::timestamptz, $14::jsonb
    )
  `, [
    item.targetPaymentEventId, item.merchantId, item.storeId, item.orderId,
    item.sourceCommercialRevisionId, item.evidenceFingerprint, item.currencyCode,
    item.minorUnitExponent, item.amountMinor, item.targetIdempotencyKey,
    item.targetSourceType, item.targetSourceId, item.economicOccurredAt, JSON.stringify(metadata),
  ]);
  await client.query(`
    INSERT INTO app.payment_event_evidence (
      payment_event_id, merchant_id, store_id, evidence_type, source_system,
      source_reference, verification_status, evidence_fingerprint, source_occurred_at, evidence_payload
    ) VALUES (
      $1::uuid, $2, $3, 'owner_historical_recognition', 'owner_historical_recognition',
      $4, 'verified', $5, $6::timestamptz, $7::jsonb
    )
  `, [
    item.targetPaymentEventId, item.merchantId, item.storeId, item.ownerDeclarationReferenceSha256,
    item.evidenceFingerprint, item.economicOccurredAt, JSON.stringify({
      schemaVersion: 1,
      manifestSha256: context.manifestSha256,
      sourcePayloadSha256: item.sourcePayloadSha256,
      ownerDeclarationSha256: context.ownerDeclarationSha256,
      recognitionKind: item.recognitionKind,
    }),
  ]);
  if (item.recognitionKind === "initial") {
    const components = item.components;
    await client.query(`
      INSERT INTO app.payment_event_component_allocations (
        payment_event_id, commercial_revision_id, merchant_id, store_id, currency_code,
        minor_unit_exponent, tax_mode, merchandise_gross_minor, discount_minor,
        merchandise_net_minor, shipping_minor, merchandise_vat_minor, shipping_vat_minor,
        vat_minor, unclassified_minor, total_minor
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `, [
      item.targetPaymentEventId, item.sourceCommercialRevisionId, item.merchantId, item.storeId,
      item.currencyCode, item.minorUnitExponent, components.taxMode, components.merchandiseGrossMinor,
      components.discountMinor, components.merchandiseNetMinor, components.shippingMinor,
      components.merchandiseVatMinor, components.shippingVatMinor, components.vatMinor,
      components.unclassifiedMinor, components.totalMinor,
    ]);
  } else {
    const delta = item.delta;
    await client.query(`
      INSERT INTO app.payment_correction_component_deltas (
        payment_event_id, merchant_id, store_id, order_id, base_commercial_revision_id,
        effective_commercial_revision_id, currency_code, minor_unit_exponent, tax_mode,
        merchandise_gross_delta_minor, discount_delta_minor, merchandise_net_delta_minor,
        shipping_delta_minor, merchandise_vat_delta_minor, shipping_vat_delta_minor,
        vat_delta_minor, unclassified_delta_minor, total_delta_minor,
        base_snapshot_fingerprint, effective_snapshot_fingerprint, contract_fingerprint
      ) VALUES (
        $1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
      )
    `, [
      item.targetPaymentEventId, item.merchantId, item.storeId, item.orderId,
      item.baseCommercialRevisionId, item.sourceCommercialRevisionId, item.currencyCode,
      item.minorUnitExponent, delta.taxMode, delta.merchandiseGrossMinor, delta.discountMinor,
      delta.merchandiseNetMinor, delta.shippingMinor, delta.merchandiseVatMinor,
      delta.shippingVatMinor, delta.vatMinor, delta.unclassifiedMinor, delta.totalMinor,
      delta.baseSnapshotFingerprint, delta.effectiveSnapshotFingerprint, delta.contractFingerprint,
    ]);
  }
  await client.query(`
    INSERT INTO app.payment_event_allocations (
      merchant_id, store_id, obligation_id, payment_event_id, allocation_kind,
      currency_code, minor_unit_exponent, amount_minor, idempotency_key, allocated_at
    ) VALUES ($1, $2, $3::uuid, $4::uuid, 'collection', $5, $6, $7, $8, $9::timestamptz)
  `, [
    item.merchantId, item.storeId, item.sourceObligationId, item.targetPaymentEventId,
    item.currencyCode, item.minorUnitExponent, item.amountMinor,
    `historical_bank_recognition:v1:${item.itemId}`, item.economicOccurredAt,
  ]);
}

async function assertRunBinding(
  client: ClientBase,
  context: HistoricalBankRecognitionApplyContextV1,
): Promise<void> {
  const run = await client.query<{ manifest_sha256: string; owner_declaration_sha256: string }>(`
    SELECT manifest_sha256, owner_declaration_sha256
    FROM app.historical_bank_recognition_runs
    WHERE id = $1::uuid
    FOR KEY SHARE
  `, [context.runId]);
  if (run.rows.length !== 1
    || run.rows[0]!.manifest_sha256 !== context.manifestSha256
    || run.rows[0]!.owner_declaration_sha256 !== context.ownerDeclarationSha256) {
    throw new Error("historical bank recognition run binding drift");
  }
}

export async function appendHistoricalBankRecognitionWithClientV1(
  client: ClientBase,
  context: HistoricalBankRecognitionApplyContextV1,
  itemValue: unknown,
): Promise<HistoricalBankRecognitionApplyResultV1> {
  const item = parseHistoricalBankRecognitionItemV1(itemValue);
  let started = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    started = true;
    await client.query("SELECT set_config('statement_timeout', '30000ms', true)");
    await client.query("SELECT set_config('lock_timeout', '5000ms', true)");
    for (const key of [
      `historical-bank:item:${item.itemId}`,
      `historical-bank:pending:${item.merchantId}:${item.storeId}:${item.sourcePendingPaymentEventId}`,
      `historical-bank:obligation:${item.merchantId}:${item.storeId}:${item.sourceObligationId}`,
    ].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    }
    await assertRunBinding(client, context);
    const existing = await client.query<{ id: string; target_payment_event_id: string | null; metadata: Record<string, unknown> }>(`
      SELECT id::text, target_payment_event_id::text, metadata
      FROM app.historical_bank_recognition_items WHERE id = $1::uuid
    `, [item.itemId]);
    if (existing.rows.length === 1) {
      if (existing.rows[0]!.metadata.itemSha256 !== sha256Canonical(item)) {
        throw new Error("historical bank recognition replay item drift");
      }
      const eventId = existing.rows[0]!.target_payment_event_id;
      if (item.decision === "recognize") {
        const proof = await client.query(`
          SELECT 1 FROM app.payment_events events
          JOIN app.payment_event_evidence evidence ON evidence.payment_event_id = events.id
          WHERE events.id = $1::uuid
            AND events.idempotency_key = $2
            AND events.evidence_type = 'owner_historical_recognition'
            AND evidence.evidence_fingerprint = $3
        `, [eventId, item.targetIdempotencyKey, item.evidenceFingerprint]);
        if (proof.rows.length !== 1) throw new Error("historical bank recognition replay proof drift");
      }
      await client.query("COMMIT");
      return { outcome: "replayed", itemId: item.itemId, paymentEventId: eventId };
    }
    if (item.decision === "recognize") {
      const state = await authoritativeSource(client, item);
      assertSourceMatchesItem(state, item);
      await insertRegistryItem(client, context, item);
      await insertRecognitionBundle(client, context, item, state);
      await recordAuditEntry(client, {
        operatorId: context.actor,
        role: "migration",
        serviceIdentity: "historical-bank-recognition",
      }, "payment.owner_historical_recognition_recorded", "payment_event", item.targetPaymentEventId, {
        merchantId: item.merchantId,
        storeId: item.storeId,
        reason: item.reasonCode,
        after: {
          manifestSha256: context.manifestSha256,
          sourcePendingPaymentEventId: item.sourcePendingPaymentEventId,
          sourceObligationId: item.sourceObligationId,
          sourcePayloadSha256: item.sourcePayloadSha256,
          amountMinor: item.amountMinor,
          currencyCode: item.currencyCode,
          economicOccurredAt: item.economicOccurredAt,
        },
      });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("COMMIT");
      return { outcome: "inserted", itemId: item.itemId, paymentEventId: item.targetPaymentEventId };
    }
    await insertRegistryItem(client, context, item);
    await recordAuditEntry(client, {
      operatorId: context.actor,
      role: "migration",
      serviceIdentity: "historical-bank-recognition",
    }, "payment.owner_historical_recognition_dispositioned", "payment_event", item.sourcePendingPaymentEventId, {
      merchantId: item.merchantId,
      storeId: item.storeId,
      reason: item.reasonCode,
      after: { manifestSha256: context.manifestSha256, decision: item.decision },
    });
    await client.query("COMMIT");
    return { outcome: "inserted", itemId: item.itemId, paymentEventId: null };
  } catch (error) {
    if (started) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function validateHistoricalBankRecognitionSourceWithClientV1(
  client: ClientBase,
  itemValue: unknown,
): Promise<void> {
  const item = parseHistoricalBankRecognitionItemV1(itemValue);
  if (item.decision !== "recognize") return;
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const state = await authoritativeSource(client, item, false);
    assertSourceMatchesItem(state, item);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export function validateHistoricalBankRecognitionManifestV1(value: unknown): HistoricalBankRecognitionManifestV1 {
  return parseHistoricalBankRecognitionManifestV1(value);
}
