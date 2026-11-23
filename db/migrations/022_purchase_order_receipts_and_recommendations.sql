-- 022_purchase_order_receipts_and_recommendations.sql
-- Purchase order detail/line receiving hardening.
-- Additive migration: keeps purchase_order_items.received_quantity as the
-- aggregate read model while adding first-class receipt batches for audit and
-- receipt-level accounting idempotency.

ALTER TABLE inventory.purchase_orders
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_by TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by TEXT,
  ADD COLUMN IF NOT EXISTS close_reason TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE inventory.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_status_check;

ALTER TABLE inventory.purchase_orders
  ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('draft', 'sent', 'partially_received', 'received', 'cancelled', 'closed_short'));

ALTER TABLE inventory.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_source_check;

ALTER TABLE inventory.purchase_orders
  ADD CONSTRAINT purchase_orders_source_check
  CHECK (source IN ('manual', 'csv_import', 'recommendation_csv', 'system_backfill'));

ALTER TABLE inventory.purchase_order_items
  ADD COLUMN IF NOT EXISTS sku_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS product_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS category_names_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS inventory.purchase_order_receipts (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL REFERENCES inventory.purchase_orders(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  stock_location_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by TEXT NOT NULL,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'web_pos'
    CHECK (source IN ('web_pos', 'csv_import', 'system_backfill')),
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purchase_order_receipts_po_time_idx
  ON inventory.purchase_order_receipts(purchase_order_id, received_at DESC);

CREATE INDEX IF NOT EXISTS purchase_order_receipts_scope_time_idx
  ON inventory.purchase_order_receipts(merchant_id, store_id, received_at DESC);

CREATE TABLE IF NOT EXISTS inventory.purchase_order_receipt_items (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES inventory.purchase_order_receipts(id) ON DELETE CASCADE,
  purchase_order_item_id TEXT NOT NULL REFERENCES inventory.purchase_order_items(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  inventory_item_id TEXT NOT NULL,
  quantity_received INT NOT NULL CHECK (quantity_received > 0),
  unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  inventory_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantity_after INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purchase_order_receipt_items_receipt_idx
  ON inventory.purchase_order_receipt_items(receipt_id);

CREATE INDEX IF NOT EXISTS purchase_order_receipt_items_po_item_idx
  ON inventory.purchase_order_receipt_items(purchase_order_item_id);

UPDATE inventory.purchase_order_items poi
SET
  sku_snapshot = COALESCE(v.sku, poi.sku_snapshot, ''),
  product_name_snapshot = COALESCE(p.title, poi.product_name_snapshot, ''),
  category_names_snapshot = COALESCE(cat.category_names, poi.category_names_snapshot, '[]'::jsonb),
  updated_at = now()
FROM public.product_variant v
JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT COALESCE(jsonb_agg(pc.name ORDER BY pc.rank ASC, pc.name ASC), '[]'::jsonb) AS category_names
  FROM public.product_category_product pcp
  JOIN public.product_category pc ON pc.id = pcp.product_category_id AND pc.deleted_at IS NULL
  WHERE pcp.product_id = p.id
) cat ON true
WHERE v.id = poi.variant_id
  AND v.deleted_at IS NULL
  AND (poi.sku_snapshot IS NULL OR poi.product_name_snapshot IS NULL OR poi.category_names_snapshot = '[]'::jsonb);

INSERT INTO inventory.purchase_order_receipts (
  id, purchase_order_id, merchant_id, store_id, stock_location_id,
  received_at, received_by, note, source, created_at
)
SELECT
  'por_legacy_' || po.id,
  po.id,
  po.merchant_id,
  po.store_id,
  COALESCE(s.stock_location_id, 'sloc_default'),
  COALESCE(po.updated_at, po.created_at, now()),
  COALESCE(po.created_by, 'system'),
  'Backfilled from aggregate received_quantity',
  'system_backfill',
  now()
FROM inventory.purchase_orders po
LEFT JOIN app.stores s ON s.id = po.store_id AND s.merchant_id = po.merchant_id
WHERE po.merchant_id IS NOT NULL
  AND po.store_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM inventory.purchase_order_items poi
    WHERE poi.purchase_order_id = po.id
      AND poi.received_quantity > 0
  )
  AND NOT EXISTS (
    SELECT 1
    FROM inventory.purchase_order_receipts por
    WHERE por.purchase_order_id = po.id
  );

INSERT INTO inventory.purchase_order_receipt_items (
  id, receipt_id, purchase_order_item_id, variant_id, inventory_item_id,
  quantity_received, unit_cost, inventory_value, quantity_after, created_at
)
SELECT
  'pori_legacy_' || poi.id,
  'por_legacy_' || po.id,
  poi.id,
  poi.variant_id,
  vii.inventory_item_id,
  poi.received_quantity,
  poi.unit_cost,
  poi.received_quantity * poi.unit_cost,
  COALESCE(il.stocked_quantity::int, 0),
  now()
FROM inventory.purchase_order_items poi
JOIN inventory.purchase_orders po ON po.id = poi.purchase_order_id
JOIN public.product_variant_inventory_item vii ON vii.variant_id = poi.variant_id AND vii.deleted_at IS NULL
LEFT JOIN app.stores s ON s.id = po.store_id AND s.merchant_id = po.merchant_id
LEFT JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id
  AND il.location_id = COALESCE(s.stock_location_id, 'sloc_default')
  AND il.deleted_at IS NULL
WHERE poi.received_quantity > 0
  AND po.merchant_id IS NOT NULL
  AND po.store_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM inventory.purchase_order_receipts por
    WHERE por.id = 'por_legacy_' || po.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM inventory.purchase_order_receipt_items pori
    WHERE pori.purchase_order_item_id = poi.id
  );
