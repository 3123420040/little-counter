import type { Pool } from "pg";
import * as applicationNamespace from "@medusa-snus/application";
import type { StoreAdapter } from "@medusa-snus/application";

const applicationModule = ((applicationNamespace as unknown as { default?: typeof import("@medusa-snus/application") }).default ?? applicationNamespace) as typeof import("@medusa-snus/application");
const { processOutboxEvent, safeErrorCode, safeErrorMetadata } = applicationModule as typeof import("@medusa-snus/application");

export function outboxFailureReason(error: unknown): string {
  return `outbox_handler_failed:${safeErrorCode(error)}`;
}

export function outboxFailureMetadata(error: unknown) {
  return safeErrorMetadata(error);
}

// ═══════════════════════════════════════════════════════
// Outbox Worker — AI Module
// Polls every 2s, dispatches to registered handlers
// Per ADR-004 + P0-3 fix (loyalty handlers registered here)
// ═══════════════════════════════════════════════════════

interface EventHandler {
  eventType: string;
  handler: (event: Record<string, unknown>) => Promise<void>;
}

let _store: StoreAdapter | null = null;

export function registerHandler(eventType: string, handler: (event: Record<string, unknown>) => Promise<void>) {
  void eventType;
  void handler;
}

// ── DB Operations ──────────────────────────────────────

async function claimEvents(db: Pool, workerId: string, batchSize: number = 25) {
  const lockMs = 30_000;
  const result = await db.query(
    `WITH claimed AS (
       SELECT id FROM outbox.events
       WHERE status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= now())
         AND (claimed_until IS NULL OR claimed_until <= now())
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox.events
     SET claimed_by = $2, claimed_until = $3, status = 'processing'
     FROM claimed
     WHERE outbox.events.id = claimed.id
     RETURNING outbox.events.*`,
    [batchSize, workerId, new Date(Date.now() + lockMs).toISOString()],
  );
  return result.rows;
}

async function markCompleted(db: Pool, eventId: string) {
  await db.query(`UPDATE outbox.events SET status = 'completed' WHERE id = $1`, [eventId]);
}

async function markFailed(db: Pool, eventId: string, error: string) {
  await db.query(
    `UPDATE outbox.events SET status = CASE WHEN attempts >= 5 THEN 'dead_lettered' ELSE 'pending' END,
        attempts = attempts + 1, last_error = $2, next_retry_at = now() + interval '30 seconds'
     WHERE id = $1`,
    [eventId, error],
  );
}

async function processOutboxBatch(db: Pool): Promise<void> {
  const workerId = `ai_worker_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const events = await claimEvents(db, workerId);
    for (const event of events) {
      try {
        await processOutboxEvent({ id: event.id, eventType: event.event_type, payload: event.payload });
      } catch (err) {
        const reason = outboxFailureReason(err);
        console.error(JSON.stringify({
          level: "error",
          event: "outbox_handler_failed",
          eventId: event.id,
          ...outboxFailureMetadata(err),
        }));
        await markFailed(db, event.id, reason);
        continue;
      }
      await markCompleted(db, event.id);
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "error", event: "outbox_worker_failed", ...outboxFailureMetadata(err) }));
  }
}

export function startOutboxWorker(db: Pool, store?: StoreAdapter) {
  if (store) _store = store;
  void _store;

  console.log("AI Module: Outbox worker started (polling every 2s)");

  setInterval(() => {
    processOutboxBatch(db).catch(err => console.error(JSON.stringify({
      level: "error",
      event: "outbox_batch_failed",
      ...outboxFailureMetadata(err),
    })));
  }, 2000);
}
