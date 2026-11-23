-- ═══════════════════════════════════════════════════════════════════════
-- 011_subscription_lifecycle_notifications.sql
-- Release 1.1.2 — Subscription lifecycle notification outbox + recipient
-- resolution plumbing. Agent 16 (subscription lifecycle notification wiring).
--
-- Contract references:
--   docs/07-release-audits/1.1.2-in-dev/annual-package-commercial-and-lifecycle-spec.md
--     (§6 renewal/grace/expiry, §6.4 subscription UX state contract)
--   docs/07-release-audits/1.1.2-in-dev/multi-agent-implementation-plan.md (W3/W4/W6/W11)
--   packages/contracts/src/index.ts
--     (subscriptionLifecycleNotificationTypes, lifecycleNotificationTemplateKeys,
--      lifecycleNotificationTemplateVersion, renewalReminderOffsetDays)
--   db/migrations/004_subscription_billing_and_usage.sql (app.subscription_events)
--   db/migrations/006_signup_identity_and_verification.sql (app.signup_requests,
--     app.email_delivery_attempts)
--
-- What this migration adds:
--   1. app.subscription_notifications — idempotent lifecycle notification outbox.
--      One row per (source event, template, template version). Duplicate
--      scheduler/dispatcher runs produce no duplicate rows (ON CONFLICT).
--   2. app.signup_requests.owner_merchant_id — denormalized merchant id derived
--      from the owner's normalized email, so recipient resolution is a clean
--      merchant-scoped indexed join. Populated by a BEFORE INSERT/UPDATE
--      trigger that mirrors signup-service.merchantIdFromEmail() using pgcrypto.
--      This keeps Agent 4's TypeScript untouched; parity is unit-tested.
--
-- Safety rules (Agent 1 conventions):
--   * Additive only. No DROP, no RENAME, no destructive data mutation.
--   * CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / guarded indexes.
--   * Re-running this file after first success is a no-op.
--   * Does NOT touch subscription state (Agent 3 authority), billing orders
--     (Agent 6) or email provider internals (Agent 4). It only reads
--     app.subscription_events as a downstream consumer.
--   * No secrets, API keys, full email bodies or provider private data are
--     stored. Recipient identity is stored as operator id + an email hash.
-- ═══════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS app;

-- Agent 3's original event ledger predates the grace-ending reminder. This is
-- an additive contract evolution: no rows are changed and the existing unique
-- lifecycle index still deduplicates one event per subscription/period.
ALTER TABLE app.subscription_events
    DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;
ALTER TABLE app.subscription_events
    ADD CONSTRAINT subscription_events_event_type_check CHECK (event_type IN (
        'subscription.activated', 'subscription.renewed', 'subscription.upgraded',
        'subscription.renewal_reminder', 'subscription.entered_grace',
        'subscription.grace_ending', 'subscription.expired', 'subscription.reactivated'
    ));

