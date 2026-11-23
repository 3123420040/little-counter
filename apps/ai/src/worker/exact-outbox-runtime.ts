import type { Pool, QueryResultRow } from "pg";
import {
  createExactOutboxWorker,
  type ExactOutboxBatchSummary,
} from "./exact-outbox-worker.js";

export const EXACT_OUTBOX_MIGRATION_FILENAME =
  "027_outbox_causality_and_claim_fencing.sql";
export const EXACT_OUTBOX_MIGRATION_CHECKSUM =
  "19bb8c4783a4d75e8945bed7a0a89d3d0cd711bb9b1089a926a6dd8328037fe0";

export type ExactOutboxRuntimeGuardCode =
  | "guard_query_failed"
  | "migration_checksum_mismatch"
  | "exact_functions_missing"
  | "exact_insert_guard_missing"
  | "handler_schema_missing"
  | "legacy_backlog_open";

export class ExactOutboxRuntimeGuardError extends Error {
  readonly code: ExactOutboxRuntimeGuardCode;

  constructor(code: ExactOutboxRuntimeGuardCode) {
    super(`Exact outbox runtime guard failed: ${code}`);
    this.name = "ExactOutboxRuntimeGuardError";
    this.code = code;
  }
}

export type ExactOutboxRuntimeEvidence = {
  migrationFilename: typeof EXACT_OUTBOX_MIGRATION_FILENAME;
  migrationChecksum: typeof EXACT_OUTBOX_MIGRATION_CHECKSUM;
  openLegacyEventCount: number;
};

type CatalogGuardRow = {
  migration_checksum_matches: boolean;
  exact_functions_present: boolean;
  exact_insert_guard_enabled: boolean;
  handler_relations_present: boolean;
};

type BacklogGuardRow = {
  open_legacy_event_count: string | number;
};

type QueueSnapshotRow = QueryResultRow & {
  open_exact_event_count: string | number;
  actionable_event_count: string | number;
  processing_event_count: string | number;
  expired_lease_count: string | number;
  blocked_exact_event_count: string | number;
  dead_blocked_event_count: string | number;
  dead_lettered_event_count: string | number;
  oldest_open_age_seconds: string | number | null;
  oldest_actionable_age_seconds: string | number | null;
};

const CATALOG_GUARD_SQL = `
  SELECT
    COALESCE((
      SELECT migration.checksum = $2
      FROM app.schema_migrations migration
      WHERE migration.filename = $1
    ), false) AS migration_checksum_matches,
    (
      to_regprocedure('outbox.claim_exact_events(text,integer,integer)') IS NOT NULL
      AND to_regprocedure('outbox.complete_exact_event_claim(uuid,text,uuid,bigint)') IS NOT NULL
      AND to_regprocedure('outbox.fail_exact_event_claim(uuid,text,uuid,bigint,text,text,timestamp with time zone,boolean,text)') IS NOT NULL
    ) AS exact_functions_present,
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger trigger
      JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'outbox'
        AND relation.relname = 'events'
        AND trigger.tgname = 'outbox_events_exact_insert_trg'
        AND trigger.tgenabled IN ('O', 'A')
        AND NOT trigger.tgisinternal
    ) AS exact_insert_guard_enabled,
    NOT EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'accounting.accounts',
        'accounting.crypto_asset_lots',
        'accounting.crypto_receipt_evidence',
        'accounting.journal_entries',
        'accounting.journal_lines',
        'ai_module.actions',
        'ai_module.customer_profiles',
        'ai_module.inventory_alerts',
        'ai_module.loyalty_records',
        'ai_module.loyalty_tiers',
        'app.merchants',
        'app.operator_identities',
        'app.payment_entries',
        'app.product_variant_images',
        'app.telegram_bot_configs',
        'app.vision_scan_corrections',
        'app.vision_scan_detections',
        'app.vision_scan_events',
        'app.vision_scan_image_artifacts',
        'audit.events',
        'notification.telegram_notification_rules',
        'notification.telegram_notifications',
        'notification.telegram_recipients',
        'outbox.events',
        'public."order"',
        'public.product',
        'public.product_variant'
      ]::text[]) AS required(relation_name)
      WHERE to_regclass(required.relation_name) IS NULL
    ) AS handler_relations_present
`;

const LEGACY_BACKLOG_GUARD_SQL = `
  SELECT count(*)::text AS open_legacy_event_count
  FROM outbox.events
  WHERE causality_quality = 'legacy_ambiguous'
    AND status NOT IN ('completed', 'dead_lettered')
`;

