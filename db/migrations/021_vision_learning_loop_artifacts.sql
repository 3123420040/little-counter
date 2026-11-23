-- 021_vision_learning_loop_artifacts.sql
-- Release 1.5+ -- Vision learning loop artifact ledger.
--
-- Additive and repeat-safe. Tracks private raw scan and object crop files used
-- to improve the Vision reference-image catalog after staff-confirmed sales.

CREATE TABLE IF NOT EXISTS app.vision_scan_image_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
    scan_event_id UUID NOT NULL REFERENCES app.vision_scan_events(id) ON DELETE CASCADE,
    detection_id UUID REFERENCES app.vision_scan_detections(id) ON DELETE SET NULL,
    variant_id TEXT REFERENCES public.product_variant(id) ON DELETE SET NULL,
    artifact_type TEXT NOT NULL CHECK (artifact_type IN ('raw_scan', 'object_crop')),
    gcs_uri TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size INT CHECK (byte_size IS NULL OR byte_size >= 0),
    width INT CHECK (width IS NULL OR width > 0),
    height INT CHECK (height IS NULL OR height > 0),
    bbox JSONB,
    image_hash TEXT,
    quality_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        quality_status IN ('pending', 'approved', 'rejected', 'skipped')
    ),
    retention_expires_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vision_scan_image_artifacts_scan_idx
    ON app.vision_scan_image_artifacts(scan_event_id, artifact_type, created_at DESC);

CREATE INDEX IF NOT EXISTS vision_scan_image_artifacts_variant_idx
    ON app.vision_scan_image_artifacts(merchant_id, store_id, variant_id, artifact_type)
    WHERE variant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS vision_scan_image_artifacts_storage_unique_idx
    ON app.vision_scan_image_artifacts(storage_key);
