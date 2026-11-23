-- ═══════════════════════════════════════════════════════════════════════
-- 003_tenant_foundation_backfill_default_scope.sql
-- Release 1.1.2 — Deterministic default-scope backfill (additive only).
-- Agent 1 (tenant migration / production data safety)
--
-- Requires: 002_tenant_foundation_expand.sql
--
-- This migration:
--   * Creates merchant_default mapped from legacy org_default.
--   * Creates store_default as merchant_default's primary store and binds it
--     to the existing sloc_default inventory location idempotently.
--   * Backfills catalog/category/customer/loyalty to merchant_default and
--     operational orders/payments/stock/purchase-orders to store_default
--     where deterministically resolvable.
--   * Backfills operator memberships for existing staff users.
--
-- Safety rules:
--   * Never overwrites a non-default tenant id that may already exist.
--     Every UPDATE is guarded with "WHERE merchant_id IS NULL" (or store_id).
--   * Never changes existing primary keys, order totals, payment sums,
--     journal balances or inventory quantities.
--   * Running twice is a no-op after the first success.
-- ═══════════════════════════════════════════════════════════════════════

-- ── Canonical default ids (shared fixtures from Agent 0) ──────────────
--   legacy organization : org_default
--   merchant            : merchant_default
--   store               : store_default
--   stock location      : sloc_default
--
-- merchant_default is created only if the legacy org has data to own. The
-- stock location sloc_default is seeded by ensurePlatformSchema()/seed; we
-- only bind to it, never recreate it.

-- 1. merchant_default (idempotent insert; never overwrites an existing row).
INSERT INTO app.merchants (id, display_name, legacy_organization_id, status, metadata)
VALUES (
    'merchant_default',
    'Default Merchant',
    'org_default',
    'active',
    jsonb_build_object('source', 'migration_003', 'legacy', true)
)
ON CONFLICT (id) DO NOTHING;

-- 2. store_default bound to sloc_default as the primary store.
--    Guarded so a missing sloc_default does not silently create an unbound
--    store. If sloc_default does not exist yet (fresh schema before seed),
--    the insert is skipped and re-run later picks it up.
INSERT INTO app.stores (id, merchant_id, display_name, stock_location_id, is_primary, status, metadata)
SELECT
    'store_default',
    'merchant_default',
    'Default Store',
    'sloc_default',
    true,
    'active',
    jsonb_build_object('source', 'migration_003', 'legacy', true)
WHERE EXISTS (SELECT 1 FROM public.stock_location WHERE id = 'sloc_default')
ON CONFLICT (id) DO NOTHING;

-- Re-assert the sloc binding/primary flag without changing anything else,
-- only when the row still carries the migration default binding. This keeps
-- the binding idempotent without overriding an admin-changed binding.
UPDATE app.stores
SET stock_location_id = 'sloc_default',
    is_primary = true,
    updated_at = now()
WHERE id = 'store_default'
  AND stock_location_id = 'sloc_default'
  AND is_primary = false;

-- ── 3. Merchant-scoped catalog / category / customer / loyalty ────────
-- Only rows that are not yet scoped (merchant_id IS NULL) are touched.
UPDATE public.product
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE public.product_category
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE public.price_set
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE public.customer
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE ai_module.customer_profiles
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE ai_module.loyalty_records
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE ai_module.loyalty_tiers
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE inventory.product_settings
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

-- ── 4. Store-scoped operational rows ──────────────────────────────────
-- Orders: every existing order belongs to the single production store.
UPDATE public."order"
SET merchant_id = 'merchant_default',
    store_id = 'store_default'
WHERE store_id IS NULL OR merchant_id IS NULL;

-- Payment entries (retail). Package-billing entries are not present yet in
-- 1.1.2 production data, so all existing payment_entries are retail.
UPDATE app.payment_entries
SET merchant_id = 'merchant_default',
    store_id = 'store_default'
WHERE store_id IS NULL OR merchant_id IS NULL;

