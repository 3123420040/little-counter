-- 014_final_tenant_scope_hardening.sql
-- Release 1.1.2 — Final tenant-scope, idempotency and delivery-concurrency
-- hardening. Agent 19 (final tenant-scope corrective remediation).
--
-- Contract references:
--   docs/07-release-audits/1.1.2-in-dev/multi-agent-implementation-plan.md (W1)
--   packages/application/src/db/idempotency.ts (withScopedIdempotency)
--   packages/application/src/services/payment-intent-service.ts (stock_location_id)
--   packages/application/src/services/subscription-lifecycle-notification-service.ts (lease)
--
-- What this migration adds:
--   1. app.idempotency_records.tenant_id and .operation — partitions the
--      idempotency key by (tenant_id, operation) so the same key can safely
--      exist across merchants and operations without response leakage. The
--      global uniqueness constraint is replaced with a partial unique index
--      that preserves uniqueness for legacy NULL tenant/operation rows.
--   2. app.payment_intents.stock_location_id — freezes the captured stock
--      location at intent creation so provider settlement uses the captured
--      location instead of headers or LIMIT 1.
--   3. app.subscription_notifications.claimed_by / .lease_token /
--      .lease_expires_at — dispatch claim/lease so concurrent notification
--      workers cannot send the same due row concurrently.
--
-- Safety rules (Agent 1 conventions):
--   * Additive only. No DROP of data, no RENAME, no destructive mutation.
--   * The legacy global UNIQUE on idempotency_key is dropped only after the
--     partial replacement index is installed, preserving uniqueness for the
--     legacy NULL-tenant rows that still rely on it.
--   * All new columns are nullable so historical rows are preserved.
--   * Re-running this file after first success is a no-op.

CREATE SCHEMA IF NOT EXISTS app;

-- ── 1. Tenant-scoped idempotency ───────────────────────
ALTER TABLE app.idempotency_records
    ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE app.idempotency_records
    ADD COLUMN IF NOT EXISTS operation TEXT;

-- Partial unique index for legacy rows that still have no tenant/operation.
-- This preserves the old global uniqueness guarantee for any caller that has
-- not yet migrated to withScopedIdempotency.
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_legacy_key_idx
    ON app.idempotency_records (idempotency_key)
    WHERE tenant_id IS NULL AND operation IS NULL;

-- Scoped unique index: one (tenant, operation, key) at a time. This is the
-- canonical uniqueness constraint going forward.
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_scoped_key_idx
    ON app.idempotency_records (tenant_id, operation, idempotency_key)
    WHERE tenant_id IS NOT NULL AND operation IS NOT NULL;

-- Drop the legacy column-level UNIQUE constraint if it still exists. It is
-- now redundant with the partial legacy index above and would otherwise block
-- the same key across merchants. The constraint name is auto-derived from the
-- table + column.
ALTER TABLE app.idempotency_records
    DROP CONSTRAINT IF EXISTS idempotency_records_idempotency_key_key;
DROP INDEX IF EXISTS app.app_idempotency_key_idx;

-- ── 2. Payment intent captured stock location ──────────
ALTER TABLE app.payment_intents
    ADD COLUMN IF NOT EXISTS stock_location_id TEXT;

-- ── 3. Notification delivery claim/lease ───────────────
ALTER TABLE app.subscription_notifications
    ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE app.subscription_notifications
    ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE app.subscription_notifications
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- Dispatch index for claimable rows (pending/failed/deferred) by lease expiry.
CREATE INDEX IF NOT EXISTS subscription_notifications_lease_idx
    ON app.subscription_notifications (delivery_status, lease_expires_at)
    WHERE delivery_status IN ('pending', 'failed', 'deferred');
