-- 015_stock_movement_stock_location.sql
-- Release 1.1.2 — Add stock_location_id provenance to medusa.stock_movements.
-- Agent 19 Corrective Round 2.
--
-- Contract references:
--   docs/07-release-audits/1.1.2-in-dev/multi-agent-implementation-plan.md (W11)
--   packages/application/src/services/inventory-service.ts (adjustStock)
--   packages/application/src/services/order-service.ts (completeSale,
--     buildFoundStockAdjustments, cancelOrder, createRemoteOrder)
--   packages/application/src/services/order-correction-service.ts
--     (applyOrderCorrection)
--
-- Background: Migrations 002 and 013 added merchant_id and store_id to
-- medusa.stock_movements but never added stock_location_id. The order-side
-- stock writes (completeSale, found-stock, cancel, correction) therefore
-- produced rows without the captured stock location, and listStockMovements
-- had to fall back on a LEFT JOIN to public.inventory_level to find the
-- "any level" for the caller's store. That fallback leaked cross-store
-- movements whenever a row's store_id was NULL.
--
-- This migration is forward-only, repeat-safe, and preserves historical rows:
--   * New column is nullable so legacy rows are intact.
--   * Add a NOT VALID foreign key (proven safe by the restore-drill evidence
--     on a fresh DB; movement creation already filters by il.location_id).
--   * Create a stock_location index for fast filter by store + location.
--
-- Safety rules (Agent 1 conventions):
--   * The stock movement change is additive. The only DROP replaces the
--     legacy global loyalty-tier name constraint with tenant-scoped
--     uniqueness; it does not delete or rewrite data.
--   * CREATE/ADD IF NOT EXISTS so re-running this file is a no-op.
--   * Historical rows are backfilled only when their stamped store resolves
--     deterministically to one stock location.

ALTER TABLE medusa.stock_movements
    ADD COLUMN IF NOT EXISTS stock_location_id TEXT;

-- Loyalty tiers are merchant policy. Migration 001's global UNIQUE(name)
-- prevents two merchants from having the normal bronze/silver/gold set.
ALTER TABLE ai_module.loyalty_tiers
    DROP CONSTRAINT IF EXISTS loyalty_tiers_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_tiers_merchant_name_unique_idx
    ON ai_module.loyalty_tiers(merchant_id, name)
    WHERE merchant_id IS NOT NULL;

UPDATE medusa.stock_movements sm
SET stock_location_id = s.stock_location_id
FROM app.stores s
WHERE sm.stock_location_id IS NULL
  AND sm.store_id = s.id
  AND sm.merchant_id = s.merchant_id
  AND s.stock_location_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_movements_store_location_idx
    ON medusa.stock_movements(store_id, stock_location_id, created_at DESC)
    WHERE store_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'stock_movements_stock_location_fk'
    ) THEN
        ALTER TABLE medusa.stock_movements
            ADD CONSTRAINT stock_movements_stock_location_fk
            FOREIGN KEY (stock_location_id)
            REFERENCES public.stock_location(id)
            ON UPDATE CASCADE
            NOT VALID;
    END IF;
END $$;

ALTER TABLE medusa.stock_movements
    VALIDATE CONSTRAINT stock_movements_stock_location_fk;

-- Read guards added in Agent 19 require durable DB grants as well as typed
-- contract defaults. Without these rows, a fresh database with explicit
-- memberships would deny otherwise valid Basic POS reads.
INSERT INTO app.permissions (id, description) VALUES
    ('catalog:read', 'Read merchant catalog data'),
    ('customer:read', 'Read merchant customer data'),
    ('loyalty:read', 'Read merchant loyalty data')
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO app.role_permissions (role, permission_id) VALUES
    ('staff', 'catalog:read'),
    ('staff', 'customer:read'),
    ('manager', 'catalog:read'),
    ('manager', 'customer:read'),
    ('manager', 'loyalty:read'),
    ('owner', 'catalog:read'),
    ('owner', 'customer:read'),
    ('owner', 'loyalty:read')
ON CONFLICT (role, permission_id) DO NOTHING;
