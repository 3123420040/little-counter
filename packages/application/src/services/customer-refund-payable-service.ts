import { createHash } from "node:crypto";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { freezeRefundAccountingForClientV2 } from "./refund-commercial-allocation-service";

export type CustomerRefundPayableKindV1 =
  | "negative_correction"
  | "shipping_decrease"
  | "order_cancellation"
  | "manual_refund";

export interface CustomerRefundPositionV1 {
  openedMinor: number;
  clearedMinor: number;
  balanceMinor: number;
  recordedGrossCollectionsMinor: number;
  negativeCollectionsMinor: number;
  netCollectionsMinor: number;
}

export interface OpenCustomerRefundPayableInputV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  commercialRevisionId: string;
  kind: CustomerRefundPayableKindV1;
  amountMinor: number;
  sourceType: string;
  sourceId: string;
  sourceOccurredAt: string;
  metadata?: Record<string, unknown>;
}

export interface OpenCustomerRefundPayableResultV1 {
  outcome: "inserted" | "replayed";
  payableId: string;
  amountMinor: number;
}

export interface RecordCustomerRefundPayoutInputV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  amountMinor: number;
  method: "cash" | "bank_transfer" | "cod" | "unknown";
  sourceType: string;
  sourceId: string;
  sourceOccurredAt: string;
  operatorId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface RecordCustomerRefundPayoutResultV1 {
  outcome: "inserted" | "replayed";
  paymentEventId: string;
  amountMinor: number;
  clearedPayableIds: string[];
}

type Queryable = Pick<PoolClient, "query">;

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) {
    throw new PlatformError("financial_invariant_error", `${field} is invalid`, 409);
  }
  return value;
}

function canonicalInstant(value: unknown, field: string): string {
  const parsed = token(value, field);
  const millis = Date.parse(parsed);
  if (!Number.isFinite(millis)) {
    throw new PlatformError("financial_invariant_error", `${field} is invalid`, 409);
  }
  return new Date(millis).toISOString();
}

function positiveMinor(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PlatformError("financial_invariant_error", `${field} is invalid`, 409);
  }
  return parsed;
}

function nonnegativeMinor(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlatformError("financial_invariant_error", `${field} is invalid`, 409);
  }
  return parsed;
}

function uuid(value: unknown, field: string): string {
  const parsed = token(value, field);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(parsed)) {
    throw new PlatformError("financial_invariant_error", `${field} is invalid`, 409);
  }
  return parsed;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalPaymentMethod(
  method: RecordCustomerRefundPayoutInputV1["method"],
): "cash" | "manual_bank" | "cod" | "unknown" {
  if (method === "bank_transfer") return "manual_bank";
  return method;
}

export async function readCustomerRefundPositionV1(
  client: Queryable,
  input: { merchantId: string; storeId: string; orderId: string },
): Promise<CustomerRefundPositionV1> {
  const merchantId = token(input.merchantId, "merchant id");
  const storeId = token(input.storeId, "store id");
  const orderId = token(input.orderId, "order id");
  const result = await client.query<Record<string, unknown>>(`
    /* customer_refund_position */
    SELECT
      COALESCE((
        SELECT SUM(opened_minor)
        FROM app.customer_refund_payable_balances balances
        WHERE balances.merchant_id = $1
          AND balances.store_id = $2
          AND balances.order_id = $3
      ), 0)::text AS opened_minor,
      COALESCE((
        SELECT SUM(cleared_minor)
        FROM app.customer_refund_payable_balances balances
        WHERE balances.merchant_id = $1
          AND balances.store_id = $2
          AND balances.order_id = $3
      ), 0)::text AS cleared_minor,
      COALESCE((
        SELECT SUM(balance_minor)
        FROM app.customer_refund_payable_balances balances
        WHERE balances.merchant_id = $1
          AND balances.store_id = $2
          AND balances.order_id = $3
      ), 0)::text AS balance_minor,
      COALESCE(SUM(events.amount_minor) FILTER (
        WHERE events.kind = 'charge' AND events.status = 'posted'
      ), 0)::text AS recorded_gross_collections_minor,
      COALESCE(SUM(events.amount_minor) FILTER (
        WHERE events.kind IN ('refund', 'reversal', 'chargeback')
          AND events.status = 'posted'
      ), 0)::text AS negative_collections_minor
    FROM app.payment_events events
    WHERE events.merchant_id = $1
      AND events.store_id = $2
      AND events.order_id = $3
  `, [merchantId, storeId, orderId]);
  const row = result.rows[0] || {};
  const openedMinor = nonnegativeMinor(row.opened_minor, "opened payable");
  const clearedMinor = nonnegativeMinor(row.cleared_minor, "cleared payable");
  const balanceMinor = nonnegativeMinor(row.balance_minor, "payable balance");
  const recordedGrossCollectionsMinor = nonnegativeMinor(
    row.recorded_gross_collections_minor,
    "gross collection",
  );
  const negativeCollectionsMinor = nonnegativeMinor(
    row.negative_collections_minor,
    "negative collection",
  );
  if (
    openedMinor - clearedMinor !== balanceMinor
    || negativeCollectionsMinor > recordedGrossCollectionsMinor
  ) {
    throw new PlatformError(
      "financial_invariant_error",
      "Customer refund position does not reconcile",
      409,
    );
  }
  return {
    openedMinor,
    clearedMinor,
    balanceMinor,
    recordedGrossCollectionsMinor,
    negativeCollectionsMinor,
    netCollectionsMinor: recordedGrossCollectionsMinor - negativeCollectionsMinor,
  };
}