const QUEUE_SNAPSHOT_SQL = `
  WITH queue_clock AS (
    SELECT clock_timestamp() AS observed_at
  ),
  actionable AS (
    SELECT event.id, event.created_at
    FROM outbox.events event
    CROSS JOIN queue_clock
    WHERE event.causality_quality = 'exact'
      AND (
        (
          event.status IN ('pending', 'failed')
          AND (event.next_retry_at IS NULL OR event.next_retry_at <= queue_clock.observed_at)
        )
        OR (
          event.status = 'processing'
          AND event.claimed_until < queue_clock.observed_at
        )
      )
      AND (
        event.aggregate_sequence = 1
        OR EXISTS (
          SELECT 1
          FROM outbox.events predecessor
          WHERE predecessor.id = event.predecessor_event_id
            AND predecessor.causality_quality = 'exact'
            AND predecessor.merchant_id = event.merchant_id
            AND predecessor.store_id IS NOT DISTINCT FROM event.store_id
            AND predecessor.aggregate_type = event.aggregate_type
            AND predecessor.aggregate_id = event.aggregate_id
            AND predecessor.aggregate_sequence = event.aggregate_sequence - 1
            AND predecessor.status = 'completed'
        )
      )
  )
  SELECT
    count(*) FILTER (
      WHERE event.causality_quality = 'exact'
        AND event.status IN ('pending', 'processing', 'failed')
    )::text AS open_exact_event_count,
    (SELECT count(*)::text FROM actionable) AS actionable_event_count,
    count(*) FILTER (
      WHERE event.causality_quality = 'exact'
        AND event.status = 'processing'
    )::text AS processing_event_count,
    count(*) FILTER (
      WHERE event.causality_quality = 'exact'
        AND event.status = 'processing'
        AND event.claimed_until < queue_clock.observed_at
    )::text AS expired_lease_count,
    (SELECT count(*)::text FROM outbox.blocked_exact_events) AS blocked_exact_event_count,
    (
      SELECT count(*)::text
      FROM outbox.blocked_exact_events
      WHERE blocked_reason = 'dead_predecessor'
    ) AS dead_blocked_event_count,
    count(*) FILTER (
      WHERE event.causality_quality = 'exact'
        AND event.status = 'dead_lettered'
    )::text AS dead_lettered_event_count,
    extract(epoch FROM (
      queue_clock.observed_at - min(event.created_at) FILTER (
        WHERE event.causality_quality = 'exact'
          AND event.status IN ('pending', 'processing', 'failed')
      )
    ))::text AS oldest_open_age_seconds,
    (
      SELECT extract(epoch FROM (queue_clock.observed_at - min(actionable.created_at)))::text
      FROM actionable
    ) AS oldest_actionable_age_seconds
  FROM queue_clock
  LEFT JOIN outbox.events event ON true
  GROUP BY queue_clock.observed_at
`;

export type ExactOutboxQueueSnapshot = {
  openExactEventCount: number;
  actionableEventCount: number;
  processingEventCount: number;
  expiredLeaseCount: number;
  blockedExactEventCount: number;
  deadBlockedEventCount: number;
  deadLetteredEventCount: number;
  oldestOpenAgeSeconds: number | null;
  oldestActionableAgeSeconds: number | null;
};

export type ExactOutboxRuntimeBudgets = {
  maxActionableAgeSeconds: number;
  maxNoProgressSeconds: number;
  maxBatchRuntimeSeconds: number;
};

const DEFAULT_RUNTIME_BUDGETS: ExactOutboxRuntimeBudgets = {
  maxActionableAgeSeconds: 300,
  maxNoProgressSeconds: 60,
  maxBatchRuntimeSeconds: 240,
};

