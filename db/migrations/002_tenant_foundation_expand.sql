-- ═══════════════════════════════════════════════════════════════════════
-- 002_tenant_foundation_expand.sql
-- Release 1.1.2 — Tenant foundation expansion (additive only).
-- Agent 1 (tenant migration / production data safety)
--
-- Contract references:
--   docs/07-release-audits/1.1.2-in-dev/production-data-migration-and-tenant-architecture-review.md
--   docs/07-release-audits/1.1.2-in-dev/codebase-alignment-architecture-and-ux-critical-review.md
--   docs/07-release-audits/1.1.2-in-dev/agent-0-frozen-contract-note.md
--
-- Safety rules enforced by this migration:
--   * No DROP, no RENAME, no production data mutation.
--   * Adds app.merchants / app.stores / app.operator_memberships additively.
--   * Adds nullable merchant_id / store_id to every aggregate in the ownership
--     matrix together with supporting indexes. No NOT NULL is added here.
--   * Adds tenant envelopes for audit/outbox/idempotency without rewriting
--     stored business values.
--   * Adds future-proof scoped idempotency uniqueness while preserving the
--     existing global idempotency_key uniqueness for legacy compatibility.
--   * Re-running this file is a no-op after first success (IF NOT EXISTS /
--     ADD COLUMN IF NOT EXISTS / guarded unique-index creation).
-- ═══════════════════════════════════════════════════════════════════════

-- ── Core tenant entities ───────────────────────────────────────────────
-- merchants: a commercial entity that owns catalog, customers and loyalty.
--            Maps 1:1 from legacy org_default during the compatibility phase.
CREATE TABLE IF NOT EXISTS app.merchants (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    -- Legacy compatibility key. In 1.1.2 this remains the authoritative
    -- join key for all existing rows. Never dropped/renamed in this release.
    legacy_organization_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'closed')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One merchant can map to exactly one legacy organization during the
-- compatibility phase (multiple are not introduced in 1.1.2). The unique
-- constraint is created idempotently below so re-runs are safe.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_merchants_legacy_organization_id'
    ) THEN
        ALTER TABLE app.merchants
            ADD CONSTRAINT uq_merchants_legacy_organization_id
            UNIQUE (legacy_organization_id);
    END IF;
END $$;

-- stores: physical/contact operational unit of a merchant. Each store binds
-- to exactly one primary stock_location in 1.1.2. store_default becomes the
-- primary store for merchant_default.
CREATE TABLE IF NOT EXISTS app.stores (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    display_name TEXT NOT NULL,
    -- The existing Medusa core inventory location behind this store. This is
    -- the explicit, non-arbitrary store-to-stock-location binding required by
    -- the production migration contract.
    stock_location_id TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'closed')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stores_merchant_idx ON app.stores(merchant_id, status);
CREATE INDEX IF NOT EXISTS stores_stock_location_idx ON app.stores(stock_location_id);
-- At most one primary store per merchant in 1.1.2.
CREATE UNIQUE INDEX IF NOT EXISTS stores_one_primary_per_merchant_idx
    ON app.stores(merchant_id) WHERE is_primary = true;
CREATE UNIQUE INDEX IF NOT EXISTS stores_stock_location_unique_idx
    ON app.stores(stock_location_id);

