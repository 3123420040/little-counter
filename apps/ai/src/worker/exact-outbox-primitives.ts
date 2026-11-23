import { createHash } from "node:crypto";
import {
  EXACT_OUTBOX_RETRY_POLICIES,
  resolveExactOutboxEventContract,
  type ExactOutboxRetryPolicyKey,
} from "@medusa-snus/contracts/outbox-runtime";
import type { Pool } from "pg";

export type ExactClaimedOutboxEvent = {
  id: string;
  claimToken: string;
  claimVersion: string;
  attempts: number;
  merchantId: string;
  storeId: string | null;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: string;
  predecessorEventId: string | null;
  eventType: string;
  eventVersion: number;
  sourceEventId: string;
  sourceOccurredAt: string;
  retryPolicyKey: string;
  payload: Record<string, unknown>;
};

export type ExactOutboxFailure = {
  errorClass: string;
  errorCode: string;
  retryable: boolean;
  handlerVersion: string;
  unsafeMessage?: string;
};

export type ExactOutboxFailureDecision = {
  deadLetter: boolean;
  delaySeconds: number | null;
  deadLetterReasonCode: string | null;
  errorEvidence: string;
  failureFingerprint: string;
};

type ClaimedRow = {
  event_id: string;
  claim_token: string;
  claim_version: string | number;
  attempts: string | number;
  merchant_id: string;
  store_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_sequence: string | number;
  predecessor_event_id: string | null;
  event_type: string;
  event_version: string | number;
  source_event_id: string;
  source_occurred_at: Date | string;
  retry_policy_key: string;
  payload: Record<string, unknown>;
};

type ClaimIdentityRow = {
  event_id: string;
  claim_token: string;
  claim_version: string | number;
};

export class StaleExactOutboxClaimError extends Error {
  readonly code = "stale_exact_outbox_claim";

  constructor(eventId: string) {
    super(`Exact outbox claim is stale: ${eventId}`);
    this.name = "StaleExactOutboxClaimError";
  }
}

export class ExactOutboxClaimReadMismatchError extends Error {
  readonly code = "exact_outbox_claim_read_mismatch";

  constructor() {
    super("Exact outbox claimed identities did not resolve to exact envelopes");
    this.name = "ExactOutboxClaimReadMismatchError";
  }
}

