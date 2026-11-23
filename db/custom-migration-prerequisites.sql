-- Custom migration prerequisites
--
-- The original 001 migration predates retail payment intents. Migration 005
-- extends these tables, so a database created from Medusa core migrations
-- alone needs the base tables before the numbered custom migration chain can
-- run. Existing databases already have them and are unchanged by this file.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.payment_intents (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL DEFAULT 'org_default',
    provider TEXT NOT NULL CHECK (provider IN ('mock', 'sepay_va', 'nowpayments')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'completed', 'expired', 'cancelled', 'manual_review', 'failed')),
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency_code TEXT NOT NULL DEFAULT 'vnd',
    order_input JSONB NOT NULL,
    provider_reference TEXT,
    reference_code TEXT NOT NULL UNIQUE,
    payment_url TEXT,
    qr_payload TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ,
    completed_order_id TEXT,
    manual_review_reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_intents_status_idx
    ON app.payment_intents(status, expires_at, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_intents_provider_reference_idx
    ON app.payment_intents(provider, provider_reference)
    WHERE provider_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.payment_provider_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL DEFAULT 'org_default',
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    payment_intent_id TEXT REFERENCES app.payment_intents(id),
    event_type TEXT NOT NULL,
    amount NUMERIC(14,2),
    currency_code TEXT,
    status TEXT NOT NULL CHECK (status IN ('received', 'matched', 'ignored', 'manual_review', 'failed')),
    error TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS payment_provider_events_intent_idx
    ON app.payment_provider_events(payment_intent_id, received_at DESC);
