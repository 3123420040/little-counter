-- ═══════════════════════════════════════════════════════════════════════
-- 004_subscription_billing_and_usage.sql
-- Release 1.1.2 — Annual subscription, package catalog and usage metering.
-- Agent 3 (annual subscription, entitlement and usage policy)
--
-- Contract references:
--   docs/07-release-audits/1.1.2-in-dev/annual-package-commercial-and-lifecycle-spec.md
--   docs/07-release-audits/1.1.2-in-dev/multi-agent-implementation-plan.md (W3)
--   packages/contracts/src/index.ts (PackageCatalogVersionSnapshot,
--     MerchantSubscriptionStatus, UsageMetricBucket, subscriptionPolicySnapshot)
--   db/migrations/002_tenant_foundation_expand.sql (app.merchants / app.stores)
--
-- Safety rules (Agent 1 conventions):
--   * Additive only. No DROP, no RENAME, no destructive data mutation.
--   * CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / guarded indexes.
--   * Re-running this file after first success is a no-op.
--   * Purchased subscription state is never overwritten by startup/env. The
--     env compatibility seed (app.package_entitlements) is untouched here.
--   * Money is integer VND (NUMERIC(20,0)); asset/credit quantities are
--     integers per metric. No floating point.
-- ═══════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS app;

-- ── 1. Versioned, tax-inclusive package catalog ───────────────────────
-- Each (catalog_version, package_key) is immutable once published. Prices
-- are the final tax-inclusive VND package amount shown before provider
-- conversion (spec §1, §9). A subscription pins exactly one catalog row.
CREATE TABLE IF NOT EXISTS app.package_catalog_versions (
    id TEXT PRIMARY KEY,
    catalog_version TEXT NOT NULL,
    package_key TEXT NOT NULL CHECK (package_key IN ('basic', 'plus', 'ai_fan')),
    -- Tax-inclusive annual price in integer VND. Basic is 0.
    annual_price_vnd NUMERIC(20,0) NOT NULL CHECK (annual_price_vnd >= 0),
    included_stores INTEGER NOT NULL CHECK (included_stores >= 0),
    staff_limit INTEGER NOT NULL CHECK (staff_limit >= 0),
    research_runs_per_month INTEGER NOT NULL CHECK (research_runs_per_month >= 0),
    telegram_ai_drafts_per_month INTEGER NOT NULL CHECK (telegram_ai_drafts_per_month >= 0),
    -- Canonical package feature keys (packageFeatureKeys in contracts).
    feature_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_published BOOLEAN NOT NULL DEFAULT true,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS package_catalog_versions_version_pkg_idx
    ON app.package_catalog_versions(catalog_version, package_key);
CREATE INDEX IF NOT EXISTS package_catalog_versions_pkg_idx
    ON app.package_catalog_versions(package_key, effective_from DESC);

-- Seed the frozen 1.1.2 annual catalog (contracts: packageCatalogEntries).
-- Tax-inclusive prices. Deterministic ids: pcv_<version>_<package_key>.
-- Idempotent: existing immutable rows are never rewritten.
INSERT INTO app.package_catalog_versions
    (id, catalog_version, package_key, annual_price_vnd, included_stores, staff_limit,
     research_runs_per_month, telegram_ai_drafts_per_month, feature_keys, effective_from, metadata)
VALUES
    ('pcv_1_1_2_annual_v1_basic', '1.1.2-annual-v1', 'basic', 0, 1, 3, 0, 0,
     '["pos_core","accounting_core"]'::jsonb,
     '2026-06-20T00:00:00Z', '{"taxInclusive": true}'::jsonb),
    ('pcv_1_1_2_annual_v1_plus', '1.1.2-annual-v1', 'plus', 3588000, 3, 10, 100, 0,
     '["pos_core","accounting_core","sepay_qr_payment","crypto_payment","smart_cross_sell","product_research"]'::jsonb,
     '2026-06-20T00:00:00Z', '{"taxInclusive": true}'::jsonb),
    ('pcv_1_1_2_annual_v1_ai_fan', '1.1.2-annual-v1', 'ai_fan', 7188000, 5, 30, 500, 2000,
     '["pos_core","accounting_core","telegram_runtime","sepay_qr_payment","crypto_payment","smart_cross_sell","product_research","telegram_ai_ordering"]'::jsonb,
     '2026-06-20T00:00:00Z', '{"taxInclusive": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Merchant subscription timeline ─────────────────────────────────
-- One active subscription row per merchant. Calendar-year periods with the
-- Feb-29 clamp policy applied in the service layer. primary_store_id is the
-- permanent Basic-fallback writable store (spec §1: migrated store_default).
-- status is derived (active/grace/expired) but persisted for fast reads and
-- audit; the service recomputes status from the clock on every read.
CREATE TABLE IF NOT EXISTS app.merchant_subscriptions (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    package_key TEXT NOT NULL CHECK (package_key IN ('basic', 'plus', 'ai_fan')),
    catalog_version_id TEXT NOT NULL REFERENCES app.package_catalog_versions(id),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'grace', 'expired')),
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end TIMESTAMPTZ NOT NULL,
    grace_ends_at TIMESTAMPTZ,
    -- Permanent primary store used for Basic fallback writes after expiry.
    primary_store_id TEXT NOT NULL,
    -- Anchor day-of-month for monthly usage windows (1..31, clamped at runtime).
    usage_anchor_day SMALLINT NOT NULL DEFAULT 1
        CHECK (usage_anchor_day BETWEEN 1 AND 31),
    policy_version TEXT NOT NULL DEFAULT '1.1.2-annual-v1',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (current_period_end > current_period_start)
);

