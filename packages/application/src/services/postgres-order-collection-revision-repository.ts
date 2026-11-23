import type { PoolClient } from "../db/client";

export const ORDER_COLLECTION_REVISION_STATEMENT_TIMEOUT_HARD_CAP_MS = 30_000;
export const ORDER_COLLECTION_REVISION_LOCK_TIMEOUT_HARD_CAP_MS = 5_000;

export type OrderCollectionMutationActionV1 = "insert" | "update" | "delete";

export interface OrderCollectionMutationInputV1 {
  merchantId: string;
  storeId: string;
  mutationId: string;
  sourceRelation: string;
  sourceAction: OrderCollectionMutationActionV1;
}

export interface OrderCollectionMutationReceiptV1<T> {
  outcome: "inserted" | "replayed";
  merchantId: string;
  storeId: string;
  mutationId: string;
  mutationRevision: number;
  currentRevision: number;
  sourceRelation: string;
  sourceAction: OrderCollectionMutationActionV1;
  result: T | undefined;
}

export interface PostgresOrderCollectionRevisionOptionsV1 {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}

type StateRow = {
  owned_store_id: unknown;
  current_revision: unknown;
  mutation_revision: unknown;
  event_mutation_id: unknown;
  source_relation: unknown;
  source_action: unknown;
};

type NormalizedInput = Readonly<OrderCollectionMutationInputV1>;

type ParsedState = {
  currentRevision: number;
  event: null | {
    mutationRevision: number;
    mutationId: string;
    sourceRelation: string;
    sourceAction: OrderCollectionMutationActionV1;
  };
};

function requiredToken(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || value.length > 512
  ) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function boundedTimeout(value: number, field: string, cap: number): number {
  if (!Number.isInteger(value) || value < 1 || value > cap) {
    throw new Error(`${field} must be between 1 and ${cap}`);
  }
  return value;
}

