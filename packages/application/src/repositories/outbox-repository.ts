import { resolveExactOutboxEventContract } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";

export type ExactOutboxWrite = {
  merchantId: string;
  storeId: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  sourceEventId: string;
  sourceOccurredAt: string;
  retryPolicyKey: string;
  payload: Record<string, unknown>;
};

export class ExactOutboxConflictError extends Error {
  readonly code = "exact_outbox_source_conflict";

  constructor(sourceEventId: string) {
    super(`Exact outbox source identity conflicts with existing facts: ${sourceEventId}`);
    this.name = "ExactOutboxConflictError";
  }
}

type ExistingExactEvent = {
  id: string;
  merchant_id: string;
  store_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number | string;
  source_occurred_at: Date | string;
  retry_policy_key: string;
  payload_matches: boolean;
};

function requiredText(value: string, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Exact outbox ${field} is required`);
  return normalized;
}

function exactSourceTime(value: string): string {
  const normalized = requiredText(value, "sourceOccurredAt");
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)) {
    throw new Error("Exact outbox sourceOccurredAt requires an explicit UTC offset");
  }
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) throw new Error("Exact outbox sourceOccurredAt is invalid");
  return new Date(epoch).toISOString();
}

function sameInstant(left: Date | string, right: string): boolean {
  const leftEpoch = left instanceof Date ? left.getTime() : Date.parse(String(left));
  return Number.isFinite(leftEpoch) && leftEpoch === Date.parse(right);
}

function equivalentExisting(existing: ExistingExactEvent, input: ExactOutboxWrite, sourceOccurredAt: string): boolean {
  return existing.merchant_id === input.merchantId
    && (existing.store_id ?? null) === input.storeId
    && existing.aggregate_type === input.aggregateType
    && existing.aggregate_id === input.aggregateId
    && existing.event_type === input.eventType
    && Number(existing.event_version) === input.eventVersion
    && sameInstant(existing.source_occurred_at, sourceOccurredAt)
    && existing.retry_policy_key === input.retryPolicyKey
    && existing.payload_matches === true;
}

/**
 * Writes the DB-027 exact envelope inside the caller's existing transaction.
 * This function is intentionally separate from emitOutbox until every legacy
 * call site has a persisted source identity/time and can be switched atomically.
 */
export async function emitExactOutbox(client: PoolClient, raw: ExactOutboxWrite): Promise<string> {
  const input: ExactOutboxWrite = {
    merchantId: requiredText(raw.merchantId, "merchantId"),
    storeId: raw.storeId === null ? null : requiredText(raw.storeId, "storeId"),
    aggregateType: requiredText(raw.aggregateType, "aggregateType"),
    aggregateId: requiredText(raw.aggregateId, "aggregateId"),
    eventType: requiredText(raw.eventType, "eventType"),
    eventVersion: raw.eventVersion,
    sourceEventId: requiredText(raw.sourceEventId, "sourceEventId"),
    sourceOccurredAt: exactSourceTime(raw.sourceOccurredAt),
    retryPolicyKey: requiredText(raw.retryPolicyKey, "retryPolicyKey"),
    payload: raw.payload,
  };
  if (!Number.isInteger(input.eventVersion) || input.eventVersion < 1) {
    throw new Error("Exact outbox eventVersion must be a positive integer");
  }
  const eventContract = resolveExactOutboxEventContract(input.eventType, input.eventVersion);
  if (!eventContract) {
    throw new Error(`Exact outbox event contract is unsupported: ${input.eventType}@${input.eventVersion}`);
  }
  if (eventContract.retryPolicyKey !== input.retryPolicyKey) {
    throw new Error(
      `Exact outbox retry policy mismatch for ${input.eventType}@${input.eventVersion}`,
    );
  }
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("Exact outbox payload must be an object");
  }
  const payload = JSON.stringify(input.payload);

  const sourceLock = [
    "exact-outbox",
    input.merchantId,
    input.storeId || "",
    input.sourceEventId,
  ].join("\u001f");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [sourceLock],
  );

  const existing = await client.query<ExistingExactEvent>(`
    SELECT
      id::text AS id,
      merchant_id,
      store_id,
      aggregate_type,
      aggregate_id,
      event_type,
      event_version,
      source_occurred_at,
      retry_policy_key,
      payload = $4::jsonb AS payload_matches
    FROM outbox.events
    WHERE causality_quality = 'exact'
      AND merchant_id = $1
      AND store_id IS NOT DISTINCT FROM $2::text
      AND source_event_id = $3
  `, [input.merchantId, input.storeId, input.sourceEventId, payload]);
  if (existing.rows[0]) {
    if (!equivalentExisting(existing.rows[0], input, input.sourceOccurredAt)) {
      throw new ExactOutboxConflictError(input.sourceEventId);
    }
    return String(existing.rows[0].id);
  }

  const allocated = await client.query<{ aggregate_sequence: string | number }>(`
    SELECT outbox.allocate_aggregate_sequence($1, $2, $3, $4)::text AS aggregate_sequence
  `, [input.merchantId, input.storeId, input.aggregateType, input.aggregateId]);
  const aggregateSequence = BigInt(String(allocated.rows[0]?.aggregate_sequence || "0"));
  if (aggregateSequence < 1n) throw new Error("Exact outbox aggregate sequence allocation failed");

  let predecessorEventId: string | null = null;
  if (aggregateSequence > 1n) {
    // allocate_aggregate_sequence serializes writers on the aggregate row and
    // retains that row lock until commit. The predecessor's causal identity is
    // immutable, so a plain read is sufficient here. A row-locking SELECT
    // would require direct UPDATE on outbox.events and would collapse the
    // reviewed writer/worker privilege boundary.
    const predecessor = await client.query<{ id: string }>(`
      SELECT id::text AS id
      FROM outbox.events
      WHERE causality_quality = 'exact'
        AND merchant_id = $1
        AND store_id IS NOT DISTINCT FROM $2::text
        AND aggregate_type = $3
        AND aggregate_id = $4
        AND aggregate_sequence = $5::bigint
    `, [
      input.merchantId,
      input.storeId,
      input.aggregateType,
      input.aggregateId,
      (aggregateSequence - 1n).toString(),
    ]);
    predecessorEventId = predecessor.rows[0]?.id ? String(predecessor.rows[0].id) : null;
    if (!predecessorEventId) {
      throw new Error(`Exact outbox predecessor is missing for sequence ${aggregateSequence.toString()}`);
    }
  }

  const result = await client.query<{ id: string }>(`
    INSERT INTO outbox.events (
      aggregate_type,
      aggregate_id,
      event_type,
      event_version,
      payload,
      merchant_id,
      store_id,
      aggregate_sequence,
      causality_quality,
      occurred_at,
      source_occurred_at,
      source_event_id,
      predecessor_event_id,
      retry_policy_key,
      status,
      attempts
    )
    VALUES (
      $1, $2, $3, $4, $5::jsonb, $6, $7, $8::bigint, 'exact',
      $9::timestamptz, $9::timestamptz, $10, $11::uuid, $12, 'pending', 0
    )
    RETURNING id::text AS id
  `, [
    input.aggregateType,
    input.aggregateId,
    input.eventType,
    input.eventVersion,
    payload,
    input.merchantId,
    input.storeId,
    aggregateSequence.toString(),
    input.sourceOccurredAt,
    input.sourceEventId,
    predecessorEventId,
    input.retryPolicyKey,
  ]);
  const eventId = result.rows[0]?.id ? String(result.rows[0].id) : "";
  if (!eventId) throw new Error("Exact outbox insert did not return an event id");
  return eventId;
}

export async function emitOutbox(
  client: PoolClient,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const merchantId = typeof payload.merchantId === "string" && payload.merchantId ? payload.merchantId : null;
  const storeId = typeof payload.storeId === "string" && payload.storeId ? payload.storeId : null;
  const result = await client.query(`
    INSERT INTO outbox.events (aggregate_type, aggregate_id, event_type, event_version, payload, merchant_id, store_id)
    VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6)
    RETURNING id
  `, [aggregateType, aggregateId, eventType, JSON.stringify(payload), merchantId, storeId]);
  return String(result.rows[0]?.id || "");
}