function safeCount(value: string | number, field: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid exact outbox queue count: ${field}`);
  }
  return count;
}

function safeAge(value: string | number | null, field: string): number | null {
  if (value === null) return null;
  const age = Number(value);
  if (!Number.isFinite(age)) {
    throw new Error(`Invalid exact outbox queue age: ${field}`);
  }
  return Math.max(0, Math.floor(age));
}

export async function inspectExactOutboxQueue(
  db: Pool,
): Promise<ExactOutboxQueueSnapshot> {
  const result = await db.query<QueueSnapshotRow>(QUEUE_SNAPSHOT_SQL);
  const row = result.rows[0];
  if (!row) throw new Error("Exact outbox queue inspection returned no row");
  return {
    openExactEventCount: safeCount(row.open_exact_event_count, "open_exact_event_count"),
    actionableEventCount: safeCount(row.actionable_event_count, "actionable_event_count"),
    processingEventCount: safeCount(row.processing_event_count, "processing_event_count"),
    expiredLeaseCount: safeCount(row.expired_lease_count, "expired_lease_count"),
    blockedExactEventCount: safeCount(row.blocked_exact_event_count, "blocked_exact_event_count"),
    deadBlockedEventCount: safeCount(row.dead_blocked_event_count, "dead_blocked_event_count"),
    deadLetteredEventCount: safeCount(row.dead_lettered_event_count, "dead_lettered_event_count"),
    oldestOpenAgeSeconds: safeAge(row.oldest_open_age_seconds, "oldest_open_age_seconds"),
    oldestActionableAgeSeconds: safeAge(
      row.oldest_actionable_age_seconds,
      "oldest_actionable_age_seconds",
    ),
  };
}

function guardFailure(code: ExactOutboxRuntimeGuardCode): never {
  throw new ExactOutboxRuntimeGuardError(code);
}

export async function assertExactOutboxRuntimeCompatible(
  db: Pool,
): Promise<ExactOutboxRuntimeEvidence> {
  let catalog: CatalogGuardRow | undefined;
  try {
    const result = await db.query<CatalogGuardRow>(CATALOG_GUARD_SQL, [
      EXACT_OUTBOX_MIGRATION_FILENAME,
      EXACT_OUTBOX_MIGRATION_CHECKSUM,
    ]);
    catalog = result.rows[0];
  } catch {
    return guardFailure("guard_query_failed");
  }

  if (catalog?.migration_checksum_matches !== true) {
    return guardFailure("migration_checksum_mismatch");
  }
  if (catalog.exact_functions_present !== true) {
    return guardFailure("exact_functions_missing");
  }
  if (catalog.exact_insert_guard_enabled !== true) {
    return guardFailure("exact_insert_guard_missing");
  }
  if (catalog.handler_relations_present !== true) {
    return guardFailure("handler_schema_missing");
  }

  let openLegacyEventCount: number;
  try {
    const result = await db.query<BacklogGuardRow>(LEGACY_BACKLOG_GUARD_SQL);
    openLegacyEventCount = Number(result.rows[0]?.open_legacy_event_count);
  } catch {
    return guardFailure("guard_query_failed");
  }
  if (!Number.isSafeInteger(openLegacyEventCount) || openLegacyEventCount < 0) {
    return guardFailure("guard_query_failed");
  }
  if (openLegacyEventCount !== 0) {
    return guardFailure("legacy_backlog_open");
  }

  return {
    migrationFilename: EXACT_OUTBOX_MIGRATION_FILENAME,
    migrationChecksum: EXACT_OUTBOX_MIGRATION_CHECKSUM,
    openLegacyEventCount,
  };
}

type ExactWorkerFactory = typeof createExactOutboxWorker;
type ExactWorker = ReturnType<ExactWorkerFactory>;

export type ExactOutboxRuntimeReadiness = {
  ready: boolean;
  mode: "exact_v1";
  state: "prepared" | "running" | "degraded" | "stopped";
  migrationFilename: typeof EXACT_OUTBOX_MIGRATION_FILENAME;
  migrationChecksum: typeof EXACT_OUTBOX_MIGRATION_CHECKSUM;
  lastSuccessfulBatchAt: string | null;
  lastFailureAt: string | null;
  lastFailureClass: string | null;
  lastQueueCheckAt: string | null;
  lastProgressAt: string | null;
  queue: ExactOutboxQueueSnapshot | null;
  budgets: ExactOutboxRuntimeBudgets;
};

export type ExactOutboxRuntime = Pick<ExactWorker, "runOnce" | "isRunning" | "isStarted"> & {
  start: () => void;
  stop: () => void;
  getReadiness: () => ExactOutboxRuntimeReadiness;
};

type PrepareExactOutboxRuntimeOptions = {
  db: Pool;
  workerId: string;
  pollIntervalMs?: number;
  verify?: typeof assertExactOutboxRuntimeCompatible;
  inspect?: typeof inspectExactOutboxQueue;
  factory?: ExactWorkerFactory;
  now?: () => Date;
  maxActionableAgeSeconds?: number;
  maxNoProgressSeconds?: number;
  maxBatchRuntimeSeconds?: number;
};

function safeFailureClass(value: string): string {
  const normalized = String(value || "").trim().slice(0, 80);
  return /^[A-Za-z0-9._-]+$/.test(normalized) ? normalized : "UnknownError";
}

export async function prepareExactOutboxRuntime(
  options: PrepareExactOutboxRuntimeOptions,
): Promise<ExactOutboxRuntime> {
  const verify = options.verify ?? assertExactOutboxRuntimeCompatible;
  const inspect = options.inspect ?? inspectExactOutboxQueue;
  const factory = options.factory ?? createExactOutboxWorker;
  const now = options.now ?? (() => new Date());
  const budgets: ExactOutboxRuntimeBudgets = {
    maxActionableAgeSeconds: options.maxActionableAgeSeconds
      ?? DEFAULT_RUNTIME_BUDGETS.maxActionableAgeSeconds,
    maxNoProgressSeconds: options.maxNoProgressSeconds
      ?? DEFAULT_RUNTIME_BUDGETS.maxNoProgressSeconds,
    maxBatchRuntimeSeconds: options.maxBatchRuntimeSeconds
      ?? DEFAULT_RUNTIME_BUDGETS.maxBatchRuntimeSeconds,
  };
  const evidence = await verify(options.db);
  let state: ExactOutboxRuntimeReadiness["state"] = "prepared";
  let lastSuccessfulBatchAt: string | null = null;
  let lastFailureAt: string | null = null;
  let lastFailureClass: string | null = null;
  let lastQueueCheckAt: string | null = null;
  let lastProgressAt: string | null = null;
  let queue: ExactOutboxQueueSnapshot | null = null;
  let firstActionableObservedAt: number | null = null;
  let firstBusyObservedAt: number | null = null;

  function degrade(errorClass: string, observedAt: Date): void {
    state = "degraded";
    lastFailureAt = observedAt.toISOString();
    lastFailureClass = errorClass;
  }

  function hasProgress(summary: ExactOutboxBatchSummary): boolean {
    return summary.completed > 0
      || summary.retryScheduled > 0
      || summary.deadLettered > 0;
  }

  async function observeCompletedBatch(summary: ExactOutboxBatchSummary): Promise<void> {
    const observedAt = now();
    const observedAtMs = observedAt.getTime();
    if (summary.skippedBecauseBusy) {
      firstBusyObservedAt ??= observedAtMs;
      if (
        observedAtMs - firstBusyObservedAt
        >= budgets.maxBatchRuntimeSeconds * 1_000
      ) {
        degrade("OutboxBatchStalled", observedAt);
      }
      return;
    }

    firstBusyObservedAt = null;
    if (summary.transitionErrors > 0) {
      degrade("OutboxTransitionError", observedAt);
      return;
    }
    if (hasProgress(summary)) {
      lastProgressAt = observedAt.toISOString();
      firstActionableObservedAt = observedAtMs;
    }

    try {
      queue = await inspect(options.db);
    } catch {
      degrade("OutboxQueueProbeError", observedAt);
      return;
    }
    lastQueueCheckAt = observedAt.toISOString();

    if (queue.deadBlockedEventCount > 0) {
      degrade("OutboxBlockedChain", observedAt);
      return;
    }
    if (queue.expiredLeaseCount > 0) {
      degrade("OutboxExpiredLease", observedAt);
      return;
    }
    if (
      queue.oldestActionableAgeSeconds !== null
      && queue.oldestActionableAgeSeconds > budgets.maxActionableAgeSeconds
    ) {
      degrade("OutboxBacklogAgeExceeded", observedAt);
      return;
    }
    if (queue.actionableEventCount > 0) {
      firstActionableObservedAt ??= observedAtMs;
      const progressAnchor = lastProgressAt
        ? new Date(lastProgressAt).getTime()
        : firstActionableObservedAt;
      if (
        observedAtMs - progressAnchor
        >= budgets.maxNoProgressSeconds * 1_000
      ) {
        degrade("OutboxProgressStalled", observedAt);
        return;
      }
    } else {
      firstActionableObservedAt = null;
    }

    state = "running";
    lastSuccessfulBatchAt = observedAt.toISOString();
    lastFailureClass = null;
  }

  const worker = factory({
    db: options.db,
    workerId: options.workerId,
    pollIntervalMs: options.pollIntervalMs,
    claimLimit: 1,
    leaseSeconds: 300,
    observer: {
      async onBatchCompleted(summary) {
        await observeCompletedBatch(summary);
      },
      async onBatchFailed(errorClass) {
        degrade(safeFailureClass(errorClass), now());
      },
    },
  });

  return {
    runOnce: worker.runOnce,
    isRunning: worker.isRunning,
    isStarted: worker.isStarted,
    start() {
      worker.start();
      if (state === "stopped") state = "prepared";
    },
    stop() {
      worker.stop();
      state = "stopped";
    },
    getReadiness() {
      return {
        ready: state === "running",
        mode: "exact_v1",
        state,
        migrationFilename: evidence.migrationFilename,
        migrationChecksum: evidence.migrationChecksum,
        lastSuccessfulBatchAt,
        lastFailureAt,
        lastFailureClass,
        lastQueueCheckAt,
        lastProgressAt,
        queue,
        budgets,
      };
    },
  };
}
