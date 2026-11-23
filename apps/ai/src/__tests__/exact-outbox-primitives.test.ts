import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  ExactOutboxClaimReadMismatchError,
  StaleExactOutboxClaimError,
  claimExactOutboxEvents,
  classifyExactOutboxEvent,
  completeExactOutboxClaim,
  decideExactOutboxFailure,
  failExactOutboxClaim,
  type ExactClaimedOutboxEvent,
} from "../worker/exact-outbox-primitives";

const claimedEvent: ExactClaimedOutboxEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  claimToken: "22222222-2222-4222-8222-222222222222",
  claimVersion: "3",
  attempts: 1,
  merchantId: "merchant_a",
  storeId: "store_a",
  aggregateType: "order",
  aggregateId: "order_1",
  aggregateSequence: "2",
  predecessorEventId: "33333333-3333-4333-8333-333333333333",
  eventType: "order.corrected",
  eventVersion: 1,
  sourceEventId: "commercial_revision:revision_2",
  sourceOccurredAt: "2026-08-04T16:00:00.000Z",
  retryPolicyKey: "financial-v1",
  payload: { correctionId: "revision_2" },
};

function poolWith(query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) {
  return { query: vi.fn(query) } as unknown as Pool;
}

function claimPoolWith(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
): Pool {
  const client = {
    query: vi.fn(query),
    release: vi.fn(),
  };
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

describe("exact outbox worker primitives", () => {
  it("claims only through the DB-027 fenced function and returns the exact envelope", async () => {
    const statements: string[] = [];
    const db = claimPoolWith(async (sql, params) => {
      statements.push(sql.trim().toLowerCase());
      if (sql.trim() === "BEGIN" || sql.trim() === "COMMIT") return { rows: [] };
      if (sql.toLowerCase().includes("outbox.claim_exact_events")) {
        expect(params).toEqual(["worker_a", 25, 60]);
        return { rows: [{
          event_id: claimedEvent.id,
          claim_token: claimedEvent.claimToken,
          claim_version: "3",
        }] };
      }
      expect(sql.toLowerCase()).toContain("causality_quality = 'exact'");
      expect(sql.toLowerCase()).toContain("unnest($2::uuid[], $3::uuid[], $4::bigint[])");
      expect(params).toEqual([
        "worker_a",
        [claimedEvent.id],
        [claimedEvent.claimToken],
        [claimedEvent.claimVersion],
      ]);
      return { rows: [{
          event_id: claimedEvent.id,
          claim_token: claimedEvent.claimToken,
          claim_version: "3",
          attempts: 1,
          merchant_id: claimedEvent.merchantId,
          store_id: claimedEvent.storeId,
          aggregate_type: claimedEvent.aggregateType,
          aggregate_id: claimedEvent.aggregateId,
          aggregate_sequence: "2",
          predecessor_event_id: claimedEvent.predecessorEventId,
          event_type: claimedEvent.eventType,
          event_version: 1,
          source_event_id: claimedEvent.sourceEventId,
          source_occurred_at: claimedEvent.sourceOccurredAt,
          retry_policy_key: claimedEvent.retryPolicyKey,
          payload: claimedEvent.payload,
        }] };
    });

    await expect(claimExactOutboxEvents(db, "worker_a", 25, 60)).resolves.toEqual([claimedEvent]);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toBe("begin");
    expect(statements[1]).toContain("outbox.claim_exact_events");
    expect(statements[2]).toContain("join outbox.events");
    expect(statements[3]).toBe("commit");
  });

  it("rolls back and fails closed when a claimed identity has no exact envelope", async () => {
    const statements: string[] = [];
    const db = claimPoolWith(async (sql) => {
      statements.push(sql.trim().toLowerCase());
      if (sql.trim() === "BEGIN" || sql.trim() === "ROLLBACK") return { rows: [] };
      if (sql.toLowerCase().includes("outbox.claim_exact_events")) {
        return { rows: [{
          event_id: claimedEvent.id,
          claim_token: claimedEvent.claimToken,
          claim_version: claimedEvent.claimVersion,
        }] };
      }
      return { rows: [] };
    });

    await expect(claimExactOutboxEvents(db, "worker_a", 25, 60)).rejects.toBeInstanceOf(
      ExactOutboxClaimReadMismatchError,
    );
    expect(statements.at(-1)).toBe("rollback");
    expect(statements).not.toContain("commit");
  });

  it("classifies unknown versions, intentional no-ops and retry-policy mismatches before processing", () => {
    expect(classifyExactOutboxEvent(claimedEvent)).toEqual({ process: true });
    expect(classifyExactOutboxEvent({ ...claimedEvent, eventVersion: 2 })).toEqual({
      process: false,
      reasonCode: "unsupported_event_contract",
    });
    expect(classifyExactOutboxEvent({ ...claimedEvent, retryPolicyKey: "inventory-v1" })).toEqual({
      process: false,
      reasonCode: "retry_policy_mismatch",
    });
    expect(classifyExactOutboxEvent({ ...claimedEvent, eventType: "customer.created", retryPolicyKey: "workflow-v1" })).toEqual({
      process: false,
      reasonCode: "intentional_noop",
    });
  });

  it("computes bounded retry and redacted deterministic failure evidence", () => {
    const retry = decideExactOutboxFailure(claimedEvent, {
      errorClass: "ProviderTimeout",
      errorCode: "provider_timeout",
      retryable: true,
      unsafeMessage: "secret card and token data",
      handlerVersion: "order-corrected-v1",
    });
    expect(retry.deadLetter).toBe(false);
    expect(retry.delaySeconds).toBeGreaterThanOrEqual(30);
    expect(retry.delaySeconds).toBeLessThanOrEqual(36);
    expect(retry.failureFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(retry.errorEvidence).toBe("ProviderTimeout:provider_timeout");
    expect(JSON.stringify(retry)).not.toContain("secret card");

    const maxed = decideExactOutboxFailure({ ...claimedEvent, attempts: 5 }, {
      errorClass: "ProviderTimeout",
      errorCode: "provider_timeout",
      retryable: true,
      handlerVersion: "order-corrected-v1",
    });
    expect(maxed).toMatchObject({
      deadLetter: true,
      delaySeconds: null,
      deadLetterReasonCode: "retry_attempts_exhausted",
    });

    const unknownPolicy = decideExactOutboxFailure({ ...claimedEvent, retryPolicyKey: "unknown-v1" }, {
      errorClass: "UnknownError",
      errorCode: "unknown_policy",
      retryable: true,
      handlerVersion: "order-corrected-v1",
    });
    expect(unknownPolicy).toMatchObject({
      deadLetter: true,
      delaySeconds: null,
      deadLetterReasonCode: "unknown_retry_policy",
    });

    const permanent = decideExactOutboxFailure(claimedEvent, {
      errorClass: "ContractError",
      errorCode: "invalid_payload",
      retryable: false,
      handlerVersion: "order-corrected-v1",
    });
    expect(permanent.deadLetterReasonCode).toBe("permanent_failure");
  });

  it("completes with token/version/worker CAS and rejects a stale claim", async () => {
    const db = poolWith(async (sql, params) => {
      expect(sql.toLowerCase()).toContain("outbox.complete_exact_event_claim");
      expect(params).toEqual([
        claimedEvent.id,
        "worker_a",
        claimedEvent.claimToken,
        claimedEvent.claimVersion,
      ]);
      return { rows: [{ completed: false }] };
    });

    await expect(completeExactOutboxClaim(db, "worker_a", claimedEvent)).rejects.toBeInstanceOf(
      StaleExactOutboxClaimError,
    );
  });

  it("fails with DB-clock retry delay and rejects a stale claim", async () => {
    const db = poolWith(async (sql, params) => {
      const normalized = sql.toLowerCase();
      expect(normalized).toContain("outbox.fail_exact_event_claim");
      expect(normalized).toContain("clock_timestamp() + make_interval");
      expect(params).toContain(claimedEvent.claimToken);
      expect(params).toContain(claimedEvent.claimVersion);
      return { rows: [{ failed: false }] };
    });

    await expect(failExactOutboxClaim(db, "worker_a", claimedEvent, {
      errorClass: "ProviderTimeout",
      errorCode: "provider_timeout",
      retryable: true,
      handlerVersion: "order-corrected-v1",
    })).rejects.toBeInstanceOf(StaleExactOutboxClaimError);
  });
});