function safeNonnegativeInteger(value: unknown, field: string): number {
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "bigint") parsed = Number(value);
  else if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) parsed = Number(value);
  else throw new Error(`${field} is invalid`);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} is invalid`);
  return parsed;
}

function normalizeInput(value: OrderCollectionMutationInputV1): NormalizedInput {
  const sourceAction = value.sourceAction;
  if (sourceAction !== "insert" && sourceAction !== "update" && sourceAction !== "delete") {
    throw new Error("sourceAction is invalid");
  }
  return Object.freeze({
    merchantId: requiredToken(value.merchantId, "merchantId"),
    storeId: requiredToken(value.storeId, "storeId"),
    mutationId: requiredToken(value.mutationId, "mutationId"),
    sourceRelation: requiredToken(value.sourceRelation, "sourceRelation"),
    sourceAction,
  });
}

function parseState(rows: StateRow[], input: NormalizedInput): ParsedState {
  if (rows.length !== 1 || rows[0]!.owned_store_id !== input.storeId) {
    throw new Error("order collection revision store scope is invalid");
  }
  const row = rows[0]!;
  const currentRevision = safeNonnegativeInteger(row.current_revision, "currentRevision");
  const eventValues = [
    row.mutation_revision,
    row.event_mutation_id,
    row.source_relation,
    row.source_action,
  ];
  if (eventValues.every((value) => value === null)) {
    return { currentRevision, event: null };
  }
  if (eventValues.some((value) => value === null)) {
    throw new Error("order collection revision event coverage drift");
  }
  const mutationRevision = safeNonnegativeInteger(
    row.mutation_revision,
    "mutationRevision",
  );
  const mutationId = requiredToken(row.event_mutation_id, "eventMutationId");
  const sourceRelation = requiredToken(row.source_relation, "eventSourceRelation");
  const sourceAction = row.source_action;
  if (sourceAction !== "insert" && sourceAction !== "update" && sourceAction !== "delete") {
    throw new Error("order collection revision source identity drift");
  }
  if (
    mutationRevision < 1
    || currentRevision < mutationRevision
    || mutationId !== input.mutationId
    || sourceRelation !== input.sourceRelation
    || sourceAction !== input.sourceAction
  ) {
    throw new Error("order collection revision source identity drift");
  }
  return {
    currentRevision,
    event: {
      mutationRevision,
      mutationId,
      sourceRelation,
      sourceAction,
    },
  };
}

function receipt<T>(
  outcome: "inserted" | "replayed",
  input: NormalizedInput,
  state: ParsedState & { event: NonNullable<ParsedState["event"]> },
  result: T | undefined,
): OrderCollectionMutationReceiptV1<T> {
  return {
    outcome,
    merchantId: input.merchantId,
    storeId: input.storeId,
    mutationId: input.mutationId,
    mutationRevision: state.event.mutationRevision,
    currentRevision: state.currentRevision,
    sourceRelation: input.sourceRelation,
    sourceAction: input.sourceAction,
    result,
  };
}

export class PostgresOrderCollectionRevisionRepositoryV1 {
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly client: PoolClient,
    options: PostgresOrderCollectionRevisionOptionsV1,
  ) {
    this.statementTimeoutMs = boundedTimeout(
      options.statementTimeoutMs,
      "order collection revision statement timeout",
      ORDER_COLLECTION_REVISION_STATEMENT_TIMEOUT_HARD_CAP_MS,
    );
    this.lockTimeoutMs = boundedTimeout(
      options.lockTimeoutMs,
      "order collection revision lock timeout",
      ORDER_COLLECTION_REVISION_LOCK_TIMEOUT_HARD_CAP_MS,
    );
    if (this.lockTimeoutMs > this.statementTimeoutMs) {
      throw new Error("order collection revision lock timeout cannot exceed statement timeout");
    }
  }

  async runCollectionMutation<T>(
    value: OrderCollectionMutationInputV1,
    mutate: (client: PoolClient) => Promise<T>,
  ): Promise<OrderCollectionMutationReceiptV1<T>> {
    const input = normalizeInput(value);
    if (typeof mutate !== "function") throw new Error("collection mutation callback is invalid");
    const lockKeys = [
      `collection-revision-mutation:${input.merchantId}:${input.storeId}:${input.mutationId}`,
      `collection-revision-scope:${input.merchantId}:${input.storeId}`,
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
      for (const lockKey of lockKeys) {
        await this.client.query(`
          /* order_collection_revision_lock */
          SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
        `, [lockKey]);
      }

      const readState = async (): Promise<ParsedState> => {
        const state = await this.client.query<StateRow>(`
          /* order_collection_revision_state */
          WITH owned_store AS MATERIALIZED (
            SELECT stores.merchant_id, stores.id
            FROM app.stores stores
            WHERE stores.merchant_id = $1
              AND stores.id = $2
            FOR UPDATE OF stores
          ), locked_revision AS MATERIALIZED (
            SELECT revisions.revision
            FROM app.order_collection_revisions revisions
            JOIN owned_store stores
              ON stores.merchant_id = revisions.merchant_id
             AND stores.id = revisions.store_id
            FOR UPDATE OF revisions
          )
          SELECT
            stores.id AS owned_store_id,
            COALESCE(revisions.revision, 0)::text AS current_revision,
            events.revision::text AS mutation_revision,
            events.mutation_id AS event_mutation_id,
            events.source_relation,
            events.source_action
          FROM owned_store stores
          LEFT JOIN locked_revision revisions ON true
          LEFT JOIN app.order_collection_revision_events events
            ON events.merchant_id = stores.merchant_id
            AND events.store_id = stores.id
            AND events.mutation_id = $3
        `, [input.merchantId, input.storeId, input.mutationId]);
        return parseState(state.rows, input);
      };

      const before = await readState();
      if (before.event) {
        await this.client.query("COMMIT");
        return receipt<T>("replayed", input, { ...before, event: before.event }, undefined);
      }

      await this.client.query(
        "SELECT set_config('app.collection_mutation_id', $1, true)",
        [input.mutationId],
      );
      const result = await mutate(this.client);
      const after = await readState();
      if (!after.event) {
        throw new Error("order collection mutation did not produce a revision event");
      }
      if (
        after.event.mutationRevision !== before.currentRevision + 1
        || after.currentRevision !== after.event.mutationRevision
      ) {
        throw new Error("order collection mutation did not produce exactly one monotonic bump");
      }
      await this.client.query("COMMIT");
      return receipt("inserted", input, { ...after, event: after.event }, result);
    } catch (error) {
      if (transactionStarted) await this.client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}
