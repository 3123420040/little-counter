-- 007_crypto_asset_evidence.sql
-- Release 1.1.2 — Merchant-held stablecoin quantity, fee, carrying-value evidence.
-- Additive only: does not rewrite existing order, payment, or journal rows.

CREATE SCHEMA IF NOT EXISTS accounting;
CREATE SCHEMA IF NOT EXISTS app;

-- Accounts needed to keep provider fees and crypto treasury gains/losses
-- separate from retail revenue.
INSERT INTO accounting.accounts (code, name, type) VALUES
  ('5152', 'Lãi thanh lý tài sản stablecoin/crypto', 'revenue'),
  ('6351', 'Lỗ thanh lý tài sản stablecoin/crypto', 'expense'),
  ('6423', 'Chi phí nhà cung cấp thanh toán', 'expense')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type;

CREATE TABLE IF NOT EXISTS accounting.crypto_receipt_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'nowpayments' CHECK (provider IN ('nowpayments')),
  provider_event_id TEXT,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  order_id TEXT,
  payment_entry_id UUID,
  payment_intent_id TEXT,
  provider_payment_id TEXT,
  business_purpose TEXT NOT NULL DEFAULT 'retail_order' CHECK (business_purpose = 'retail_order'),
  asset TEXT NOT NULL CHECK (asset IN ('USDT', 'USDC')),
  network TEXT NOT NULL CHECK (network IN ('TRC20', 'MATIC')),
  retail_crypto_asset TEXT NOT NULL CHECK (retail_crypto_asset IN ('USDTTRC20', 'USDCMATIC')),
  gross_quantity NUMERIC(36,18) NOT NULL CHECK (gross_quantity > 0),
  provider_fee_quantity NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (provider_fee_quantity >= 0),
  net_quantity NUMERIC(36,18) NOT NULL CHECK (net_quantity >= 0),
  fee_asset TEXT CHECK (fee_asset IN ('USDT', 'USDC')),
  tx_hash TEXT NOT NULL,
  destination_wallet_ref TEXT NOT NULL,
  custody_account_ref TEXT,
  provider_config_id TEXT,
  provider_config_purpose TEXT NOT NULL DEFAULT 'merchant_retail' CHECK (provider_config_purpose = 'merchant_retail'),
  wallet_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  quote_id TEXT,
  quote_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  valuation_rate NUMERIC(36,12) NOT NULL CHECK (valuation_rate > 0),
  valuation_rate_source TEXT NOT NULL,
  valuation_timestamp TIMESTAMPTZ NOT NULL,
  gross_vnd_value NUMERIC(20,0) NOT NULL CHECK (gross_vnd_value >= 0),
  fee_vnd_value NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (fee_vnd_value >= 0),
  net_vnd_value NUMERIC(20,0) NOT NULL CHECK (net_vnd_value >= 0),
  carrying_value_vnd NUMERIC(20,0) NOT NULL CHECK (carrying_value_vnd >= 0),
  sale_journal_entry_id UUID REFERENCES accounting.journal_entries(id),
  fee_journal_entry_id UUID REFERENCES accounting.journal_entries(id),
  evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('verified', 'ignored', 'manual_review')),
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crypto_receipt_fee_not_exceed_gross_chk CHECK (provider_fee_quantity <= gross_quantity),
  CONSTRAINT crypto_receipt_net_quantity_chk CHECK (net_quantity = gross_quantity - provider_fee_quantity),
  CONSTRAINT crypto_receipt_asset_network_chk CHECK ((retail_crypto_asset = 'USDTTRC20' AND asset = 'USDT' AND network = 'TRC20') OR (retail_crypto_asset = 'USDCMATIC' AND asset = 'USDC' AND network = 'MATIC'))
);

CREATE UNIQUE INDEX IF NOT EXISTS crypto_receipt_provider_event_idx
  ON accounting.crypto_receipt_evidence(provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crypto_receipt_tx_wallet_asset_idx
  ON accounting.crypto_receipt_evidence(merchant_id, destination_wallet_ref, retail_crypto_asset, tx_hash);
CREATE INDEX IF NOT EXISTS crypto_receipt_scope_idx
  ON accounting.crypto_receipt_evidence(merchant_id, store_id, retail_crypto_asset, created_at DESC);
CREATE INDEX IF NOT EXISTS crypto_receipt_payment_idx
  ON accounting.crypto_receipt_evidence(payment_intent_id, payment_entry_id, order_id);

CREATE TABLE IF NOT EXISTS accounting.crypto_asset_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id TEXT NOT NULL UNIQUE,
  receipt_evidence_id UUID NOT NULL REFERENCES accounting.crypto_receipt_evidence(id) ON DELETE RESTRICT,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('USDT', 'USDC')),
  network TEXT NOT NULL CHECK (network IN ('TRC20', 'MATIC')),
  retail_crypto_asset TEXT NOT NULL CHECK (retail_crypto_asset IN ('USDTTRC20', 'USDCMATIC')),
  wallet_ref TEXT NOT NULL,
  original_quantity NUMERIC(36,18) NOT NULL CHECK (original_quantity >= 0),
  remaining_quantity NUMERIC(36,18) NOT NULL CHECK (remaining_quantity >= 0),
  original_carrying_value_vnd NUMERIC(20,0) NOT NULL CHECK (original_carrying_value_vnd >= 0),
  remaining_carrying_value_vnd NUMERIC(20,0) NOT NULL CHECK (remaining_carrying_value_vnd >= 0),
  valuation_rate NUMERIC(36,12) NOT NULL CHECK (valuation_rate > 0),
  acquired_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crypto_lot_remaining_quantity_chk CHECK (remaining_quantity <= original_quantity),
  CONSTRAINT crypto_lot_remaining_value_chk CHECK (remaining_carrying_value_vnd <= original_carrying_value_vnd)
);

