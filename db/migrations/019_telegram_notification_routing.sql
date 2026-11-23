-- 019_telegram_notification_routing.sql
-- Telegram public sales v1.5+ notification recipients, rules, and fanout-safe queue keys.
--
-- Additive and repeat-safe. Legacy operator-recipient notification rows keep
-- working while new rows can target direct Telegram recipients.

CREATE TABLE IF NOT EXISTS notification.telegram_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL,
    store_id TEXT,
    telegram_user_id TEXT NOT NULL,
    telegram_chat_id TEXT,
    telegram_username TEXT,
    linked_operator_id TEXT,
    display_name TEXT NOT NULL,
    recipient_kind TEXT NOT NULL
        CHECK (recipient_kind IN ('owner', 'manager', 'sales_staff', 'ops', 'custom')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT NOT NULL,
    updated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_recipients_active_user_idx
    ON notification.telegram_recipients(merchant_id, telegram_user_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS telegram_recipients_scope_idx
    ON notification.telegram_recipients(merchant_id, store_id, status);

CREATE INDEX IF NOT EXISTS telegram_recipients_operator_idx
    ON notification.telegram_recipients(linked_operator_id)
    WHERE linked_operator_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification.telegram_notification_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id TEXT NOT NULL,
    store_id TEXT,
    recipient_id UUID NOT NULL REFERENCES notification.telegram_recipients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    event_scope TEXT NOT NULL,
    channel_filter TEXT NOT NULL DEFAULT 'all',
    event_types TEXT[] NOT NULL DEFAULT '{}',
    template_profile TEXT NOT NULL DEFAULT 'default',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT NOT NULL,
    updated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_notification_rules_scope_idx
    ON notification.telegram_notification_rules(merchant_id, store_id, enabled);

CREATE INDEX IF NOT EXISTS telegram_notification_rules_recipient_idx
    ON notification.telegram_notification_rules(recipient_id);

ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS recipient_id UUID REFERENCES notification.telegram_recipients(id) ON DELETE SET NULL;
ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS rule_id UUID REFERENCES notification.telegram_notification_rules(id) ON DELETE SET NULL;
ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
ALTER TABLE notification.telegram_notifications ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE notification.telegram_notifications ALTER COLUMN recipient_operator_id DROP NOT NULL;
ALTER TABLE notification.telegram_notifications DROP CONSTRAINT IF EXISTS telegram_notifications_source_event_id_key;

UPDATE notification.telegram_notifications
SET dedupe_key = COALESCE(source_event_id, id::text)
WHERE dedupe_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS telegram_notifications_dedupe_key_uidx
    ON notification.telegram_notifications(dedupe_key);

CREATE INDEX IF NOT EXISTS telegram_notifications_direct_recipient_idx
    ON notification.telegram_notifications(recipient_id, created_at DESC)
    WHERE recipient_id IS NOT NULL;
