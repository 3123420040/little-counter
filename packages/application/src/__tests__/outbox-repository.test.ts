import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "../db/client";
import {
  ExactOutboxConflictError,
  emitExactOutbox,
  type ExactOutboxWrite,
} from "../repositories/outbox-repository";

const input: ExactOutboxWrite = {
  merchantId: "merchant_a",
  storeId: "store_a",
  aggregateType: "order",
  aggregateId: "order_1",
  eventType: "order.corrected",
  eventVersion: 1,
  sourceEventId: "commercial_revision:revision_2",
  sourceOccurredAt: "2026-08-04T16:00:00.000Z",
  retryPolicyKey: "financial-v1",
  payload: { revisionId: "revision_2", chargedTotalMinor: "125000" },
};

function clientWith(query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) {
  return { query: vi.fn(query) } as unknown as PoolClient;
}

describe("exact outbox repository", () => {
  it("locks the source identity, allocates sequence one and inserts an exact event", async () => {
    const client = clientWith(async (sql) => {
      const normalized = sql.toLowerCase();
      if (normalized.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (normalized.includes("source_event_id") && normalized.includes("payload_matches")) return { rows: [] };
      if (normalized.includes("allocate_aggregate_sequence")) return { rows: [{ aggregate_sequence: "1" }] };
      if (normalized.includes("insert into outbox.events")) return { rows: [{ id: "event_1" }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(emitExactOutbox(client, input)).resolves.toBe("event_1");

    const statements = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(([sql]) => String(sql).toLowerCase());
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(statements.every((sql) => !sql.includes("for share"))).toBe(true);
    expect(statements.some((sql) => sql.includes("allocate_aggregate_sequence"))).toBe(true);
    const insert = statements.find((sql) => sql.includes("insert into outbox.events")) || "";
    for (const column of [
      "aggregate_sequence",
      "causality_quality",
      "source_occurred_at",
      "source_event_id",
      "predecessor_event_id",
      "retry_policy_key",
    ]) {
      expect(insert).toContain(column);
    }
  });

  it("binds sequence N to the exact N-1 predecessor", async () => {
    const client = clientWith(async (sql) => {
      const normalized = sql.toLowerCase();
      if (normalized.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (normalized.includes("source_event_id") && normalized.includes("payload_matches")) return { rows: [] };
      if (normalized.includes("allocate_aggregate_sequence")) return { rows: [{ aggregate_sequence: "2" }] };
      if (normalized.includes("aggregate_sequence = $5")) return { rows: [{ id: "event_1" }] };
      if (normalized.includes("insert into outbox.events")) return { rows: [{ id: "event_2" }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(emitExactOutbox(client, input)).resolves.toBe("event_2");

    const statements = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(([sql]) => String(sql).toLowerCase());
    expect(statements.every((sql) => !sql.includes("for share"))).toBe(true);
    const insertCall = (client.query as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes("insert into outbox.events"),
    );
    expect(insertCall?.[1]).toContain("event_1");
  });

  it("returns an equivalent existing source event without allocating another sequence", async () => {
    const client = clientWith(async (sql) => {
      const normalized = sql.toLowerCase();
      if (normalized.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (normalized.includes("payload_matches")) {
        return {
          rows: [{
            id: "event_existing",
            merchant_id: input.merchantId,
            store_id: input.storeId,
            aggregate_type: input.aggregateType,
            aggregate_id: input.aggregateId,
            event_type: input.eventType,
            event_version: input.eventVersion,
            source_occurred_at: input.sourceOccurredAt,
            retry_policy_key: input.retryPolicyKey,
            payload_matches: true,
          }],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(emitExactOutbox(client, input)).resolves.toBe("event_existing");
    const statements = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(([sql]) => String(sql).toLowerCase());
    expect(statements.some((sql) => sql.includes("allocate_aggregate_sequence"))).toBe(false);
    expect(statements.some((sql) => sql.includes("insert into outbox.events"))).toBe(false);
  });

  it("fails closed when a source identity is reused for different facts", async () => {
    const client = clientWith(async (sql) => {
      const normalized = sql.toLowerCase();
      if (normalized.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (normalized.includes("payload_matches")) {
        return {
          rows: [{
            id: "event_existing",
            merchant_id: input.merchantId,
            store_id: input.storeId,
            aggregate_type: input.aggregateType,
            aggregate_id: input.aggregateId,
            event_type: input.eventType,
            event_version: input.eventVersion,
            source_occurred_at: input.sourceOccurredAt,
            retry_policy_key: input.retryPolicyKey,
            payload_matches: false,
          }],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(emitExactOutbox(client, input)).rejects.toBeInstanceOf(ExactOutboxConflictError);
  });

  it("rejects a source time without an explicit offset before querying", async () => {
    const client = clientWith(async () => ({ rows: [] }));

    await expect(emitExactOutbox(client, {
      ...input,
      sourceOccurredAt: "2026-08-04T16:00:00",
    })).rejects.toThrow("explicit UTC offset");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("rejects an event/retry-policy contract mismatch before querying", async () => {
    const client = clientWith(async () => ({ rows: [] }));

    await expect(emitExactOutbox(client, {
      ...input,
      retryPolicyKey: "inventory-v1",
    })).rejects.toThrow("retry policy");
    expect(client.query).not.toHaveBeenCalled();
  });
});
