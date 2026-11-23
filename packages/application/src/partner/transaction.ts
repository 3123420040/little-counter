import type { Pool, PoolClient, QueryConfig } from "pg";

/** PG16-compatible connection defaults. Transaction deadlines are owned below,
 * not by PG17's transaction_timeout startup parameter. */
export const partnerDatabaseTimeouts = {
  statement_timeout: 3000,
  lock_timeout: 1000,
  options: "-c idle_in_transaction_session_timeout=5000",
};

type Begin = "BEGIN" | "BEGIN ISOLATION LEVEL REPEATABLE READ"
  | "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"
  | "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
  | "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE";
interface TransactionOptions {
  begin?: Begin;
  timeoutMs?: number;
  statementTimeoutMs?: number;
  beforeCommit?: () => void;
}

export class PartnerTransactionDeadlineError extends Error {
  constructor() { super("Partner transaction deadline exceeded"); }
}

/** Own BEGIN/work/COMMIT and the checked-out connection. Callers must await all
 * work and use promise queries through the supplied client; no nested TX/COMMIT,
 * streams, callbacks, release/end or raw connection access inside work.
 *
 * Deadline expiry discards the connection, rather than only racing a Promise.
 * pg ends the session (destroying its socket for an active query); PostgreSQL
 * rolls back an uncommitted transaction when it detects that disconnect. Each
 * query also gets PG16 server-side statement/lock/idle timeouts bounded by the
 * remaining budget. This is not a server-native transaction_timeout equivalent
 * under event-loop stalls/network partitions, nor proof that a sent COMMIT did
 * not commit. The caller must reconcile unknown outcomes using stable keys.
 */
export async function withPartnerTransaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>,
  options: TransactionOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const statementTimeoutMs = options.statementTimeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
    || !Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1 || statementTimeoutMs > timeoutMs) {
    throw new Error("Invalid partner transaction budget");
  }
  // Pool acquisition is separately bounded by connectionTimeoutMillis=1000.
  const client = await pool.connect();
  const deadline = performance.now() + timeoutMs;
  let released = false, acceptingQueries = true, clean = false;
  let terminalError: Error | undefined;
  let rejectDeadline!: (error: Error) => void;
  const deadlineFailure = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  function discard(error: Error) {
    if (released) return;
    terminalError = error;
    acceptingQueries = false;
    released = true;
    // Public pg-pool API removes this client; never hand a timed-out session to
    // another request. The wrapper also fences callbacks that resume later.
    client.release(true);
    rejectDeadline(error);
  }
  function remaining() {
    if (terminalError) throw terminalError;
    const value = Math.floor(deadline - performance.now());
    if (value < 1) {
      const error = new PartnerTransactionDeadlineError();
      discard(error);
      throw error;
    }
    return value;
  }
  const connectionLost = () => discard(new Error("Partner transaction connection unavailable"));
  client.on("error", connectionLost);
  client.on("end", connectionLost);
  const timer = setTimeout(() => discard(new PartnerTransactionDeadlineError()), timeoutMs);

  async function setQueryBudget() {
    const budget = remaining();
    await client.query(`SELECT set_config('statement_timeout',$1,true),
      set_config('lock_timeout',$2,true), set_config('idle_in_transaction_session_timeout',$3,true)`,
    [`${Math.min(statementTimeoutMs, budget)}ms`, `${Math.min(1000, budget)}ms`, `${Math.min(5000, budget)}ms`]);
    remaining();
  }
  let queue = Promise.resolve();
  let queryFailed = false;
  let queryFailure: unknown;
  const query = ((...args: unknown[]) => {
    const operation = queue.then(async () => {
      if (!acceptingQueries || released) throw terminalError ?? new Error("Partner transaction closed");
      if (queryFailed) throw queryFailure;
      // These adapters intentionally support the promise query forms only.
      const [textOrConfig, values] = args;
      if (args.length > 2 || (values !== undefined && !Array.isArray(values))
        || (typeof textOrConfig !== "string" && (!textOrConfig || typeof textOrConfig !== "object"
          || typeof (textOrConfig as QueryConfig).text !== "string"
          || "submit" in textOrConfig || "callback" in textOrConfig))) {
        throw new Error("Unsupported partner transaction query");
      }
      await setQueryBudget();
      if (!acceptingQueries || released) throw terminalError ?? new Error("Partner transaction closed");
      const result = await client.query(textOrConfig as string | QueryConfig, values as unknown[] | undefined);
      remaining();
      return result;
    });
    // Keep pg's serialization when callers issue concurrent promise queries;
    // fence the whole transaction even when work catches a failed query.
    queue = operation.then(() => undefined, error => { queryFailed = true; queryFailure = error; });
    return operation;
  }) as PoolClient["query"];
  const scopedClient = new Proxy(client, {
    get(_target, property) {
      if (property === "query") return query;
      throw new Error("Only query is available inside a partner transaction");
    },
  });

  const run = async () => {
    try {
      remaining();
      await client.query(options.begin ?? "BEGIN");
      await setQueryBudget();
      const result = await work(scopedClient);
      await queue;
      acceptingQueries = false;
      if (queryFailed) throw queryFailure;
      remaining();
      await setQueryBudget();
      options.beforeCommit?.();
      remaining();
      await client.query("COMMIT");
      remaining();
      clean = true;
      return result;
    } catch (error) {
      acceptingQueries = false;
      // Drain already-submitted promise queries before ROLLBACK. Otherwise a
      // query awaiting its budget SET could resume after rollback in autocommit.
      await queue;
      if (!released) {
        try { await client.query("ROLLBACK"); clean = true; }
        catch { /* Discard below when rollback cannot be acknowledged. */ }
      }
      throw terminalError ?? error;
    }
  };
  try {
    return await Promise.race([run(), deadlineFailure]);
  } finally {
    acceptingQueries = false;
    clearTimeout(timer);
    client.removeListener("error", connectionLost);
    client.removeListener("end", connectionLost);
    if (!released) { released = true; client.release(!clean); }
  }
}