-- Exactly one subscription per merchant in 1.1.2.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_subscriptions_merchant_idx
    ON app.merchant_subscriptions(merchant_id);
CREATE INDEX IF NOT EXISTS merchant_subscriptions_period_end_idx
    ON app.merchant_subscriptions(current_period_end);
CREATE INDEX IF NOT EXISTS merchant_subscriptions_status_idx
    ON app.merchant_subscriptions(status, grace_ends_at);

-- ── 3. Subscription lifecycle / reminder events (idempotent ledger) ───
-- Append-only log of lifecycle transitions and renewal reminders. The
-- scheduler emits T-30/T-14/T-7/T-1 reminders and grace/expiry events; this
-- table is the idempotency guard (no duplicate reminder per period) and the
-- source the notification adapter (Agent 4) consumes. We do NOT send email
-- here; we only persist the event.
CREATE TABLE IF NOT EXISTS app.subscription_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    subscription_id TEXT NOT NULL REFERENCES app.merchant_subscriptions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'subscription.activated',
        'subscription.renewed',
        'subscription.upgraded',
        'subscription.renewal_reminder',
        'subscription.entered_grace',
        'subscription.expired',
        'subscription.reactivated'
    )),
    -- Reminder offset in days (30/14/7/1) for renewal_reminder events; NULL otherwise.
    reminder_offset_days SMALLINT CHECK (reminder_offset_days IN (30, 14, 7, 1)),
    -- The period_end this event refers to; together with event_type and
    -- reminder_offset_days it forms the idempotency key.
    period_end TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One reminder per (subscription, period_end, offset); one lifecycle event
-- per (subscription, type, period_end).
CREATE UNIQUE INDEX IF NOT EXISTS subscription_events_reminder_unique_idx
    ON app.subscription_events(subscription_id, period_end, reminder_offset_days)
    WHERE event_type = 'subscription.renewal_reminder';
CREATE UNIQUE INDEX IF NOT EXISTS subscription_events_lifecycle_unique_idx
    ON app.subscription_events(subscription_id, event_type, period_end)
    WHERE event_type <> 'subscription.renewal_reminder';
