import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "../db/client";
import {
  PostgresOrderCollectionRevisionRepositoryV1,
  type OrderCollectionMutationInputV1,
} from "../services/postgres-order-collection-revision-repository";

const input: OrderCollectionMutationInputV1 = {
  merchantId: "merchant-a",
  storeId: "store-a",
  mutationId: "order:order-a:commercial-revision:2",
  sourceRelation: "app.order_commercial_revisions",
  sourceAction: "insert",
};

type StateMode = "new" | "replay" | "missing_store" | "missing_event" | "drift";

class FakeClient {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];
  stateMode: StateMode = "new";
  stateReads = 0;
  mutationRan = false;
  failRollback = false;

  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql === "ROLLBACK" && this.failRollback) throw new Error("rollback transport failed");
    if (sql.includes("fake_order_mutation")) {
      this.mutationRan = true;
      return { rows: [] as T[] };
    }
    if (sql.includes("order_collection_revision_state")) {
      this.stateReads += 1;
      if (this.stateMode === "missing_store") return { rows: [] as T[] };
      const afterMutation = this.mutationRan || this.stateMode === "replay";
      const hasEvent = afterMutation && this.stateMode !== "missing_event";
      return {
        rows: [{
          owned_store_id: input.storeId,
          current_revision: this.stateMode === "replay" ? "9" : afterMutation ? "1" : "0",
          mutation_revision: hasEvent ? (this.stateMode === "replay" ? "7" : "1") : null,
          event_mutation_id: hasEvent ? input.mutationId : null,
          source_relation: hasEvent
            ? this.stateMode === "drift"
              ? "public.order"
              : input.sourceRelation
            : null,
          source_action: hasEvent ? input.sourceAction : null,
        }] as T[],
      };
    }
    return { rows: [] as T[] };
  }
}

function repository(fake: FakeClient) {
  return new PostgresOrderCollectionRevisionRepositoryV1(
    fake as unknown as PoolClient,
    { statementTimeoutMs: 5_000, lockTimeoutMs: 1_000 },
  );
}

async function runMutation(fake: FakeClient, value = input) {
  return repository(fake).runCollectionMutation(value, async (client) => {
    await client.query("/* fake_order_mutation */ SELECT 1");
    return { orderId: "order-a" };
  });
}

describe("REV-01A fake-boundary order collection revision repository", () => {
  it("sets one mutation identity and verifies one scoped monotonic bump", async () => {
    const fake = new FakeClient();
    await expect(runMutation(fake)).resolves.toEqual({
      outcome: "inserted",
      merchantId: input.merchantId,
      storeId: input.storeId,
      mutationId: input.mutationId,
      mutationRevision: 1,
      currentRevision: 1,
      sourceRelation: input.sourceRelation,
      sourceAction: input.sourceAction,
      result: { orderId: "order-a" },
    });
    expect(fake.calls.map((call) => call.sql.trim().split("\n")[0])).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT set_config('lock_timeout', $1, true)",
      "/* order_collection_revision_lock */",
      "/* order_collection_revision_lock */",
      "/* order_collection_revision_state */",
      "SELECT set_config('app.collection_mutation_id', $1, true)",
      "/* fake_order_mutation */ SELECT 1",
      "/* order_collection_revision_state */",
      "COMMIT",
    ]);
    expect(fake.calls.slice(3, 5).map((call) => call.params?.[0])).toEqual(
      [...fake.calls.slice(3, 5).map((call) => call.params?.[0])].sort(),
    );
    expect(fake.calls[5]!.sql).toContain("FOR UPDATE OF stores");
    expect(fake.calls[5]!.sql).toContain("FOR UPDATE OF revisions");
  });

  it("returns exact replay without invoking the business mutation", async () => {
    const fake = new FakeClient();
    fake.stateMode = "replay";
    const mutation = vi.fn(async () => ({ orderId: "should-not-run" }));
    await expect(repository(fake).runCollectionMutation(input, mutation)).resolves.toMatchObject({
      outcome: "replayed",
      mutationRevision: 7,
      currentRevision: 9,
      result: undefined,
    });
    expect(mutation).not.toHaveBeenCalled();
    expect(fake.calls.some((call) =>
      call.sql.includes("set_config('app.collection_mutation_id'"),
    )).toBe(false);
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("rejects an event whose source identity differs from the requested mutation", async () => {
    const fake = new FakeClient();
    fake.stateMode = "drift";
    await expect(runMutation(fake)).rejects.toThrow(/source identity drift/i);
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects a successful callback that did not produce the required bump event", async () => {
    const fake = new FakeClient();
    fake.stateMode = "missing_event";
    await expect(runMutation(fake)).rejects.toThrow(/did not produce/i);
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("fails closed when the store is not owned by the merchant", async () => {
    const fake = new FakeClient();
    fake.stateMode = "missing_store";
    const mutation = vi.fn(async () => ({ orderId: "should-not-run" }));
    await expect(repository(fake).runCollectionMutation(input, mutation)).rejects.toThrow(
      /store scope/i,
    );
    expect(mutation).not.toHaveBeenCalled();
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rolls back callback failures without masking the original error", async () => {
    const fake = new FakeClient();
    fake.failRollback = true;
    await expect(repository(fake).runCollectionMutation(input, async () => {
      throw new Error("business mutation failed");
    })).rejects.toThrow("business mutation failed");
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("fails before BEGIN for invalid scope/source/mutation inputs", async () => {
    for (const value of [
      { ...input, merchantId: " merchant-a" },
      { ...input, storeId: "" },
      { ...input, mutationId: "" },
      { ...input, sourceRelation: "" },
      { ...input, sourceAction: "replace" as "insert" },
    ]) {
      const fake = new FakeClient();
      await expect(runMutation(fake, value)).rejects.toThrow(/invalid/i);
      expect(fake.calls).toEqual([]);
    }
  });

  it("rejects unsafe transaction timeout configuration before any query", () => {
    const fake = new FakeClient();
    expect(() => new PostgresOrderCollectionRevisionRepositoryV1(
      fake as unknown as PoolClient,
      { statementTimeoutMs: 1_000, lockTimeoutMs: 1_001 },
    )).toThrow();
    expect(fake.calls).toEqual([]);
  });
});
