-- ═══════════════════════════════════════════════════════
-- 001_custom_schemas.sql
-- Creates all 5 custom schemas with tables
-- Per database-schema.md §3 + adr/002
-- ═══════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Schema: accounting ──────────────────────────────────

CREATE SCHEMA IF NOT EXISTS accounting;

CREATE TABLE IF NOT EXISTS accounting.accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
    parent_id UUID REFERENCES accounting.accounts(id),
    is_active BOOLEAN NOT NULL DEFAULT true,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounting.journal_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_number TEXT NOT NULL UNIQUE,
    entry_date DATE NOT NULL,
    reference_type TEXT,
    reference_id TEXT,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'voided')),
    posted_at TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounting.journal_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_entry_id UUID NOT NULL REFERENCES accounting.journal_entries(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounting.accounts(id),
    description TEXT,
    debit_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    CHECK (debit_amount = 0 OR credit_amount = 0),
    CHECK (debit_amount > 0 OR credit_amount > 0)
);

CREATE INDEX IF NOT EXISTS journal_lines_entry_idx ON accounting.journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON accounting.journal_lines(account_id);

INSERT INTO accounting.accounts (code, name, type) VALUES
    ('7111', 'Thu nhập khác từ chênh lệch kiểm kê', 'revenue')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type;

CREATE TABLE IF NOT EXISTS accounting.fiscal_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_closed BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (start_date, end_date)
);

-- ── Schema: ai_module ───────────────────────────────────

CREATE SCHEMA IF NOT EXISTS ai_module;

CREATE TABLE IF NOT EXISTS ai_module.actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL DEFAULT 'org_default',
    action_type TEXT NOT NULL CHECK (action_type IN ('reply_draft', 'inventory_alert', 'loyalty_recommendation')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'failed', 'review_required', 'approved', 'rejected', 'acknowledged')),
    source_event_id UUID,
    customer_id TEXT,
    order_id TEXT,
    product_id TEXT,
    output_payload JSONB NOT NULL DEFAULT '{}',
    confidence NUMERIC(4,3),
    risk_level TEXT CHECK (risk_level IN ('low', 'medium', 'high', 'blocked')),
    model_provider TEXT,
    model_name TEXT,
    prompt_version TEXT,
    latency_ms INTEGER,
    approved_text TEXT,
    rejection_reason TEXT,
    reviewed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ai_actions_type_status_idx ON ai_module.actions(action_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_actions_customer_idx ON ai_module.actions(customer_id);

CREATE TABLE IF NOT EXISTS ai_module.customer_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id TEXT NOT NULL UNIQUE,
    phone TEXT,
    date_of_birth DATE,
    gender TEXT,
    notes TEXT,
    tags TEXT[] NOT NULL DEFAULT '{}',
    total_spent NUMERIC(14,2) NOT NULL DEFAULT 0,
    order_count INT NOT NULL DEFAULT 0,
    first_purchase_at TIMESTAMPTZ,
    last_purchase_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_module.loyalty_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id TEXT NOT NULL,
    source_event_id UUID NOT NULL UNIQUE,
    order_id TEXT,
    points_earned INT NOT NULL DEFAULT 0,
    points_redeemed INT NOT NULL DEFAULT 0,
    tier_at_time TEXT NOT NULL DEFAULT 'bronze'
        CHECK (tier_at_time IN ('bronze', 'silver', 'gold', 'platinum')),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loyalty_customer_idx ON ai_module.loyalty_records(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_module.loyalty_tiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    points_threshold INT NOT NULL,
    discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_module.inventory_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_event_id UUID NOT NULL UNIQUE,
    merchant_id TEXT,
    store_id TEXT,
    product_id TEXT NOT NULL,
    current_stock INT NOT NULL,
    reorder_level INT NOT NULL,
    suggested_quantity INT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'acknowledged', 'resolved')),
    acknowledged_by TEXT,
    acknowledged_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_module.policy_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ai_action_id UUID REFERENCES ai_module.actions(id),
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'block', 'flagged')),
    reason_codes TEXT[] NOT NULL DEFAULT '{}',
    evidence JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Schema: outbox ──────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS outbox;