CREATE INDEX IF NOT EXISTS crypto_lots_open_fifo_idx
  ON accounting.crypto_asset_lots(merchant_id, wallet_ref, retail_crypto_asset, acquired_at, id)
  WHERE status = 'open' AND remaining_quantity > 0;
CREATE INDEX IF NOT EXISTS crypto_lots_scope_idx
  ON accounting.crypto_asset_lots(merchant_id, store_id, retail_crypto_asset, status);

CREATE TABLE IF NOT EXISTS accounting.crypto_treasury_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_event_id TEXT NOT NULL UNIQUE,
  merchant_id TEXT NOT NULL,
  store_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('manual_transfer', 'off_ramp', 'disposal')),
  asset TEXT NOT NULL CHECK (asset IN ('USDT', 'USDC')),
  network TEXT NOT NULL CHECK (network IN ('TRC20', 'MATIC')),
  retail_crypto_asset TEXT NOT NULL CHECK (retail_crypto_asset IN ('USDTTRC20', 'USDCMATIC')),
  source_wallet_ref TEXT NOT NULL,
  destination_wallet_ref TEXT,
  quantity NUMERIC(36,18) NOT NULL CHECK (quantity > 0),
  proceeds_vnd NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (proceeds_vnd >= 0),
  fee_quantity NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (fee_quantity >= 0),
  fee_vnd_value NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (fee_vnd_value >= 0),
  carrying_value_removed_vnd NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (carrying_value_removed_vnd >= 0),
  gain_vnd NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (gain_vnd >= 0),
  loss_vnd NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK (loss_vnd >= 0),
  journal_entry_id UUID REFERENCES accounting.journal_entries(id),
  evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  manual_reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crypto_treasury_asset_network_chk CHECK ((retail_crypto_asset = 'USDTTRC20' AND asset = 'USDT' AND network = 'TRC20') OR (retail_crypto_asset = 'USDCMATIC' AND asset = 'USDC' AND network = 'MATIC'))
);

CREATE TABLE IF NOT EXISTS accounting.crypto_treasury_event_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_event_id UUID NOT NULL REFERENCES accounting.crypto_treasury_events(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES accounting.crypto_asset_lots(id) ON DELETE RESTRICT,
  quantity_removed NUMERIC(36,18) NOT NULL CHECK (quantity_removed > 0),
  carrying_value_removed_vnd NUMERIC(20,0) NOT NULL CHECK (carrying_value_removed_vnd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (treasury_event_id, lot_id)
);

-- Add the same invariants when these additive tables were created earlier by
-- the local/test compatibility bootstrap.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_receipt_fee_not_exceed_gross_chk') THEN
    ALTER TABLE accounting.crypto_receipt_evidence
      ADD CONSTRAINT crypto_receipt_fee_not_exceed_gross_chk CHECK (provider_fee_quantity <= gross_quantity);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_receipt_net_quantity_chk') THEN
    ALTER TABLE accounting.crypto_receipt_evidence
      ADD CONSTRAINT crypto_receipt_net_quantity_chk CHECK (net_quantity = gross_quantity - provider_fee_quantity);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_receipt_asset_network_chk') THEN
    ALTER TABLE accounting.crypto_receipt_evidence
      ADD CONSTRAINT crypto_receipt_asset_network_chk CHECK (
        (retail_crypto_asset = 'USDTTRC20' AND asset = 'USDT' AND network = 'TRC20')
        OR (retail_crypto_asset = 'USDCMATIC' AND asset = 'USDC' AND network = 'MATIC')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_lot_remaining_quantity_chk') THEN
    ALTER TABLE accounting.crypto_asset_lots
      ADD CONSTRAINT crypto_lot_remaining_quantity_chk CHECK (remaining_quantity <= original_quantity);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_lot_remaining_value_chk') THEN
    ALTER TABLE accounting.crypto_asset_lots
      ADD CONSTRAINT crypto_lot_remaining_value_chk CHECK (remaining_carrying_value_vnd <= original_carrying_value_vnd);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_treasury_asset_network_chk') THEN
    ALTER TABLE accounting.crypto_treasury_events
      ADD CONSTRAINT crypto_treasury_asset_network_chk CHECK (
        (retail_crypto_asset = 'USDTTRC20' AND asset = 'USDT' AND network = 'TRC20')
        OR (retail_crypto_asset = 'USDCMATIC' AND asset = 'USDC' AND network = 'MATIC')
      );
  END IF;
END $$;
