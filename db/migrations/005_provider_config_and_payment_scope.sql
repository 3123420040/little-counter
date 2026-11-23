BEGIN;

ALTER TABLE app.payment_intents
  ADD COLUMN IF NOT EXISTS merchant_id TEXT,
  ADD COLUMN IF NOT EXISTS store_id TEXT,
  ADD COLUMN IF NOT EXISTS business_purpose TEXT NOT NULL DEFAULT 'retail_order',
  ADD COLUMN IF NOT EXISTS provider_config_purpose TEXT NOT NULL DEFAULT 'merchant_retail',
  ADD COLUMN IF NOT EXISTS provider_config_id TEXT;

ALTER TABLE app.payment_provider_events
  ADD COLUMN IF NOT EXISTS merchant_id TEXT,
  ADD COLUMN IF NOT EXISTS store_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_entry_id UUID,
  ADD COLUMN IF NOT EXISTS order_id TEXT,
  ADD COLUMN IF NOT EXISTS evidence_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS crypto_receipt_evidence JSONB,
  ADD COLUMN IF NOT EXISTS event_revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE app.payment_entries
  ADD COLUMN IF NOT EXISTS merchant_id TEXT,
  ADD COLUMN IF NOT EXISTS store_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_event_id TEXT;

CREATE INDEX IF NOT EXISTS payment_intents_merchant_store_idx
  ON app.payment_intents(merchant_id, store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_provider_events_merchant_store_idx
  ON app.payment_provider_events(merchant_id, store_id, received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payment_entries_payment_intent_charge_idx
  ON app.payment_entries(payment_intent_id)
  WHERE payment_intent_id IS NOT NULL AND direction = 'charge';

COMMIT;