CREATE TABLE IF NOT EXISTS outbox.events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_version INT NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_lettered')),
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at TIMESTAMPTZ,
    claimed_by TEXT,
    claimed_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_idx ON outbox.events (status, created_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS outbox_events_claimed_idx ON outbox.events (claimed_by, claimed_until);

-- ── Schema: audit ───────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL DEFAULT 'org_default',
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    before JSONB,
    after JSONB,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_org_subject_idx ON audit.events(organization_id, subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_correlation_idx ON audit.events(correlation_id);

-- ── Schema: medusa (custom extensions) ──────────────────

CREATE SCHEMA IF NOT EXISTS medusa;

CREATE TABLE IF NOT EXISTS medusa.stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inventory_item_id TEXT NOT NULL,
    movement_type TEXT NOT NULL CHECK (movement_type IN (
        'sale', 'purchase_receipt', 'manual_adjustment',
        'transfer_in', 'transfer_out', 'return', 'damage'
    )),
    quantity_change INT NOT NULL,
    quantity_after INT NOT NULL,
    reference_type TEXT,
    reference_id TEXT,
    reason TEXT,
    performed_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_movements_item_idx ON medusa.stock_movements(inventory_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_ref_idx ON medusa.stock_movements(reference_type, reference_id);

-- ── App Idempotency ──────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS app_idempotency_key_idx ON app.idempotency_records(idempotency_key);

-- ── Multi-Channel Primitives ───────────────────────────

CREATE TABLE IF NOT EXISTS app.operator_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL DEFAULT 'org_default',
    provider TEXT NOT NULL CHECK (provider IN ('telegram')),
    provider_user_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    display_name TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, provider, provider_user_id),
    UNIQUE (organization_id, provider, operator_id)
);

CREATE INDEX IF NOT EXISTS operator_identities_operator_idx
    ON app.operator_identities(operator_id)
    WHERE is_active = true;

CREATE TABLE IF NOT EXISTS app.bot_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL DEFAULT 'org_default',
    provider TEXT NOT NULL CHECK (provider IN ('telegram')),
    provider_user_id TEXT NOT NULL,
    operator_id TEXT,
    state JSONB NOT NULL DEFAULT '{}',
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS bot_sessions_expiry_idx ON app.bot_sessions(expires_at);

CREATE TABLE IF NOT EXISTS app.permissions (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app.role_permissions (
    role TEXT NOT NULL CHECK (role IN ('staff', 'manager', 'accountant', 'owner')),
    permission_id TEXT NOT NULL REFERENCES app.permissions(id),
    PRIMARY KEY (role, permission_id)
);

CREATE TABLE IF NOT EXISTS app.payment_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL DEFAULT 'org_default',
    order_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('charge', 'refund')),
    method TEXT NOT NULL,
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency_code TEXT NOT NULL DEFAULT 'vnd',
    status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'voided')),
    reference TEXT,
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_entries_order_idx
    ON app.payment_entries(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_entries_status_idx
    ON app.payment_entries(status, created_at DESC);

ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS channel_user_id TEXT;
ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS service_identity TEXT;
ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE INDEX IF NOT EXISTS audit_channel_idx
    ON audit.events(channel, channel_user_id, created_at DESC);

-- ── Staff Users ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS medusa.staff_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('staff', 'manager', 'accountant', 'owner')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    organization_id TEXT NOT NULL DEFAULT 'org_default',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

-- ── Inventory Operations ────────────────────────────────

CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE IF NOT EXISTS inventory.product_settings (
    variant_id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    cost_price NUMERIC(14,2) NOT NULL DEFAULT 0,
    reorder_level INT NOT NULL DEFAULT 5,
    preferred_stock INT NOT NULL DEFAULT 20,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory.purchase_orders (
    id TEXT PRIMARY KEY,
    supplier_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'sent', 'partially_received', 'received', 'cancelled')),
    expected_date DATE,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory.purchase_order_items (
    id TEXT PRIMARY KEY,
    purchase_order_id TEXT NOT NULL REFERENCES inventory.purchase_orders(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
    received_quantity INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Notifications ───────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS notification;

CREATE TABLE IF NOT EXISTS notification.email_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
    error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification.telegram_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL DEFAULT 'org_default',
    recipient_operator_id TEXT NOT NULL,
    template TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'sent', 'dead_lettered')),
    attempts INT NOT NULL DEFAULT 0,
    source_event_id TEXT UNIQUE,
    claimed_until TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ,
    last_error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_notifications_dispatch_idx
    ON notification.telegram_notifications(status, next_retry_at, created_at);
CREATE INDEX IF NOT EXISTS telegram_notifications_recipient_idx
    ON notification.telegram_notifications(recipient_operator_id, created_at DESC);