export async function openCustomerRefundPayableV1(
  client: PoolClient,
  raw: OpenCustomerRefundPayableInputV1,
): Promise<OpenCustomerRefundPayableResultV1> {
  const input = {
    merchantId: token(raw.merchantId, "merchant id"),
    storeId: token(raw.storeId, "store id"),
    orderId: token(raw.orderId, "order id"),
    commercialRevisionId: uuid(raw.commercialRevisionId, "commercial revision id"),
    kind: raw.kind,
    amountMinor: positiveMinor(raw.amountMinor, "payable amount"),
    sourceType: token(raw.sourceType, "payable source type"),
    sourceId: token(raw.sourceId, "payable source id"),
    sourceOccurredAt: canonicalInstant(raw.sourceOccurredAt, "payable source time"),
    metadata: structuredClone(raw.metadata || {}),
  };
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`customer-refund:${input.merchantId}:${input.storeId}:${input.orderId}`],
  );
  const existing = await client.query<Record<string, unknown>>(`
    SELECT id::text AS id, amount_minor
    FROM app.customer_refund_payables
    WHERE merchant_id = $1 AND store_id = $2
      AND source_type = $3 AND source_id = $4 AND payable_kind = $5
  `, [input.merchantId, input.storeId, input.sourceType, input.sourceId, input.kind]);
  if (existing.rows.length > 1) {
    throw new PlatformError("financial_invariant_error", "Payable identity is ambiguous", 409);
  }
  if (existing.rows.length === 1) {
    const row = existing.rows[0]!;
    if (positiveMinor(row.amount_minor, "persisted payable amount") !== input.amountMinor) {
      throw new PlatformError("financial_invariant_error", "Payable replay amount drift", 409);
    }
    return {
      outcome: "replayed",
      payableId: uuid(row.id, "payable id"),
      amountMinor: input.amountMinor,
    };
  }

  const idempotencyKey = `${input.sourceType}:${input.sourceId}:${input.kind}`;
  const inserted = await client.query<{ id: unknown }>(`
    INSERT INTO app.customer_refund_payables (
      merchant_id, store_id, order_id, commercial_revision_id, payable_kind,
      currency_code, minor_unit_exponent, amount_minor, idempotency_key,
      source_type, source_id, source_occurred_at, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, 'VND', 0, $6, $7,
      $8, $9, $10::timestamptz, $11::jsonb
    ) RETURNING id::text AS id
  `, [
    input.merchantId,
    input.storeId,
    input.orderId,
    input.commercialRevisionId,
    input.kind,
    input.amountMinor,
    idempotencyKey,
    input.sourceType,
    input.sourceId,
    input.sourceOccurredAt,
    JSON.stringify({
      ...input.metadata,
      contractFingerprint: fingerprint({ ...input, metadata: input.metadata }),
    }),
  ]);
  if (inserted.rows.length !== 1) {
    throw new PlatformError("financial_invariant_error", "Payable insert coverage drift", 409);
  }
  const payableId = uuid(inserted.rows[0]!.id, "payable id");
  const openEvent = await client.query(`
    INSERT INTO app.customer_refund_payable_events (
      payable_id, merchant_id, store_id, order_id, event_kind,
      currency_code, minor_unit_exponent, amount_minor, idempotency_key,
      source_type, source_id, source_occurred_at, metadata
    ) VALUES (
      $1, $2, $3, $4, 'open', 'VND', 0, $5, $6,
      $7, $8, $9::timestamptz, $10::jsonb
    )
  `, [
    payableId,
    input.merchantId,
    input.storeId,
    input.orderId,
    input.amountMinor,
    `${idempotencyKey}:open`,
    input.sourceType,
    `${input.sourceId}:open`,
    input.sourceOccurredAt,
    JSON.stringify(input.metadata),
  ]);
  if (openEvent.rowCount !== 1) {
    throw new PlatformError("financial_invariant_error", "Payable open event coverage drift", 409);
  }
  return { outcome: "inserted", payableId, amountMinor: input.amountMinor };
}

