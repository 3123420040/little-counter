-- 023_inventory_stock_history_metadata.sql
-- Add owner-grade stock history metadata to medusa.stock_movements.
--
-- Additive and repeat-safe:
--   * Existing stock movement rows remain valid.
--   * Snapshot columns are nullable so legacy rows can be backfilled best-effort.
--   * Existing movement_type/reference_type/reference_id consumers remain compatible.

ALTER TABLE medusa.stock_movements
  ADD COLUMN IF NOT EXISTS product_id TEXT,
  ADD COLUMN IF NOT EXISTS variant_id TEXT,
  ADD COLUMN IF NOT EXISTS sku_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS product_title_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS source_action TEXT,
  ADD COLUMN IF NOT EXISTS reason_code TEXT,
  ADD COLUMN IF NOT EXISTS reference_display TEXT,
  ADD COLUMN IF NOT EXISTS actor_display_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS actor_role_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS actual_operator_id TEXT,
  ADD COLUMN IF NOT EXISTS source_channel TEXT,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE medusa.stock_movements sm
SET
  product_id = COALESCE(sm.product_id, v.product_id),
  variant_id = COALESCE(sm.variant_id, v.id),
  sku_snapshot = COALESCE(sm.sku_snapshot, v.sku, ii.sku, ''),
  product_title_snapshot = COALESCE(sm.product_title_snapshot, p.title, ii.title, ''),
  metadata = COALESCE(sm.metadata, '{}'::jsonb) || jsonb_build_object('historyQuality', 'backfilled')
FROM public.inventory_item ii
LEFT JOIN public.product_variant_inventory_item vii
  ON vii.inventory_item_id = ii.id
 AND vii.deleted_at IS NULL
LEFT JOIN public.product_variant v
  ON v.id = vii.variant_id
 AND v.deleted_at IS NULL
LEFT JOIN public.product p
  ON p.id = v.product_id
 AND p.deleted_at IS NULL
WHERE sm.inventory_item_id = ii.id
  AND (
    sm.product_id IS NULL
    OR sm.variant_id IS NULL
    OR sm.sku_snapshot IS NULL
    OR sm.product_title_snapshot IS NULL
  );

UPDATE medusa.stock_movements sm
SET
  actor_display_name_snapshot = COALESCE(sm.actor_display_name_snapshot, su.display_name),
  actor_role_snapshot = COALESCE(sm.actor_role_snapshot, su.role),
  metadata = COALESCE(sm.metadata, '{}'::jsonb) || jsonb_build_object('historyQuality', 'backfilled')
FROM medusa.staff_users su
WHERE sm.performed_by = su.operator_id
  AND (
    sm.actor_display_name_snapshot IS NULL
    OR sm.actor_role_snapshot IS NULL
  );

UPDATE medusa.stock_movements
SET
  source_action = COALESCE(
    source_action,
    CASE
      WHEN movement_type = 'sale' THEN 'pos_sale'
      WHEN movement_type = 'purchase_receipt' THEN 'po_receive'
      WHEN movement_type = 'return' THEN 'return'
      WHEN reference_type = 'order_correction' THEN 'order_correction'
      WHEN reference_type = 'order_found_stock' THEN 'found_stock'
      WHEN movement_type = 'manual_adjustment' THEN 'manual_adjustment'
      ELSE movement_type
    END
  ),
  reason_code = COALESCE(reason_code, reason, movement_type),
  reference_display = COALESCE(reference_display, reference_id),
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('historyQuality', 'backfilled')
WHERE source_action IS NULL
   OR reason_code IS NULL
   OR reference_display IS NULL
   OR NOT COALESCE(metadata, '{}'::jsonb) ? 'historyQuality';

CREATE INDEX IF NOT EXISTS stock_movements_scope_item_created_idx
  ON medusa.stock_movements(merchant_id, store_id, stock_location_id, inventory_item_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS stock_movements_scope_product_created_idx
  ON medusa.stock_movements(merchant_id, store_id, stock_location_id, product_id, created_at DESC, id DESC)
  WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_movements_scope_action_created_idx
  ON medusa.stock_movements(merchant_id, store_id, stock_location_id, movement_type, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS stock_movements_scope_actor_created_idx
  ON medusa.stock_movements(merchant_id, store_id, stock_location_id, performed_by, created_at DESC, id DESC);