-- operator_memberships: access grants in addition to the existing
-- medusa.staff_users login identity. We do NOT create a second operator
-- identity table in this release (login ids stay unchanged).
CREATE TABLE IF NOT EXISTS app.operator_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id TEXT NOT NULL,
    -- Platform membership = platform admin read access; merchant membership
    -- = merchant-wide access; store membership = single store access.
    scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'merchant', 'store')),
    merchant_id TEXT REFERENCES app.merchants(id) ON UPDATE CASCADE,
    store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
    -- role_key is intentionally TEXT (not the legacy role enum) so the future
    -- permission model can grow without breaking compatibility.
    role_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled', 'revoked')),
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to TIMESTAMPTZ,
    granted_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Enforce that merchant/store ids are consistent with scope_type.
    CONSTRAINT chk_membership_scope
        CHECK (
            (scope_type = 'platform' AND merchant_id IS NULL AND store_id IS NULL)
            OR (scope_type = 'merchant' AND merchant_id IS NOT NULL AND store_id IS NULL)
            OR (scope_type = 'store' AND merchant_id IS NOT NULL AND store_id IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS operator_memberships_operator_idx
    ON app.operator_memberships(operator_id, status);
CREATE INDEX IF NOT EXISTS operator_memberships_merchant_idx
    ON app.operator_memberships(merchant_id, status)
    WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS operator_memberships_store_idx
    ON app.operator_memberships(store_id, status)
    WHERE store_id IS NOT NULL;

-- ── Tenant envelope columns on shared cross-cutting tables ────────────
-- audit.events: keep organization_id as legacy key; add nullable tenant ids.
ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS store_id TEXT;
CREATE INDEX IF NOT EXISTS audit_merchant_subject_idx
    ON audit.events(merchant_id, subject_type, subject_id, created_at DESC)
    WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_store_subject_idx
    ON audit.events(store_id, subject_type, subject_id, created_at DESC)
    WHERE store_id IS NOT NULL;

-- outbox.events: tenant envelope. payload still owns the business values.
ALTER TABLE outbox.events ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE outbox.events ADD COLUMN IF NOT EXISTS store_id TEXT;
CREATE INDEX IF NOT EXISTS outbox_events_merchant_pending_idx
    ON outbox.events(merchant_id, created_at)
    WHERE merchant_id IS NOT NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS outbox_events_store_idx
    ON outbox.events(store_id, created_at)
    WHERE store_id IS NOT NULL;

-- app.idempotency_records: tenant + operation + key future uniqueness.
-- Legacy idempotency_key remains globally unique (unchanged) for backward
-- compatibility; the new (tenant_id, operation, idempotency_key) tuple is
-- added as a separate partial unique index that takes over for new code.
ALTER TABLE app.idempotency_records ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE app.idempotency_records ADD COLUMN IF NOT EXISTS operation TEXT;
-- allow operation field to be a short stable code; legacy rows leave it NULL.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_idempotency_operation_format'
    ) THEN
        ALTER TABLE app.idempotency_records
            ADD CONSTRAINT chk_idempotency_operation_format
            CHECK (operation IS NULL OR (operation <> '' AND operation = lower(operation)));
    END IF;
END $$;
-- Unique scoped key: one stored response per tenant + operation + key.
-- Legacy rows (tenant_id/operation NULL) are excluded from this index so the
-- existing global idempotency_key uniqueness continues to apply.
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_records_tenant_op_key_unique_idx
    ON app.idempotency_records(tenant_id, operation, idempotency_key)
    WHERE tenant_id IS NOT NULL AND operation IS NOT NULL;
CREATE INDEX IF NOT EXISTS idempotency_records_tenant_idx
    ON app.idempotency_records(tenant_id, created_at)
    WHERE tenant_id IS NOT NULL;

-- ── Nullable tenant columns on the ownership matrix ───────────────────
-- Catalog / category / price — merchant-scoped per ownership matrix.
ALTER TABLE public.product ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE public.product_category ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE public.price_set ADD COLUMN IF NOT EXISTS merchant_id TEXT;

-- Customer / loyalty profile — merchant-scoped.
ALTER TABLE public.customer ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE ai_module.customer_profiles ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE ai_module.loyalty_records ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE ai_module.loyalty_tiers ADD COLUMN IF NOT EXISTS merchant_id TEXT;

-- Retail orders and order summaries — store + merchant scoped.
ALTER TABLE public."order" ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE public."order" ADD COLUMN IF NOT EXISTS store_id TEXT;

-- Payment entries — purpose-aware; retail is store-scoped.
ALTER TABLE app.payment_entries ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE app.payment_entries ADD COLUMN IF NOT EXISTS store_id TEXT;

DO $$
BEGIN
    IF to_regclass('app.payment_intents') IS NOT NULL THEN
        ALTER TABLE app.payment_intents ADD COLUMN IF NOT EXISTS merchant_id TEXT;
        ALTER TABLE app.payment_intents ADD COLUMN IF NOT EXISTS store_id TEXT;
    END IF;
    IF to_regclass('app.payment_provider_events') IS NOT NULL THEN
        ALTER TABLE app.payment_provider_events ADD COLUMN IF NOT EXISTS merchant_id TEXT;
        ALTER TABLE app.payment_provider_events ADD COLUMN IF NOT EXISTS store_id TEXT;
    END IF;
END $$;

-- Purchase orders — store scoped (receiving targets exactly one store/loc).
ALTER TABLE inventory.purchase_orders ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE inventory.purchase_orders ADD COLUMN IF NOT EXISTS store_id TEXT;

-- Inventory product settings — merchant scoped (catalog ownership).
ALTER TABLE inventory.product_settings ADD COLUMN IF NOT EXISTS merchant_id TEXT;

-- Stock movements — store scoped via store binding (location already present
-- on public.inventory_level; we add store_id here for read filtering).
ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE medusa.stock_movements ADD COLUMN IF NOT EXISTS store_id TEXT;

-- Accounting journal entries — merchant + optional store (retail only).
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE accounting.journal_entries ADD COLUMN IF NOT EXISTS store_id TEXT;

-- AI actions / research context — merchant + optional store.
ALTER TABLE ai_module.actions ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE ai_module.actions ADD COLUMN IF NOT EXISTS store_id TEXT;

DO $$
BEGIN
    IF to_regclass('ai_module.product_research_runs') IS NOT NULL THEN
        ALTER TABLE ai_module.product_research_runs ADD COLUMN IF NOT EXISTS merchant_id TEXT;
        ALTER TABLE ai_module.product_research_runs ADD COLUMN IF NOT EXISTS store_id TEXT;
    END IF;
END $$;

-- Notifications / channel sessions — tenant aware.
ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS store_id TEXT;
ALTER TABLE app.operator_identities ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE app.bot_sessions ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE app.bot_sessions ADD COLUMN IF NOT EXISTS store_id TEXT;

-- ── Supporting indexes on the tenant columns ──────────────────────────
-- Catalog
CREATE INDEX IF NOT EXISTS product_merchant_idx
    ON public.product(merchant_id) WHERE merchant_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS product_category_merchant_idx
    ON public.product_category(merchant_id) WHERE merchant_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS price_set_merchant_idx
    ON public.price_set(merchant_id) WHERE merchant_id IS NOT NULL AND deleted_at IS NULL;

-- Customer / loyalty
CREATE INDEX IF NOT EXISTS customer_merchant_idx
    ON public.customer(merchant_id) WHERE merchant_id IS NOT NULL AND deleted_at IS NULL;
-- Per-merchant phone uniqueness is the eventual invariant; here we add a
-- partial unique index scoped to rows that have been backfilled to a merchant.
CREATE UNIQUE INDEX IF NOT EXISTS customer_merchant_phone_unique_idx
    ON public.customer(merchant_id, phone)
    WHERE merchant_id IS NOT NULL AND deleted_at IS NULL AND phone IS NOT NULL AND phone <> '';
CREATE INDEX IF NOT EXISTS customer_profiles_merchant_idx
    ON ai_module.customer_profiles(merchant_id) WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS loyalty_records_merchant_idx
    ON ai_module.loyalty_records(merchant_id, created_at DESC) WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS loyalty_tiers_merchant_idx
    ON ai_module.loyalty_tiers(merchant_id) WHERE merchant_id IS NOT NULL;

-- Orders
CREATE INDEX IF NOT EXISTS order_merchant_idx
    ON public."order"(merchant_id) WHERE merchant_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS order_store_idx
    ON public."order"(store_id) WHERE store_id IS NOT NULL AND deleted_at IS NULL;

-- Payments
CREATE INDEX IF NOT EXISTS payment_entries_merchant_idx
    ON app.payment_entries(merchant_id, created_at DESC) WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_entries_store_idx
    ON app.payment_entries(store_id, created_at DESC) WHERE store_id IS NOT NULL;

DO $$
BEGIN
    IF to_regclass('app.payment_intents') IS NOT NULL THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS payment_intents_merchant_idx ON app.payment_intents(merchant_id, created_at DESC) WHERE merchant_id IS NOT NULL';
        EXECUTE 'CREATE INDEX IF NOT EXISTS payment_intents_store_idx ON app.payment_intents(store_id, created_at DESC) WHERE store_id IS NOT NULL';
    END IF;
    IF to_regclass('app.payment_provider_events') IS NOT NULL THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS payment_provider_events_merchant_idx ON app.payment_provider_events(merchant_id, received_at DESC) WHERE merchant_id IS NOT NULL';
        EXECUTE 'CREATE INDEX IF NOT EXISTS payment_provider_events_store_idx ON app.payment_provider_events(store_id, received_at DESC) WHERE store_id IS NOT NULL';
    END IF;
END $$;

-- Purchase orders
CREATE INDEX IF NOT EXISTS purchase_orders_store_idx
    ON inventory.purchase_orders(store_id) WHERE store_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_orders_merchant_idx
    ON inventory.purchase_orders(merchant_id) WHERE merchant_id IS NOT NULL;

-- Stock movements
CREATE INDEX IF NOT EXISTS stock_movements_store_idx
    ON medusa.stock_movements(store_id, created_at DESC) WHERE store_id IS NOT NULL;

-- Accounting
CREATE INDEX IF NOT EXISTS journal_entries_merchant_idx
    ON accounting.journal_entries(merchant_id) WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_entries_store_idx
    ON accounting.journal_entries(store_id) WHERE store_id IS NOT NULL;

-- AI actions
CREATE INDEX IF NOT EXISTS ai_actions_merchant_idx
    ON ai_module.actions(merchant_id, created_at DESC) WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_actions_store_idx
    ON ai_module.actions(store_id, created_at DESC) WHERE store_id IS NOT NULL;

DO $$
BEGIN
    IF to_regclass('ai_module.product_research_runs') IS NOT NULL THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS product_research_runs_merchant_idx ON ai_module.product_research_runs(merchant_id, created_at DESC) WHERE merchant_id IS NOT NULL';
        EXECUTE 'CREATE INDEX IF NOT EXISTS product_research_runs_store_idx ON ai_module.product_research_runs(store_id, created_at DESC) WHERE store_id IS NOT NULL';
    END IF;
END $$;

-- Notifications / sessions
CREATE INDEX IF NOT EXISTS telegram_notifications_merchant_idx
    ON notification.telegram_notifications(merchant_id, created_at)
    WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_sessions_merchant_idx
    ON app.bot_sessions(merchant_id, provider, updated_at DESC)
    WHERE merchant_id IS NOT NULL;

-- ── Backfill helper view: org_default legacy compatibility ────────────
-- Convenience view used by 003 and by compatibility reads. It maps the
-- legacy organization id to the (merchant_id, store_id, stock_location_id)
-- triple. Rows without a merchant mapping remain reachable via
-- organization_id only during the compatibility phase.
CREATE OR REPLACE VIEW app.legacy_organization_binding AS
SELECT
    m.id AS merchant_id,
    s.id AS store_id,
    s.stock_location_id,
    m.legacy_organization_id AS organization_id
FROM app.merchants m
JOIN app.stores s ON s.merchant_id = m.id AND s.is_primary = true;
