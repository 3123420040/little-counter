-- 018_telegram_sales_channel.sql
-- Phase 1.5 — customer-facing Telegram sales channel foundation.
--
-- This migration is additive and repeat-safe. The customer bot writes sales
-- drafts only; staff confirmation in the portal converts a draft to a real
-- remote order through the existing order workflow.

CREATE TABLE IF NOT EXISTS app.telegram_sales_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    store_id TEXT REFERENCES app.stores(id) ON UPDATE CASCADE,
    telegram_user_id TEXT NOT NULL,
    telegram_chat_id TEXT,
    telegram_username TEXT,
    telegram_first_name TEXT,
    language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ru')),
    customer_id TEXT,
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, telegram_user_id)
);

CREATE INDEX IF NOT EXISTS telegram_sales_profiles_scope_idx
    ON app.telegram_sales_profiles(merchant_id, store_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS app.telegram_sales_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    store_id TEXT NOT NULL REFERENCES app.stores(id) ON UPDATE CASCADE,
    profile_id UUID NOT NULL REFERENCES app.telegram_sales_profiles(id) ON DELETE RESTRICT,
    telegram_user_id TEXT NOT NULL,
    telegram_chat_id TEXT,
    telegram_username TEXT,
    language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ru')),
    status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('pending', 'needs_review', 'converted', 'rejected', 'expired', 'cancelled')),
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    quote JSONB NOT NULL DEFAULT '{}'::jsonb,
    delivery JSONB NOT NULL DEFAULT '{}'::jsonb,
    customer_message TEXT,
    operator_notes TEXT,
    ai_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source TEXT NOT NULL DEFAULT 'telegram',
    idempotency_key TEXT NOT NULL,
    converted_order_id TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS telegram_sales_drafts_scope_status_idx
    ON app.telegram_sales_drafts(merchant_id, store_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS telegram_sales_drafts_profile_idx
    ON app.telegram_sales_drafts(profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS telegram_sales_drafts_converted_order_idx
    ON app.telegram_sales_drafts(converted_order_id)
    WHERE converted_order_id IS NOT NULL;

UPDATE app.package_catalog_versions
SET feature_keys = CASE
    WHEN package_key = 'ai_fan'
    THEN (
        SELECT jsonb_agg(DISTINCT value)
        FROM jsonb_array_elements_text(feature_keys || '["telegram_sales_channel"]'::jsonb) AS feature(value)
    )
    ELSE feature_keys
END
WHERE package_key = 'ai_fan';