CREATE INDEX IF NOT EXISTS subscription_events_merchant_idx
    ON app.subscription_events(merchant_id, created_at DESC);

-- ── 4. Monthly anniversary usage buckets ──────────────────────────────
-- One row per (merchant, metric, window). Windows are monthly anniversary
-- windows anchored to usage_anchor_day with month-length clamping done in the
-- service. included_quantity is copied from the pinned catalog at window open.
-- used + reserved must never exceed included for capped metrics; uncapped
-- (cost/abuse) metrics carry included_quantity = NULL.
CREATE TABLE IF NOT EXISTS app.subscription_usage_buckets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    subscription_id TEXT NOT NULL REFERENCES app.merchant_subscriptions(id) ON DELETE CASCADE,
    metric_key TEXT NOT NULL CHECK (metric_key IN (
        'product_research_runs', 'telegram_ai_drafts', 'provider_credits', 'llm_tokens'
    )),
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    -- NULL = uncapped internal cost/abuse metric (provider_credits, llm_tokens).
    included_quantity BIGINT CHECK (included_quantity IS NULL OR included_quantity >= 0),
    used_quantity BIGINT NOT NULL DEFAULT 0 CHECK (used_quantity >= 0),
    reserved_quantity BIGINT NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (window_end > window_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_buckets_window_unique_idx
    ON app.subscription_usage_buckets(merchant_id, metric_key, window_start);
CREATE INDEX IF NOT EXISTS usage_buckets_lookup_idx
    ON app.subscription_usage_buckets(merchant_id, metric_key, window_end DESC);

-- ── 5. Usage reservations (reserve → commit | release) ────────────────
-- A reservation holds quota before a paid action runs. Commit converts the
-- held amount into used_quantity; release returns it. The token is the
-- idempotency handle so retries never double-spend.
CREATE TABLE IF NOT EXISTS app.subscription_usage_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_token TEXT NOT NULL UNIQUE,
    bucket_id UUID NOT NULL REFERENCES app.subscription_usage_buckets(id) ON DELETE CASCADE,
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    metric_key TEXT NOT NULL CHECK (metric_key IN (
        'product_research_runs', 'telegram_ai_drafts', 'provider_credits', 'llm_tokens'
    )),
    quantity BIGINT NOT NULL CHECK (quantity > 0),
    status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'committed', 'released')),
    reference_type TEXT,
    reference_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS usage_reservations_bucket_idx
    ON app.subscription_usage_reservations(bucket_id, status);
CREATE INDEX IF NOT EXISTS usage_reservations_merchant_idx
    ON app.subscription_usage_reservations(merchant_id, created_at DESC);

-- ── 6. Backfill the production merchant onto Basic (non-destructive) ───
-- merchant_default already exists from 003. Give it a Basic subscription so
-- post-expiry fallback and entitlement reads have a row to resolve. We do not
-- touch app.package_entitlements (the env compatibility seed). Calendar-year
-- period anchored at the backfill instant; renewal/upgrade replaces it later.
-- Skipped entirely if the merchant or its primary store is absent.
INSERT INTO app.merchant_subscriptions
    (id, merchant_id, package_key, catalog_version_id, status,
     current_period_start, current_period_end, grace_ends_at,
     primary_store_id, usage_anchor_day, metadata)
SELECT
    'sub_' || m.id,
    m.id,
    'basic',
    'pcv_1_1_2_annual_v1_basic',
    'active',
    date_trunc('day', now()),
    date_trunc('day', now()) + INTERVAL '1 year',
    NULL,
    s.id,
    EXTRACT(DAY FROM now())::smallint,
    jsonb_build_object('source', 'migration_004_backfill')
FROM app.merchants m
JOIN app.stores s ON s.merchant_id = m.id AND s.is_primary = true
WHERE NOT EXISTS (
    SELECT 1 FROM app.merchant_subscriptions ms WHERE ms.merchant_id = m.id
);
