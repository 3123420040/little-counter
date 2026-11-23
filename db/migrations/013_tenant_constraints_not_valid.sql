-- 013_tenant_constraints_not_valid.sql
-- Release 1.1.2 — Proven-safe tenant binding constraints.
-- Agent 17 (tenant constraint hardening / restore-drill evidence).
--
-- The fixture restore audit proved these relationships contain no orphans.
-- Constraints are introduced as NOT VALID to avoid an eager table rewrite,
-- then validated explicitly. New writes are protected as soon as each
-- constraint is installed. Nullable legacy/scope_unknown rows remain valid.
--
-- Deliberately deferred: order/payment/provider/research tenant FKs and every
-- tenant NOT NULL conversion. The fixture contains unresolved historical or
-- test rows in those surfaces, so enforcing them would not be evidence-based.

CREATE UNIQUE INDEX IF NOT EXISTS stores_merchant_id_id_unique_idx
    ON app.stores(merchant_id, id);

CREATE INDEX IF NOT EXISTS operator_memberships_merchant_store_idx
    ON app.operator_memberships(merchant_id, store_id)
    WHERE store_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS purchase_orders_merchant_store_idx
    ON inventory.purchase_orders(merchant_id, store_id)
    WHERE store_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_movements_merchant_store_idx
    ON medusa.stock_movements(merchant_id, store_id)
    WHERE store_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'app.stores'::regclass
          AND conname = 'stores_stock_location_fk'
    ) THEN
        ALTER TABLE app.stores
            ADD CONSTRAINT stores_stock_location_fk
            FOREIGN KEY (stock_location_id)
            REFERENCES public.stock_location(id)
            ON UPDATE CASCADE
            NOT VALID;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'app.operator_memberships'::regclass
          AND conname = 'operator_memberships_store_merchant_fk'
    ) THEN
        ALTER TABLE app.operator_memberships
            ADD CONSTRAINT operator_memberships_store_merchant_fk
            FOREIGN KEY (merchant_id, store_id)
            REFERENCES app.stores(merchant_id, id)
            ON UPDATE CASCADE
            NOT VALID;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'inventory.purchase_orders'::regclass
          AND conname = 'purchase_orders_store_merchant_fk'
    ) THEN
        ALTER TABLE inventory.purchase_orders
            ADD CONSTRAINT purchase_orders_store_merchant_fk
            FOREIGN KEY (merchant_id, store_id)
            REFERENCES app.stores(merchant_id, id)
            ON UPDATE CASCADE
            NOT VALID;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'medusa.stock_movements'::regclass
          AND conname = 'stock_movements_store_merchant_fk'
    ) THEN
        ALTER TABLE medusa.stock_movements
            ADD CONSTRAINT stock_movements_store_merchant_fk
            FOREIGN KEY (merchant_id, store_id)
            REFERENCES app.stores(merchant_id, id)
            ON UPDATE CASCADE
            NOT VALID;
    END IF;
END $$;

ALTER TABLE app.stores
    VALIDATE CONSTRAINT stores_stock_location_fk;
ALTER TABLE app.operator_memberships
    VALIDATE CONSTRAINT operator_memberships_store_merchant_fk;
ALTER TABLE inventory.purchase_orders
    VALIDATE CONSTRAINT purchase_orders_store_merchant_fk;
ALTER TABLE medusa.stock_movements
    VALIDATE CONSTRAINT stock_movements_store_merchant_fk;