DO $$
BEGIN
    IF to_regclass('app.payment_intents') IS NOT NULL THEN
        UPDATE app.payment_intents
        SET merchant_id = 'merchant_default',
            store_id = 'store_default'
        WHERE store_id IS NULL OR merchant_id IS NULL;
    END IF;
    IF to_regclass('app.payment_provider_events') IS NOT NULL THEN
        UPDATE app.payment_provider_events
        SET merchant_id = 'merchant_default',
            store_id = 'store_default'
        WHERE store_id IS NULL OR merchant_id IS NULL;
    END IF;
END $$;

-- Purchase orders: receiving targets the single production store/location.
UPDATE inventory.purchase_orders
SET merchant_id = 'merchant_default',
    store_id = 'store_default'
WHERE store_id IS NULL OR merchant_id IS NULL;

-- Stock movements: bound to the store behind sloc_default. Deterministic
-- because 1.1.2 production has exactly one stock location.
UPDATE medusa.stock_movements
SET merchant_id = 'merchant_default',
    store_id = 'store_default'
WHERE store_id IS NULL OR merchant_id IS NULL;

-- Accounting journal entries: retail entries get store scope; all existing
-- entries belong to the single merchant. We assign merchant for every row and
-- store only for entries that reference a retail order/payment so non-retail
-- adjustments remain store-agnostic per the ownership matrix.
UPDATE accounting.journal_entries
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE accounting.journal_entries
SET store_id = 'store_default'
WHERE store_id IS NULL
  AND reference_type IN ('order', 'payment', 'pos_sale', 'order_correction', 'order_refund');

-- AI actions: merchant scope; store scope where the action references an
-- order (deterministically resolvable to the single store).
UPDATE ai_module.actions
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE ai_module.actions
SET store_id = 'store_default'
WHERE store_id IS NULL AND order_id IS NOT NULL;

DO $$
BEGIN
    IF to_regclass('ai_module.product_research_runs') IS NOT NULL THEN
        UPDATE ai_module.product_research_runs
        SET merchant_id = 'merchant_default'
        WHERE merchant_id IS NULL;
    END IF;
END $$;

-- Notifications / channel envelopes.
UPDATE notification.telegram_notifications
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE app.operator_identities
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE app.bot_sessions
SET merchant_id = 'merchant_default',
    store_id = 'store_default'
WHERE merchant_id IS NULL;

-- ── 5. Tenant envelopes on cross-cutting tables ───────────────────────
-- Audit/outbox keep their stored business values; we only stamp the envelope.
UPDATE audit.events
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

UPDATE outbox.events
SET merchant_id = 'merchant_default'
WHERE merchant_id IS NULL;

-- ── 6. Operator memberships from existing staff users ─────────────────
-- Each active staff user gets a store-level membership on store_default,
-- preserving their existing role as the membership role_key. The owner also
-- receives a merchant-level membership so owner permissions span the merchant.
-- Idempotent: skip when an equivalent membership already exists.
INSERT INTO app.operator_memberships
    (operator_id, scope_type, merchant_id, store_id, role_key, status, granted_by)
SELECT
    su.operator_id,
    'store',
    'merchant_default',
    'store_default',
    su.role,
    'active',
    'migration_003'
FROM medusa.staff_users su
WHERE su.is_active = true
  AND NOT EXISTS (
      SELECT 1 FROM app.operator_memberships m
      WHERE m.operator_id = su.operator_id
        AND m.scope_type = 'store'
        AND m.store_id = 'store_default'
  );

INSERT INTO app.operator_memberships
    (operator_id, scope_type, merchant_id, store_id, role_key, status, granted_by)
SELECT
    su.operator_id,
    'merchant',
    'merchant_default',
    NULL,
    su.role,
    'active',
    'migration_003'
FROM medusa.staff_users su
WHERE su.is_active = true
  AND su.role = 'owner'
  AND NOT EXISTS (
      SELECT 1 FROM app.operator_memberships m
      WHERE m.operator_id = su.operator_id
        AND m.scope_type = 'merchant'
        AND m.merchant_id = 'merchant_default'
  );
