-- 012_platform_admin_integration_configs.sql
-- Platform-admin integration configuration metadata. Provider secret values
-- are write-only and are never persisted in this database.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.integration_configs (
    id TEXT PRIMARY KEY,
    provider_key TEXT NOT NULL CHECK (provider_key IN ('mock', 'sepay_va', 'nowpayments')),
    purpose TEXT NOT NULL CHECK (purpose IN ('platform_billing', 'merchant_retail')),
    scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'merchant', 'store')),
    merchant_id TEXT REFERENCES app.merchants(id) ON UPDATE CASCADE,
    store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'error')),
    secret_digest TEXT,
    secret_set_at TIMESTAMPTZ,
    last_rotated_at TIMESTAMPTZ,
    callback_url TEXT,
    health_summary TEXT,
    required_action TEXT,
    live_mode BOOLEAN NOT NULL DEFAULT false CHECK (live_mode = false),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    disabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT integration_configs_target_check CHECK (
        (scope_type = 'platform' AND merchant_id IS NULL AND store_id IS NULL)
        OR (scope_type = 'merchant' AND merchant_id IS NOT NULL AND store_id IS NULL)
        OR (scope_type = 'store' AND merchant_id IS NOT NULL AND store_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_configs_target_unique_idx
    ON app.integration_configs (
        provider_key,
        purpose,
        scope_type,
        COALESCE(merchant_id, ''),
        COALESCE(store_id, '')
    );

CREATE INDEX IF NOT EXISTS integration_configs_merchant_idx
    ON app.integration_configs(merchant_id, status, updated_at DESC)
    WHERE merchant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS integration_configs_store_idx
    ON app.integration_configs(store_id, status, updated_at DESC)
    WHERE store_id IS NOT NULL;