export async function recordCustomerRefundPayoutV1(
  client: PoolClient,
  raw: RecordCustomerRefundPayoutInputV1,
): Promise<RecordCustomerRefundPayoutResultV1> {
  if (Object.hasOwn(raw.metadata || {}, "refundAllocationV2")) {
    throw new PlatformError("financial_invariant_error", "Refund accounting metadata is server-owned", 409);
  }
  const input = {
    merchantId: token(raw.merchantId, "merchant id"),
    storeId: token(raw.storeId, "store id"),
    orderId: token(raw.orderId, "order id"),
    amountMinor: positiveMinor(raw.amountMinor, "refund payout amount"),
    method: raw.method,
    sourceType: token(raw.sourceType, "refund source type"),
    sourceId: token(raw.sourceId, "refund source id"),
    sourceOccurredAt: canonicalInstant(raw.sourceOccurredAt, "refund source time"),
    operatorId: token(raw.operatorId, "refund operator id"),
    reason: token(raw.reason, "refund reason"),
    metadata: structuredClone(raw.metadata || {}),
  };
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`customer-refund:${input.merchantId}:${input.storeId}:${input.orderId}`],
  );

  const existing = await client.query<Record<string, unknown>>(`
    SELECT id::text AS id, amount_minor
    FROM app.payment_events
    WHERE merchant_id = $1 AND store_id = $2
      AND source_type = $3 AND source_id = $4 AND kind = 'refund'
  `, [input.merchantId, input.storeId, input.sourceType, input.sourceId]);
  if (existing.rows.length > 1) {
    throw new PlatformError("financial_invariant_error", "Refund payout identity is ambiguous", 409);
  }
  if (existing.rows.length === 1) {
    const paymentEventId = uuid(existing.rows[0]!.id, "payment event id");
    if (positiveMinor(existing.rows[0]!.amount_minor, "persisted payout amount") !== input.amountMinor) {
      throw new PlatformError("financial_invariant_error", "Refund payout replay amount drift", 409);
    }
    const cleared = await client.query<{ payable_id: unknown }>(`
      SELECT payable_id::text AS payable_id
      FROM app.customer_refund_payout_allocations
      WHERE payment_event_id = $1
      ORDER BY allocated_at, id
    `, [paymentEventId]);
    return {
      outcome: "replayed",
      paymentEventId,
      amountMinor: input.amountMinor,
      clearedPayableIds: cleared.rows.map((row) => uuid(row.payable_id, "payable id")),
    };
  }

  await client.query(`
    SELECT id
    FROM app.customer_refund_payables
    WHERE merchant_id = $1 AND store_id = $2 AND order_id = $3
    ORDER BY source_occurred_at, id
    FOR UPDATE
  `, [input.merchantId, input.storeId, input.orderId]);
  const payableRows = await client.query<Record<string, unknown>>(`
    SELECT balances.payable_id::text AS payable_id, balances.balance_minor,
      payables.payable_kind, payables.commercial_revision_id::text,
      payables.source_type, payables.source_id, to_jsonb(components) AS component_record
    FROM app.customer_refund_payable_balances balances
    JOIN app.customer_refund_payables payables ON payables.id = balances.payable_id
    JOIN app.order_commercial_revision_components components ON components.revision_id = payables.commercial_revision_id
    WHERE balances.merchant_id = $1 AND balances.store_id = $2 AND balances.order_id = $3
      AND balances.balance_minor > 0
    ORDER BY balances.source_occurred_at, balances.payable_id
  `, [input.merchantId, input.storeId, input.orderId]);
  const payableBalance = payableRows.rows.reduce(
    (sum, row) => sum + positiveMinor(row.balance_minor, "payable balance"),
    0,
  );
  if (!Number.isSafeInteger(payableBalance) || input.amountMinor > payableBalance) {
    throw new PlatformError(
      "refund_amount_exceeds_payable",
      "Refund amount exceeds open customer refund payable",
      409,
      { requested: input.amountMinor, payable: payableBalance },
    );
  }

  await client.query(`
    SELECT id
    FROM app.commercial_obligations
    WHERE merchant_id = $1 AND store_id = $2 AND order_id = $3
    ORDER BY source_occurred_at, id
    FOR UPDATE
  `, [input.merchantId, input.storeId, input.orderId]);
  const obligations = await client.query<Record<string, unknown>>(`
    SELECT obligations.id::text AS obligation_id,
      GREATEST(0,
        COALESCE(SUM(allocations.amount_minor) FILTER (
          WHERE allocations.allocation_kind = 'collection'
        ), 0)
        - COALESCE(SUM(allocations.amount_minor) FILTER (
          WHERE allocations.allocation_kind IN ('refund', 'reversal', 'chargeback')
        ), 0)
      )::text AS refundable_minor
    FROM app.commercial_obligations obligations
    LEFT JOIN app.payment_event_allocations allocations
      ON allocations.obligation_id = obligations.id
    WHERE obligations.merchant_id = $1
      AND obligations.store_id = $2
      AND obligations.order_id = $3
    GROUP BY obligations.id
    HAVING GREATEST(0,
      COALESCE(SUM(allocations.amount_minor) FILTER (
        WHERE allocations.allocation_kind = 'collection'
      ), 0)
      - COALESCE(SUM(allocations.amount_minor) FILTER (
        WHERE allocations.allocation_kind IN ('refund', 'reversal', 'chargeback')
      ), 0)
    ) > 0
    ORDER BY obligations.source_occurred_at, obligations.id
  `, [input.merchantId, input.storeId, input.orderId]);
  const refundableMinor = obligations.rows.reduce(
    (sum, row) => sum + positiveMinor(row.refundable_minor, "obligation refundable amount"),
    0,
  );
  if (!Number.isSafeInteger(refundableMinor) || input.amountMinor > refundableMinor) {
    throw new PlatformError(
      "refund_amount_exceeds_balance",
      "Refund amount exceeds canonical collected balance",
      409,
      { requested: input.amountMinor, refundable: refundableMinor },
    );
  }

  const latestRevision = await client.query<{ id: unknown; component_version: number }>(`
    SELECT revisions.id::text AS id,
      COALESCE((to_jsonb(components)->>'component_version')::int, 1) AS component_version
    FROM app.order_commercial_revisions revisions
    JOIN app.order_commercial_revision_components components ON components.revision_id = revisions.id
    WHERE revisions.merchant_id = $1 AND revisions.store_id = $2 AND revisions.order_id = $3
    ORDER BY revisions.revision DESC, revisions.effective_at DESC, revisions.id DESC
    LIMIT 1
    FOR UPDATE OF revisions
  `, [input.merchantId, input.storeId, input.orderId]);
  if (latestRevision.rows.length !== 1) {
    throw new PlatformError("financial_invariant_error", "Canonical commercial revision is unavailable", 409);
  }
  const commercialRevisionId = uuid(latestRevision.rows[0]!.id, "commercial revision id");
  const refundAllocationV2 = await freezeRefundAccountingForClientV2(client, input, input.amountMinor,
    latestRevision.rows[0]!.component_version, payableRows.rows, obligations.rows);
  const evidenceFingerprint = fingerprint({
    schemaVersion: 1,
    merchantId: input.merchantId,
    storeId: input.storeId,
    orderId: input.orderId,
    amountMinor: input.amountMinor,
    method: input.method,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceOccurredAt: input.sourceOccurredAt,
    operatorId: input.operatorId,
  });
  const inserted = await client.query<{ id: unknown }>(`
    INSERT INTO app.payment_events (
      merchant_id, store_id, order_id, commercial_revision_id,
      kind, status, method, evidence_type, evidence_fingerprint,
      currency_code, minor_unit_exponent, amount_minor, idempotency_key,
      source_type, source_id, source_occurred_at, metadata
    ) VALUES (
      $1, $2, $3, $4, 'refund', 'posted', $5,
      'negative_collection_confirmed', $6, 'VND', 0, $7, $8,
      $9, $10, $11::timestamptz, $12::jsonb
    ) RETURNING id::text AS id
  `, [
    input.merchantId,
    input.storeId,
    input.orderId,
    commercialRevisionId,
    canonicalPaymentMethod(input.method),
    evidenceFingerprint,
    input.amountMinor,
    `${input.sourceType}:${input.sourceId}:refund`,
    input.sourceType,
    input.sourceId,
    input.sourceOccurredAt,
    JSON.stringify({ ...input.metadata, operatorId: input.operatorId, reason: input.reason,
      ...(refundAllocationV2 ? { refundAllocationV2 } : {}) }),
  ]);
  if (inserted.rows.length !== 1) {
    throw new PlatformError("financial_invariant_error", "Refund payment event coverage drift", 409);
  }
  const paymentEventId = uuid(inserted.rows[0]!.id, "payment event id");
  const evidence = await client.query(`
    INSERT INTO app.payment_event_evidence (
      payment_event_id, merchant_id, store_id, evidence_type, source_system,
      source_reference, verification_status, evidence_fingerprint,
      source_occurred_at, evidence_payload
    ) VALUES (
      $1, $2, $3, 'negative_collection_confirmed', $4, $5,
      'verified', $6, $7::timestamptz, $8::jsonb
    )
  `, [
    paymentEventId,
    input.merchantId,
    input.storeId,
    input.sourceType,
    input.sourceId,
    evidenceFingerprint,
    input.sourceOccurredAt,
    JSON.stringify({ operatorId: input.operatorId, reason: input.reason }),
  ]);
  if (evidence.rowCount !== 1) {
    throw new PlatformError("financial_invariant_error", "Refund evidence coverage drift", 409);
  }

  let remaining = input.amountMinor;
  for (const row of obligations.rows) {
    if (remaining === 0) break;
    const available = positiveMinor(row.refundable_minor, "obligation refundable amount");
    const allocated = Math.min(available, remaining);
    const obligationId = uuid(row.obligation_id, "obligation id");
    await client.query(`
      INSERT INTO app.payment_event_allocations (
        merchant_id, store_id, obligation_id, payment_event_id,
        allocation_kind, currency_code, minor_unit_exponent, amount_minor,
        idempotency_key, allocated_at
      ) VALUES ($1, $2, $3, $4, 'refund', 'VND', 0, $5, $6, $7::timestamptz)
    `, [
      input.merchantId,
      input.storeId,
      obligationId,
      paymentEventId,
      allocated,
      `${input.sourceType}:${input.sourceId}:obligation:${obligationId}`,
      input.sourceOccurredAt,
    ]);
    remaining -= allocated;
  }
  if (remaining !== 0) {
    throw new PlatformError("financial_invariant_error", "Refund allocation coverage drift", 409);
  }

  remaining = input.amountMinor;
  const clearedPayableIds: string[] = [];
  for (const row of payableRows.rows) {
    if (remaining === 0) break;
    const available = positiveMinor(row.balance_minor, "payable balance");
    const cleared = Math.min(available, remaining);
    const payableId = uuid(row.payable_id, "payable id");
    const clearEvent = await client.query<{ id: unknown }>(`
      INSERT INTO app.customer_refund_payable_events (
        payable_id, merchant_id, store_id, order_id, event_kind,
        clearance_kind, payment_event_id, currency_code, minor_unit_exponent,
        amount_minor, idempotency_key, source_type, source_id,
        source_occurred_at, metadata
      ) VALUES (
        $1, $2, $3, $4, 'clear', 'payout', $5, 'VND', 0,
        $6, $7, $8, $9, $10::timestamptz, $11::jsonb
      ) RETURNING id::text AS id
    `, [
      payableId,
      input.merchantId,
      input.storeId,
      input.orderId,
      paymentEventId,
      cleared,
      `${input.sourceType}:${input.sourceId}:payable:${payableId}:clear`,
      input.sourceType,
      `${input.sourceId}:payable:${payableId}`,
      input.sourceOccurredAt,
      JSON.stringify({ operatorId: input.operatorId, reason: input.reason }),
    ]);
    if (clearEvent.rows.length !== 1) {
      throw new PlatformError("financial_invariant_error", "Payable clear event coverage drift", 409);
    }
    const payableEventId = uuid(clearEvent.rows[0]!.id, "payable event id");
    await client.query(`
      INSERT INTO app.customer_refund_payout_allocations (
        payable_id, payable_event_id, payment_event_id, merchant_id, store_id,
        order_id, currency_code, minor_unit_exponent, amount_minor,
        idempotency_key, allocated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'VND', 0, $7, $8, $9::timestamptz)
    `, [
      payableId,
      payableEventId,
      paymentEventId,
      input.merchantId,
      input.storeId,
      input.orderId,
      cleared,
      `${input.sourceType}:${input.sourceId}:payable:${payableId}:allocation`,
      input.sourceOccurredAt,
    ]);
    clearedPayableIds.push(payableId);
    remaining -= cleared;
  }
  if (remaining !== 0) {
    throw new PlatformError("financial_invariant_error", "Payable payout coverage drift", 409);
  }
  return { outcome: "inserted", paymentEventId, amountMinor: input.amountMinor, clearedPayableIds };
}
