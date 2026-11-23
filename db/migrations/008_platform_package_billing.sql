-- 008_platform_package_billing.sql
-- Release 1.1.2 — Platform package billing through NOWPayments.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.billing_orders (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('new_subscription', 'renewal', 'upgrade', 'store_addon')),
    current_package_key TEXT CHECK (current_package_key IN ('basic', 'plus', 'ai_fan')),
    target_package_key TEXT NOT NULL CHECK (target_package_key IN ('basic', 'plus', 'ai_fan')),
    catalog_version_id TEXT NOT NULL REFERENCES app.package_catalog_versions(id) ON UPDATE CASCADE,
    policy_version TEXT NOT NULL DEFAULT '1.1.2-annual-v1',
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    amount_vnd NUMERIC(20,0) NOT NULL CHECK (amount_vnd >= 0),
    provider TEXT NOT NULL DEFAULT 'nowpayments' CHECK (provider = 'nowpayments'),
    provider_payment_id TEXT,
    provider_quote_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'waiting_payment', 'paid', 'applied', 'expired', 'cancelled', 'manual_review', 'failed')),
    manual_review_reason TEXT,
    requested_by TEXT,
    quote_expires_at TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ,
    applied_at TIMESTAMPTZ,
    idempotency_key TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (period_end > period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_orders_idempotency_idx
    ON app.billing_orders(merchant_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS billing_orders_provider_payment_idx
    ON app.billing_orders(provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_orders_merchant_idx
    ON app.billing_orders(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_orders_status_idx
    ON app.billing_orders(status, quote_expires_at);

CREATE TABLE IF NOT EXISTS app.billing_provider_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (provider = 'nowpayments'),
    provider_event_id TEXT NOT NULL,
    billing_order_id TEXT REFERENCES app.billing_orders(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    provider_payment_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('received', 'matched', 'ignored', 'manual_review', 'applied')),
    error TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_provider_events_unique_idx
    ON app.billing_provider_events(provider, provider_event_id);
CREATE INDEX IF NOT EXISTS billing_provider_events_order_idx
    ON app.billing_provider_events(billing_order_id, created_at DESC);