-- ── 1. Lifecycle notification outbox / delivery ledger ────────────────
-- Each row is the durable intent to deliver ONE lifecycle notification for
-- ONE source subscription event. The idempotency unique index guarantees that
-- re-dispatching the same event with the same template/version is a no-op.
CREATE TABLE IF NOT EXISTS app.subscription_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    subscription_id TEXT NOT NULL REFERENCES app.merchant_subscriptions(id) ON DELETE CASCADE,
    -- Reference to the source app.subscription_events row. Not a hard FK so
    -- that out-of-order dispatch and event-table compaction stay decoupled;
    -- the idempotency index below is the real dedupe authority.
    source_event_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    reminder_offset_days SMALLINT CHECK (reminder_offset_days IN (30, 14, 7, 1)),
    period_end TIMESTAMPTZ NOT NULL,
    notification_type TEXT NOT NULL CHECK (notification_type IN (
        'renewal_reminder', 'grace_started', 'grace_ending', 'expired_basic_fallback',
        'renewal_applied', 'upgrade_applied'
    )),
    template_key TEXT NOT NULL,
    template_version INT NOT NULL,
    -- Idempotency key string (formula documented in packages/contracts).
    idempotency_key TEXT NOT NULL,
    -- Recipient identity. operator_id is always present for delivered rows;
    -- email is resolved for delivery but only a hash is persisted as evidence.
    recipient_operator_id TEXT,
    recipient_email_hash TEXT,
    -- Delivery state. 'pending' = queued for the adapter; 'sent' = adapter
    -- accepted; 'failed' = adapter rejected (retryable); 'deferred' = adapter
    -- asked to retry later; 'skipped_*' = intentionally not delivered.
    delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN (
        'pending', 'sent', 'failed', 'deferred',
        'skipped_no_recipient', 'skipped_no_contact_email', 'skipped_silent_event'
    )),
    provider TEXT CHECK (provider IN ('mailpit', 'resend', 'ses', 'log', 'test') OR provider IS NULL),
    provider_message_id TEXT,
    attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    next_retry_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    -- Secret-free, validated payload summary for audit/replay. Never stores
    -- full email body, API keys or provider private data.
    payload_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Exactly one notification per (source event, template, template version).
    -- Duplicate scheduler runs cannot duplicate delivery jobs.
    CONSTRAINT subscription_notifications_idempotency_uniq
        UNIQUE (source_event_id, template_key, template_version)
);

CREATE INDEX IF NOT EXISTS subscription_notifications_dispatch_idx
    ON app.subscription_notifications(delivery_status, next_retry_at, created_at)
    WHERE delivery_status IN ('pending', 'failed', 'deferred');
CREATE INDEX IF NOT EXISTS subscription_notifications_merchant_idx
    ON app.subscription_notifications(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_notifications_subscription_idx
    ON app.subscription_notifications(subscription_id, period_end DESC);

-- ── 2. Owner recipient resolution: denormalized merchant id on signup ─
-- signup_requests.normalized_email is the only stored owner contact email, and
-- it links to the merchant/operator only through signup-service's deterministic
-- hash (merchantIdFromEmail). We persist that derived merchant id here so that
-- recipient resolution is a clean merchant-scoped indexed join, without
-- touching Agent 4's TypeScript. The trigger mirrors:
--   merchantIdFromEmail(email) = 'm_' + sha256('merchant:' + email).hex[:16]
ALTER TABLE app.signup_requests
    ADD COLUMN IF NOT EXISTS owner_merchant_id TEXT;

-- Backfill existing rows idempotently, guarded so re-runs are no-ops.
UPDATE app.signup_requests
   SET owner_merchant_id = 'm_' || substr(
        encode(digest('merchant:' || normalized_email, 'sha256'), 'hex'), 1, 16)
 WHERE owner_merchant_id IS NULL
   AND normalized_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS signup_requests_owner_merchant_idx
    ON app.signup_requests(owner_merchant_id, status)
    WHERE owner_merchant_id IS NOT NULL;

-- Function + BEFORE INSERT/UPDATE trigger keep owner_merchant_id in sync for
-- new/changed rows without changing Agent 4's application code. Replacing the
-- function in place preserves unrelated dependent triggers/views; only this
-- migration's named trigger is replaced on reapply.
CREATE OR REPLACE FUNCTION app.signup_requests_set_owner_merchant_id()
RETURNS trigger AS $$
BEGIN
    IF NEW.normalized_email IS NOT NULL THEN
        NEW.owner_merchant_id := 'm_' || substr(
            encode(digest('merchant:' || NEW.normalized_email, 'sha256'), 'hex'), 1, 16);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

DROP TRIGGER IF EXISTS signup_requests_set_owner_merchant_id_trg
    ON app.signup_requests;
CREATE TRIGGER signup_requests_set_owner_merchant_id_trg
    BEFORE INSERT OR UPDATE OF normalized_email ON app.signup_requests
    FOR EACH ROW
    EXECUTE FUNCTION app.signup_requests_set_owner_merchant_id();
