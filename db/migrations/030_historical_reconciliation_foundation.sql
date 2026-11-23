-- 030_historical_reconciliation_foundation.sql
-- Additive provenance/control schema for manifest-bound historical reconstruction.
-- This migration creates no business fact, performs no backfill and mutates no
-- predecessor order/payment/stock/accounting row.

CREATE TABLE IF NOT EXISTS app.historical_reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_id TEXT NOT NULL CHECK (schema_id = 'snus-historical-foundation-manifest/v1'),
  run_kind TEXT NOT NULL CHECK (run_kind IN ('classification', 'apply')),
  source_snapshot_id TEXT NOT NULL CHECK (source_snapshot_id <> ''),
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  quarantine_sha256 TEXT NOT NULL CHECK (quarantine_sha256 ~ '^[a-f0-9]{64}$'),
  classifier_source_sha256 TEXT NOT NULL CHECK (classifier_source_sha256 ~ '^[a-f0-9]{64}$'),
  classifier_artifact_sha256 TEXT NOT NULL CHECK (classifier_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  source_application_sha TEXT NOT NULL CHECK (source_application_sha <> ''),
  database_schema_sha256 TEXT NOT NULL CHECK (database_schema_sha256 ~ '^[a-f0-9]{64}$'),
  custom_migration_ledger_sha256 TEXT NOT NULL CHECK (custom_migration_ledger_sha256 ~ '^[a-f0-9]{64}$'),
  medusa_migration_ledger_sha256 TEXT NOT NULL CHECK (medusa_migration_ledger_sha256 ~ '^[a-f0-9]{64}$'),
  source_preservation_inventory_sha256 TEXT NOT NULL CHECK (source_preservation_inventory_sha256 ~ '^[a-f0-9]{64}$'),
  candidate_count BIGINT NOT NULL CHECK (candidate_count >= 0),
  accepted_count BIGINT NOT NULL CHECK (accepted_count >= 0),
  quarantine_count BIGINT NOT NULL CHECK (quarantine_count >= 0),
  no_op_count BIGINT NOT NULL CHECK (no_op_count >= 0),
  actor TEXT NOT NULL CHECK (actor <> ''),
  reason TEXT NOT NULL CHECK (reason <> ''),
  started_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (accepted_count + quarantine_count + no_op_count = candidate_count),
  CHECK (committed_at >= started_at),
  UNIQUE (run_kind, manifest_sha256)
);

CREATE TABLE IF NOT EXISTS app.historical_reconciliation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES app.historical_reconciliation_runs(id) ON DELETE RESTRICT,
  manifest_row_number BIGINT NOT NULL CHECK (manifest_row_number > 0),
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES public."order"(id) ON DELETE RESTRICT,
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  source_table TEXT NOT NULL CHECK (source_table <> ''),
  source_id TEXT NOT NULL CHECK (source_id <> ''),
  source_occurred_at TIMESTAMPTZ,
  source_payload_sha256 TEXT NOT NULL CHECK (source_payload_sha256 ~ '^[a-f0-9]{64}$'),
  target_fact_kind TEXT NOT NULL CHECK (target_fact_kind <> ''),
  target_idempotency_key TEXT NOT NULL CHECK (target_idempotency_key <> ''),
  component_amounts_minor JSONB NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accept', 'quarantine', 'no_op')),
  reason_code TEXT NOT NULL CHECK (reason_code <> ''),
  target_type TEXT,
  target_id TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (merchant_id, store_id)
    REFERENCES app.stores(merchant_id, id) ON UPDATE CASCADE,
  CHECK ((target_type IS NULL) = (target_id IS NULL)),
  UNIQUE (run_id, manifest_row_number),
  UNIQUE (
    run_id, merchant_id, store_id, order_id, target_fact_kind,
    source_table, source_id, target_idempotency_key
  )
);

CREATE INDEX IF NOT EXISTS historical_reconciliation_items_order_idx
  ON app.historical_reconciliation_items(merchant_id, store_id, order_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS historical_reconciliation_items_decision_idx
  ON app.historical_reconciliation_items(run_id, decision, reason_code);

CREATE OR REPLACE FUNCTION app.reject_historical_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS historical_reconciliation_runs_append_only
  ON app.historical_reconciliation_runs;
CREATE TRIGGER historical_reconciliation_runs_append_only
  BEFORE UPDATE OR DELETE ON app.historical_reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION app.reject_historical_reconciliation_mutation();

DROP TRIGGER IF EXISTS historical_reconciliation_items_append_only
  ON app.historical_reconciliation_items;
CREATE TRIGGER historical_reconciliation_items_append_only
  BEFORE UPDATE OR DELETE ON app.historical_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION app.reject_historical_reconciliation_mutation();

REVOKE UPDATE, DELETE ON app.historical_reconciliation_runs FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.historical_reconciliation_items FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.reject_historical_reconciliation_mutation() FROM PUBLIC;
