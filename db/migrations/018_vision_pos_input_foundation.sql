-- 018_vision_pos_input_foundation.sql
-- Release 1.4 — Vision-assisted POS product input foundation.
--
-- Additive and repeat-safe. This migration stores product reference images,
-- provider index state, scan outcomes, and staff corrections. It does not
-- create orders, payments, stock movements, or cart mutations.

INSERT INTO app.permissions (id, description) VALUES
    ('vision_scan:use', 'Use vision-assisted product input in POS'),
    ('vision_scan:read', 'Read vision scan events and outcomes'),
    ('vision_catalog:write', 'Manage vision catalog reference images and provider index state'),
    ('vision_debug_image:enable', 'Enable temporary debug image retention for failed or ambiguous vision scans')
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO app.role_permissions (role, permission_id) VALUES
    ('staff', 'vision_scan:use'),
    ('manager', 'vision_scan:use'),
    ('manager', 'vision_scan:read'),
    ('manager', 'vision_catalog:write'),
    ('owner', 'vision_scan:use'),
    ('owner', 'vision_scan:read'),
    ('owner', 'vision_catalog:write'),
    ('owner', 'vision_debug_image:enable')
ON CONFLICT (role, permission_id) DO NOTHING;

UPDATE app.package_catalog_versions pcv
SET feature_keys = (
    SELECT jsonb_agg(features.value ORDER BY features.first_seen)
    FROM (
        SELECT value, min(ord) AS first_seen
        FROM jsonb_array_elements_text(
            pcv.feature_keys
            || '["vision_pos_input","vision_pos_single_capture","vision_correction_report"]'::jsonb
        ) WITH ORDINALITY AS expanded(value, ord)
        GROUP BY value
    ) features
)
WHERE pcv.package_key = 'ai_fan';

CREATE TABLE IF NOT EXISTS app.product_variant_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
    product_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    image_url TEXT NOT NULL,
    image_type TEXT NOT NULL CHECK (
        image_type IN ('primary', 'front', 'back', 'side', 'angle', 'counter_capture', 'strength_text', 'qr_tag')
    ),
    source TEXT NOT NULL CHECK (
        source IN ('manual', 'import', 'metadata_backfill', 'autofill', 'staff_correction', 'system')
    ),
    quality_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        quality_status IN ('pending', 'approved', 'rejected')
    ),
    quality_score NUMERIC(5,4) CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
    is_primary BOOLEAN NOT NULL DEFAULT false,
    external_provider TEXT,
    external_product_ref TEXT,
    external_image_ref TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_variant_images_scope_variant_idx
    ON app.product_variant_images(merchant_id, store_id, variant_id);

CREATE INDEX IF NOT EXISTS product_variant_images_product_idx
    ON app.product_variant_images(merchant_id, product_id);

CREATE INDEX IF NOT EXISTS product_variant_images_provider_ref_idx
    ON app.product_variant_images(external_provider, external_product_ref)
    WHERE external_provider IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_variant_images_variant_url_unique_idx
    ON app.product_variant_images(merchant_id, COALESCE(store_id, ''), variant_id, image_url);

CREATE UNIQUE INDEX IF NOT EXISTS product_variant_images_one_primary_idx
    ON app.product_variant_images(merchant_id, COALESCE(store_id, ''), variant_id)
    WHERE is_primary = true;

CREATE TABLE IF NOT EXISTS app.vision_catalog_index_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
    product_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    image_id UUID REFERENCES app.product_variant_images(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    provider_location TEXT,
    provider_product_set_ref TEXT,
    provider_product_ref TEXT,
    provider_image_ref TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        sync_status IN ('pending', 'synced', 'failed', 'disabled')
    ),
    sync_error TEXT,
    synced_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vision_catalog_index_scope_variant_idx
    ON app.vision_catalog_index_items(merchant_id, store_id, variant_id, provider);

