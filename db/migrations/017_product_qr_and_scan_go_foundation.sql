-- 017_product_qr_and_scan_go_foundation.sql
-- Phase 1.3 — Product QR identity foundation.
--
-- This migration is additive and repeat-safe. It introduces the stable product
-- QR identity printed on shelf/product tags plus lightweight scan events for
-- internal resolver and later Scan & Go analytics. It does not create orders,
-- payments, or stock movements.

CREATE TABLE IF NOT EXISTS app.product_qr_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
    product_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    public_url_path TEXT NOT NULL,
    payload_version INT NOT NULL DEFAULT 1,
    print_version INT NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    disabled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS product_qr_codes_slug_unique_idx
    ON app.product_qr_codes(slug);

CREATE UNIQUE INDEX IF NOT EXISTS product_qr_codes_store_variant_unique_idx
    ON app.product_qr_codes(merchant_id, store_id, variant_id);

CREATE INDEX IF NOT EXISTS product_qr_codes_product_idx
    ON app.product_qr_codes(merchant_id, store_id, product_id);

CREATE TABLE IF NOT EXISTS app.product_qr_scan_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    qr_code_id UUID REFERENCES app.product_qr_codes(id) ON DELETE SET NULL,
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
    context TEXT NOT NULL,
    actor_type TEXT NOT NULL DEFAULT 'staff',
    actor_id TEXT,
    result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_qr_scan_events_scope_time_idx
    ON app.product_qr_scan_events(merchant_id, store_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS product_qr_scan_events_qr_time_idx
    ON app.product_qr_scan_events(qr_code_id, scanned_at DESC);

CREATE TABLE IF NOT EXISTS app.scan_go_carts (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'redeemed', 'expired', 'cancelled')),
    merchant_slug TEXT NOT NULL,
    store_slug TEXT NOT NULL,
    customer_nickname TEXT,
    customer_contact TEXT,
    contact_type TEXT CHECK (contact_type IN ('whatsapp', 'email', 'phone')),
    age_acknowledged_at TIMESTAMPTZ NOT NULL,
    edit_secret_hash TEXT,
    token_hash TEXT UNIQUE,
    token_generated_at TIMESTAMPTZ,
    token_expires_at TIMESTAMPTZ,
    redeemed_at TIMESTAMPTZ,
    redeemed_by_operator_id TEXT,
    redeemed_order_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE app.scan_go_carts
    ADD COLUMN IF NOT EXISTS redeemed_order_id TEXT;

ALTER TABLE app.scan_go_carts
    ADD COLUMN IF NOT EXISTS edit_secret_hash TEXT;

CREATE INDEX IF NOT EXISTS scan_go_carts_scope_status_idx
    ON app.scan_go_carts(merchant_id, store_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS scan_go_carts_token_hash_idx
    ON app.scan_go_carts(token_hash)
    WHERE token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS scan_go_carts_redeemed_order_idx
    ON app.scan_go_carts(redeemed_order_id)
    WHERE redeemed_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.scan_go_cart_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id TEXT NOT NULL REFERENCES app.scan_go_carts(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    qr_slug TEXT,
    sku TEXT NOT NULL DEFAULT '',
    barcode TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price_vnd NUMERIC(20,0) NOT NULL CHECK (unit_price_vnd >= 0),
    product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cart_id, variant_id)
);

CREATE INDEX IF NOT EXISTS scan_go_cart_items_cart_idx
    ON app.scan_go_cart_items(cart_id);

CREATE INDEX IF NOT EXISTS product_variant_sku_lower_active_idx
    ON public.product_variant (LOWER(sku))
    WHERE deleted_at IS NULL AND sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_variant_barcode_lower_active_idx
    ON public.product_variant (LOWER(barcode))
    WHERE deleted_at IS NULL AND barcode IS NOT NULL;