function requiredText(value: string, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Exact outbox ${field} is required`);
  return normalized;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Exact outbox ${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function iso(value: Date | string): string {
  const epoch = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(epoch)) throw new Error("Exact outbox source occurrence time is invalid");
  return new Date(epoch).toISOString();
}

function mapClaimedRow(row: ClaimedRow): ExactClaimedOutboxEvent {
  const attempts = Number(row.attempts);
  const eventVersion = Number(row.event_version);
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("Exact outbox claim attempts are invalid");
  if (!Number.isInteger(eventVersion) || eventVersion < 1) throw new Error("Exact outbox event version is invalid");
  return {
    id: String(row.event_id),
    claimToken: String(row.claim_token),
    claimVersion: String(row.claim_version),
    attempts,
    merchantId: String(row.merchant_id),
    storeId: row.store_id === null ? null : String(row.store_id),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    aggregateSequence: String(row.aggregate_sequence),
    predecessorEventId: row.predecessor_event_id === null ? null : String(row.predecessor_event_id),
    eventType: String(row.event_type),
    eventVersion,
    sourceEventId: String(row.source_event_id),
    sourceOccurredAt: iso(row.source_occurred_at),
    retryPolicyKey: String(row.retry_policy_key),
    payload: row.payload || {},
  };
}

export async function claimExactOutboxEvents(
  db: Pool,
  workerId: string,
  limit = 25,
  leaseSeconds = 60,
): Promise<ExactClaimedOutboxEvent[]> {
  const worker = requiredText(workerId, "workerId");
  const safeLimit = boundedInteger(limit, "claim limit", 1, 200);
  const safeLease = boundedInteger(leaseSeconds, "lease seconds", 5, 300);
  const client = await db.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const claimed = await client.query<ClaimIdentityRow>(`
      SELECT
        event_id::text,
        claim_token::text,
        claim_version::text
      FROM outbox.claim_exact_events($1, $2, $3)
    `, [worker, safeLimit, safeLease]);

    if (claimed.rows.length === 0) {
      await client.query("COMMIT");
      transactionOpen = false;
      return [];
    }

    const eventIds = claimed.rows.map((row) => String(row.event_id));
    const claimTokens = claimed.rows.map((row) => String(row.claim_token));
    const claimVersions = claimed.rows.map((row) => String(row.claim_version));
    const result = await client.query<ClaimedRow>(`
      WITH claimed(event_id, claim_token, claim_version) AS (
        SELECT *
        FROM unnest($2::uuid[], $3::uuid[], $4::bigint[])
      )
      SELECT
        claimed.event_id::text,
        claimed.claim_token::text,
        claimed.claim_version::text,
        event.attempts,
        event.merchant_id,
        event.store_id,
        event.aggregate_type,
        event.aggregate_id,
        event.aggregate_sequence::text,
        event.predecessor_event_id::text,
        event.event_type,
        event.event_version,
        event.source_event_id,
        event.source_occurred_at,
        event.retry_policy_key,
        event.payload
      FROM claimed
      JOIN outbox.events event
        ON event.id = claimed.event_id
       AND event.causality_quality = 'exact'
       AND event.status = 'processing'
       AND event.claimed_by = $1
       AND event.claim_token = claimed.claim_token
       AND event.claim_version = claimed.claim_version
      ORDER BY event.created_at, event.id
    `, [worker, eventIds, claimTokens, claimVersions]);

    const claimedIdentity = new Set(claimed.rows.map((row) => [
      String(row.event_id),
      String(row.claim_token),
      String(row.claim_version),
    ].join("\u001f")));
    const resolvedIdentity = new Set(result.rows.map((row) => [
      String(row.event_id),
      String(row.claim_token),
      String(row.claim_version),
    ].join("\u001f")));
    if (
      result.rows.length !== claimed.rows.length
      || resolvedIdentity.size !== claimedIdentity.size
      || [...claimedIdentity].some((identity) => !resolvedIdentity.has(identity))
    ) {
      throw new ExactOutboxClaimReadMismatchError();
    }

    const events = result.rows.map(mapClaimedRow);
    await client.query("COMMIT");
    transactionOpen = false;
    return events;
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

export function classifyExactOutboxEvent(event: ExactClaimedOutboxEvent):
  | { process: true }
  | { process: false; reasonCode: string } {
  const contract = resolveExactOutboxEventContract(event.eventType, event.eventVersion);
  if (!contract) return { process: false, reasonCode: "unsupported_event_contract" };
  if (contract.retryPolicyKey !== event.retryPolicyKey) {
    return { process: false, reasonCode: "retry_policy_mismatch" };
  }
  if (contract.handling === "unsupported") {
    return { process: false, reasonCode: "unsupported_event_type" };
  }
  if (contract.handling === "intentional_noop") {
    return { process: false, reasonCode: "intentional_noop" };
  }
  return { process: true };
}

function stableToken(value: string, fallback: string): string {
  const normalized = String(value || "").trim().slice(0, 80);
  return /^[A-Za-z0-9._-]+$/.test(normalized) ? normalized : fallback;
}

function fingerprint(event: ExactClaimedOutboxEvent, failure: ExactOutboxFailure): string {
  const input = [
    event.eventType,
    String(event.eventVersion),
    event.sourceEventId,
    stableToken(failure.errorClass, "UnknownError"),
    stableToken(failure.errorCode, "unknown_error"),
    stableToken(failure.handlerVersion, "unknown-handler"),
  ].join("\u001f");
  return createHash("sha256").update(input).digest("hex");
}

function unknownPolicyDecision(
  event: ExactClaimedOutboxEvent,
  failure: ExactOutboxFailure,
): ExactOutboxFailureDecision {
  const errorClass = stableToken(failure.errorClass, "UnknownError");
  const errorCode = stableToken(failure.errorCode, "unknown_error");
  return {
    deadLetter: true,
    delaySeconds: null,
    deadLetterReasonCode: "unknown_retry_policy",
    errorEvidence: `${errorClass}:${errorCode}`,
    failureFingerprint: fingerprint(event, failure),
  };
}

export function decideExactOutboxFailure(
  event: ExactClaimedOutboxEvent,
  failure: ExactOutboxFailure,
): ExactOutboxFailureDecision {
  const errorClass = stableToken(failure.errorClass, "UnknownError");
  const errorCode = stableToken(failure.errorCode, "unknown_error");
  const policy = EXACT_OUTBOX_RETRY_POLICIES[event.retryPolicyKey as ExactOutboxRetryPolicyKey];
  if (!policy) return unknownPolicyDecision(event, failure);

  const failureFingerprint = fingerprint(event, failure);
  const errorEvidence = `${errorClass}:${errorCode}`;
  if (!failure.retryable) {
    return {
      deadLetter: true,
      delaySeconds: null,
      deadLetterReasonCode: "permanent_failure",
      errorEvidence,
      failureFingerprint,
    };
  }
  if (event.attempts >= policy.maxAttempts) {
    return {
      deadLetter: true,
      delaySeconds: null,
      deadLetterReasonCode: "retry_attempts_exhausted",
      errorEvidence,
      failureFingerprint,
    };
  }

  const exponential = Math.min(
    policy.maxDelaySeconds,
    policy.baseDelaySeconds * (2 ** Math.max(0, event.attempts - 1)),
  );
  const jitterWindow = Math.max(1, Math.floor(exponential * 0.2));
  const jitterSeed = Number.parseInt(failureFingerprint.slice(0, 8), 16);
  const delaySeconds = Math.min(policy.maxDelaySeconds, exponential + (jitterSeed % (jitterWindow + 1)));
  return {
    deadLetter: false,
    delaySeconds,
    deadLetterReasonCode: null,
    errorEvidence,
    failureFingerprint,
  };
}

export async function completeExactOutboxClaim(
  db: Pool,
  workerId: string,
  event: ExactClaimedOutboxEvent,
): Promise<void> {
  const result = await db.query<{ completed: boolean }>(`
    SELECT outbox.complete_exact_event_claim($1::uuid, $2, $3::uuid, $4::bigint) AS completed
  `, [event.id, requiredText(workerId, "workerId"), event.claimToken, event.claimVersion]);
  if (result.rows[0]?.completed !== true) throw new StaleExactOutboxClaimError(event.id);
}

export async function failExactOutboxClaim(
  db: Pool,
  workerId: string,
  event: ExactClaimedOutboxEvent,
  failure: ExactOutboxFailure,
): Promise<ExactOutboxFailureDecision> {
  const decision = decideExactOutboxFailure(event, failure);
  const result = await db.query<{ failed: boolean }>(`
    SELECT outbox.fail_exact_event_claim(
      $1::uuid,
      $2,
      $3::uuid,
      $4::bigint,
      $5,
      $6,
      CASE
        WHEN $7::int IS NULL THEN NULL
        ELSE clock_timestamp() + make_interval(secs => $7::int)
      END,
      $8,
      $9
    ) AS failed
  `, [
    event.id,
    requiredText(workerId, "workerId"),
    event.claimToken,
    event.claimVersion,
    decision.errorEvidence,
    decision.failureFingerprint,
    decision.delaySeconds,
    decision.deadLetter,
    decision.deadLetterReasonCode,
  ]);
  if (result.rows[0]?.failed !== true) throw new StaleExactOutboxClaimError(event.id);
  return decision;
}