CREATE INDEX IF NOT EXISTS vision_catalog_index_status_idx
    ON app.vision_catalog_index_items(provider, sync_status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS vision_catalog_index_provider_image_unique_idx
    ON app.vision_catalog_index_items(
        merchant_id,
        COALESCE(store_id, ''),
        provider,
        COALESCE(provider_location, ''),
        COALESCE(provider_product_set_ref, ''),
        variant_id,
        COALESCE(image_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );

CREATE TABLE IF NOT EXISTS app.vision_scan_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
    operator_id TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('single', 'bulk')),
    status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
    client_scan_id TEXT,
    image_hash TEXT NOT NULL,
    raw_image_storage_key TEXT,
    qr_detected_count INT NOT NULL DEFAULT 0 CHECK (qr_detected_count >= 0),
    ai_detected_count INT NOT NULL DEFAULT 0 CHECK (ai_detected_count >= 0),
    unresolved_count INT NOT NULL DEFAULT 0 CHECK (unresolved_count >= 0),
    latency_ms INT CHECK (latency_ms IS NULL OR latency_ms >= 0),
    provider TEXT,
    model_version TEXT,
    estimated_cost_usd NUMERIC(12,6) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vision_scan_events_scope_time_idx
    ON app.vision_scan_events(merchant_id, store_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS vision_scan_events_client_id_unique_idx
    ON app.vision_scan_events(merchant_id, store_id, client_scan_id)
    WHERE client_scan_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.vision_scan_detections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_event_id UUID NOT NULL REFERENCES app.vision_scan_events(id) ON DELETE CASCADE,
    object_id TEXT NOT NULL,
    bbox JSONB,
    source TEXT NOT NULL CHECK (source IN ('qr', 'barcode', 'vision_provider', 'manual')),
    detection_type TEXT NOT NULL CHECK (detection_type IN ('exact_match', 'candidate_match', 'unresolved')),
    resolved_variant_id TEXT,
    confidence NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
    requires_confirmation BOOLEAN NOT NULL DEFAULT true,
    decision TEXT NOT NULL DEFAULT 'pending' CHECK (
        decision IN ('pending', 'accepted', 'corrected', 'rejected', 'unresolved')
    ),
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS vision_scan_detections_object_idx
    ON app.vision_scan_detections(scan_event_id, object_id);

CREATE INDEX IF NOT EXISTS vision_scan_detections_variant_idx
    ON app.vision_scan_detections(resolved_variant_id)
    WHERE resolved_variant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.vision_scan_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_event_id UUID NOT NULL REFERENCES app.vision_scan_events(id) ON DELETE CASCADE,
    detection_id UUID REFERENCES app.vision_scan_detections(id) ON DELETE SET NULL,
    selected_variant_id TEXT,
    previous_variant_id TEXT,
    operator_id TEXT,
    correction_type TEXT NOT NULL CHECK (
        correction_type IN ('staff_accepted', 'staff_selected_correct_variant', 'staff_rejected', 'manual_search_selected')
    ),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT vision_scan_corrections_selected_variant_chk CHECK (
        (correction_type = 'staff_rejected' AND selected_variant_id IS NULL)
        OR (correction_type <> 'staff_rejected' AND selected_variant_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS vision_scan_corrections_scan_idx
    ON app.vision_scan_corrections(scan_event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS vision_scan_corrections_selected_variant_idx
    ON app.vision_scan_corrections(selected_variant_id, created_at DESC)
    WHERE selected_variant_id IS NOT NULL;

ALTER TABLE app.vision_scan_corrections
    DROP CONSTRAINT IF EXISTS vision_scan_corrections_correction_type_check;

ALTER TABLE app.vision_scan_corrections
    ADD CONSTRAINT vision_scan_corrections_correction_type_check
    CHECK (correction_type IN ('staff_accepted', 'staff_selected_correct_variant', 'staff_rejected', 'manual_search_selected'));

INSERT INTO app.product_variant_images (
    merchant_id,
    store_id,
    product_id,
    variant_id,
    image_url,
    image_type,
    source,
    quality_status,
    is_primary,
    metadata
)
SELECT
    p.merchant_id,
    s.id AS store_id,
    p.id AS product_id,
    v.id AS variant_id,
    p.metadata->>'imageUrl' AS image_url,
    'primary' AS image_type,
    'metadata_backfill' AS source,
    'pending' AS quality_status,
    true AS is_primary,
    jsonb_build_object('source', 'public.product.metadata.imageUrl')
FROM public.product p
JOIN public.product_variant v
    ON v.product_id = p.id
   AND v.deleted_at IS NULL
LEFT JOIN app.stores s
    ON s.merchant_id = p.merchant_id
   AND s.is_primary = true
   AND s.status = 'active'
WHERE p.deleted_at IS NULL
  AND p.merchant_id IS NOT NULL
  AND COALESCE(p.metadata->>'imageUrl', '') <> ''
  AND NOT EXISTS (
      SELECT 1
      FROM app.product_variant_images existing
      WHERE existing.merchant_id = p.merchant_id
        AND existing.store_id IS NOT DISTINCT FROM s.id
        AND existing.variant_id = v.id
        AND existing.image_url = p.metadata->>'imageUrl'
  );
