-- 035_historical_bank_recognition.sql
--
-- Additive, manifest-bound recognition of a historical manual-bank receipt.
-- This migration intentionally never changes an existing financial fact. A
-- recognition appends one fully proven posted collection to an existing,
-- otherwise-uncollected pending obligation; historical evidence is not an API
-- input and must be pre-registered in the append-only migration registry.

CREATE TABLE IF NOT EXISTS app.historical_bank_recognition_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_id TEXT NOT NULL CHECK (schema_id = 'snus-historical-bank-recognition/v1'),
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  source_dataset_sha256 TEXT NOT NULL CHECK (source_dataset_sha256 ~ '^[a-f0-9]{64}$'),
  owner_declaration_sha256 TEXT NOT NULL CHECK (owner_declaration_sha256 ~ '^[a-f0-9]{64}$'),
  execution_permit_sha256 TEXT NOT NULL CHECK (execution_permit_sha256 ~ '^[a-f0-9]{64}$'),
  target_environment TEXT NOT NULL CHECK (target_environment IN ('disposable', 'uat', 'production')),
  target_database_identity_sha256 TEXT NOT NULL CHECK (
    target_database_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  source_application_sha TEXT NOT NULL CHECK (source_application_sha ~ '^[a-f0-9]{40}$'),
  cutoff_at TIMESTAMPTZ NOT NULL,
  report_as_of TIMESTAMPTZ NOT NULL,
  date_policy TEXT NOT NULL CHECK (
    date_policy = 'reliable_receipt_else_original_economic_time_v1'
  ),
  expected_recognized_count BIGINT NOT NULL CHECK (expected_recognized_count >= 0),
  expected_already_satisfied_count BIGINT NOT NULL CHECK (expected_already_satisfied_count >= 0),
  expected_exception_count BIGINT NOT NULL CHECK (expected_exception_count >= 0),
  actor TEXT NOT NULL CHECK (actor <> ''),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (manifest_sha256, target_database_identity_sha256)
);

CREATE TABLE IF NOT EXISTS app.historical_bank_recognition_items (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES app.historical_bank_recognition_runs(id) ON DELETE RESTRICT,
  manifest_row_number BIGINT NOT NULL CHECK (manifest_row_number > 0),
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES public."order"(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('recognize', 'already_satisfied', 'exception')),
  reason_code TEXT NOT NULL CHECK (reason_code <> ''),
  source_pending_payment_event_id UUID NOT NULL REFERENCES app.payment_events(id) ON DELETE RESTRICT,
  source_obligation_id UUID NOT NULL REFERENCES app.commercial_obligations(id) ON DELETE RESTRICT,
  source_commercial_revision_id UUID NOT NULL REFERENCES app.order_commercial_revisions(id) ON DELETE RESTRICT,
  base_commercial_revision_id UUID REFERENCES app.order_commercial_revisions(id) ON DELETE RESTRICT,
  recognition_kind TEXT NOT NULL CHECK (recognition_kind IN ('initial', 'positive_correction')),
  target_payment_event_id UUID,
  target_source_type TEXT CHECK (
    target_source_type IN (
      'historical_bank_initial_recognition',
      'historical_bank_correction_recognition'
    )
  ),
  target_source_id TEXT,
  target_idempotency_key TEXT,
  evidence_fingerprint TEXT CHECK (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
  source_payload_sha256 TEXT NOT NULL CHECK (source_payload_sha256 ~ '^[a-f0-9]{64}$'),
  component_basis_fingerprint TEXT NOT NULL CHECK (component_basis_fingerprint ~ '^[a-f0-9]{64}$'),
  owner_declaration_reference_sha256 TEXT NOT NULL CHECK (
    owner_declaration_reference_sha256 ~ '^[a-f0-9]{64}$'
  ),
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 3),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  economic_occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  FOREIGN KEY (merchant_id, store_id)
    REFERENCES app.stores(merchant_id, id) ON UPDATE CASCADE,
  CHECK (
    (decision = 'recognize') = (
      target_payment_event_id IS NOT NULL
      AND target_source_type IS NOT NULL
      AND target_source_id IS NOT NULL
      AND target_idempotency_key IS NOT NULL
      AND evidence_fingerprint IS NOT NULL
    )
  ),
  CHECK (
    (recognition_kind = 'initial') = (base_commercial_revision_id IS NULL)
  ),
  CHECK (
    target_source_type IS NULL
    OR (recognition_kind = 'initial'
      AND target_source_type = 'historical_bank_initial_recognition')
    OR (recognition_kind = 'positive_correction'
      AND target_source_type = 'historical_bank_correction_recognition')
  ),
  UNIQUE (run_id, manifest_row_number)
);

CREATE INDEX IF NOT EXISTS historical_bank_recognition_items_run_idx
  ON app.historical_bank_recognition_items(run_id, manifest_row_number);
CREATE INDEX IF NOT EXISTS historical_bank_recognition_items_scope_order_idx
  ON app.historical_bank_recognition_items(merchant_id, store_id, order_id, recorded_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS historical_bank_recognition_one_receipt_per_pending_idx
  ON app.historical_bank_recognition_items(source_pending_payment_event_id)
  WHERE decision = 'recognize';

CREATE OR REPLACE FUNCTION app.reject_historical_bank_recognition_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS historical_bank_recognition_runs_append_only
  ON app.historical_bank_recognition_runs;
CREATE TRIGGER historical_bank_recognition_runs_append_only
  BEFORE UPDATE OR DELETE ON app.historical_bank_recognition_runs
  FOR EACH ROW EXECUTE FUNCTION app.reject_historical_bank_recognition_mutation();

DROP TRIGGER IF EXISTS historical_bank_recognition_items_append_only
  ON app.historical_bank_recognition_items;
CREATE TRIGGER historical_bank_recognition_items_append_only
  BEFORE UPDATE OR DELETE ON app.historical_bank_recognition_items
  FOR EACH ROW EXECUTE FUNCTION app.reject_historical_bank_recognition_mutation();

-- Rebuild only the two evidence checks whose v1 allow-list must expand. The
-- old constraints are identified by their immutable v1 proof vocabulary, not
-- by an assumed generated constraint name.
DO $checks$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'app.payment_events'::regclass
      AND constraint_row.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%manual_verified%'
  LOOP
    EXECUTE format('ALTER TABLE app.payment_events DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  FOR constraint_name IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'app.payment_event_evidence'::regclass
      AND constraint_row.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%manual_verified%'
  LOOP
    EXECUTE format('ALTER TABLE app.payment_event_evidence DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$checks$;

ALTER TABLE app.payment_events
  ADD CONSTRAINT payment_events_evidence_type_check CHECK (
    evidence_type IS NULL OR evidence_type IN (
      'cash_receipt',
      'cod_order_created',
      'manual_verified',
      'owner_historical_recognition',
      'provider_webhook_success',
      'negative_collection_confirmed'
    )
  ),
  ADD CONSTRAINT payment_events_posted_evidence_check CHECK (
    status = 'pending'
    OR (
      evidence_type IS NOT NULL
      AND evidence_fingerprint IS NOT NULL
      AND (
        (kind = 'charge' AND method = 'cash' AND evidence_type = 'cash_receipt')
        OR (kind = 'charge' AND method = 'cod' AND evidence_type = 'cod_order_created')
        OR (kind = 'charge' AND method = 'manual_bank'
          AND evidence_type = 'manual_verified')
        OR (kind = 'charge' AND method = 'manual_bank'
          AND evidence_type = 'owner_historical_recognition'
          AND source_type IN (
            'historical_bank_initial_recognition',
            'historical_bank_correction_recognition'
          ))
        OR (kind = 'charge' AND method = 'provider' AND evidence_type = 'provider_webhook_success')
        OR (kind IN ('refund', 'reversal', 'chargeback')
          AND evidence_type = 'negative_collection_confirmed')
      )
    )
  );

ALTER TABLE app.payment_event_evidence
  ADD CONSTRAINT payment_event_evidence_type_check CHECK (
    evidence_type IN (
      'cash_receipt',
      'cod_order_created',
      'manual_verified',
      'owner_historical_recognition',
      'provider_webhook_success',
      'negative_collection_confirmed'
    )
  );

CREATE OR REPLACE FUNCTION app.assert_historical_bank_recognition_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  event_fact RECORD;
  recognition RECORD;
  prior_pending RECORD;
BEGIN
  IF NEW.evidence_type <> 'owner_historical_recognition' THEN
    RETURN NEW;
  END IF;
  IF NEW.source_system <> 'owner_historical_recognition'
    OR NEW.verification_status <> 'verified'
  THEN
    RAISE EXCEPTION 'historical bank recognition must carry verified owner evidence'
      USING ERRCODE = '23514';
  END IF;

  SELECT events.* INTO STRICT event_fact
  FROM app.payment_events events
  WHERE events.id = NEW.payment_event_id;
  IF COALESCE(event_fact.metadata->>'historicalRecognitionItemId', '') !~*
      '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  THEN
    RAISE EXCEPTION 'historical bank recognition event lacks an item identity'
      USING ERRCODE = '23514';
  END IF;

  SELECT items.*, runs.manifest_sha256
  INTO STRICT recognition
  FROM app.historical_bank_recognition_items items
  JOIN app.historical_bank_recognition_runs runs ON runs.id = items.run_id
  WHERE items.id = (event_fact.metadata->>'historicalRecognitionItemId')::uuid;

  IF recognition.decision <> 'recognize'
    OR recognition.target_payment_event_id IS DISTINCT FROM event_fact.id
    OR recognition.target_source_type IS DISTINCT FROM event_fact.source_type
    OR recognition.target_source_id IS DISTINCT FROM event_fact.source_id
    OR recognition.target_idempotency_key IS DISTINCT FROM event_fact.idempotency_key
    OR recognition.evidence_fingerprint IS DISTINCT FROM event_fact.evidence_fingerprint
    OR recognition.merchant_id IS DISTINCT FROM event_fact.merchant_id
    OR recognition.store_id IS DISTINCT FROM event_fact.store_id
    OR recognition.order_id IS DISTINCT FROM event_fact.order_id
    OR recognition.source_commercial_revision_id IS DISTINCT FROM event_fact.commercial_revision_id
    OR recognition.currency_code IS DISTINCT FROM event_fact.currency_code
    OR recognition.minor_unit_exponent IS DISTINCT FROM event_fact.minor_unit_exponent
    OR recognition.amount_minor IS DISTINCT FROM event_fact.amount_minor
    OR recognition.economic_occurred_at IS DISTINCT FROM event_fact.source_occurred_at
    OR NEW.source_reference IS DISTINCT FROM recognition.owner_declaration_reference_sha256
    OR NEW.evidence_fingerprint IS DISTINCT FROM recognition.evidence_fingerprint
    OR NEW.source_occurred_at IS DISTINCT FROM recognition.economic_occurred_at
    OR event_fact.metadata->>'historicalManifestSha256' IS DISTINCT FROM recognition.manifest_sha256
  THEN
    RAISE EXCEPTION 'historical bank recognition event/evidence is not manifest-bound'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    pending.id AS pending_event_id,
    pending.merchant_id,
    pending.store_id,
    pending.order_id,
    pending.commercial_revision_id,
    pending.kind,
    pending.status,
    pending.method,
    pending.evidence_type,
    pending.evidence_fingerprint,
    pending.source_type,
    pending.amount_minor,
    pending.currency_code,
    pending.minor_unit_exponent,
    obligations.id AS obligation_id,
    obligations.obligation_kind,
    obligations.amount_minor AS obligation_amount_minor,
    COALESCE((
      SELECT SUM(allocations.amount_minor)
      FROM app.payment_event_allocations allocations
      JOIN app.payment_events allocation_events
        ON allocation_events.id = allocations.payment_event_id
      WHERE allocations.obligation_id = obligations.id
        AND allocations.allocation_kind = 'collection'
        AND allocation_events.status = 'posted'
    ), 0) AS collected_minor,
    EXISTS (
      SELECT 1 FROM app.payment_event_component_allocations components
      WHERE components.payment_event_id = pending.id
    ) AS has_full_components,
    EXISTS (
      SELECT 1 FROM app.payment_correction_component_deltas deltas
      WHERE deltas.payment_event_id = pending.id
    ) AS has_correction_delta
  INTO STRICT prior_pending
  FROM app.payment_events pending
  JOIN app.commercial_obligations obligations
    ON obligations.id = recognition.source_obligation_id
   AND obligations.merchant_id = pending.merchant_id
   AND obligations.store_id = pending.store_id
   AND obligations.order_id = pending.order_id
   AND obligations.commercial_revision_id = pending.commercial_revision_id
  WHERE pending.id = recognition.source_pending_payment_event_id
  FOR KEY SHARE OF pending, obligations;

  IF prior_pending.merchant_id IS DISTINCT FROM recognition.merchant_id
    OR prior_pending.store_id IS DISTINCT FROM recognition.store_id
    OR prior_pending.order_id IS DISTINCT FROM recognition.order_id
    OR prior_pending.commercial_revision_id IS DISTINCT FROM recognition.source_commercial_revision_id
    OR prior_pending.kind <> 'charge'
    OR prior_pending.status <> 'pending'
    OR prior_pending.method <> 'manual_bank'
    OR prior_pending.evidence_type IS NOT NULL
    OR prior_pending.evidence_fingerprint IS NOT NULL
    OR prior_pending.amount_minor <> recognition.amount_minor
    OR prior_pending.currency_code <> recognition.currency_code
    OR prior_pending.minor_unit_exponent <> recognition.minor_unit_exponent
    OR prior_pending.obligation_amount_minor <> recognition.amount_minor
    OR prior_pending.collected_minor <> 0
  THEN
    RAISE EXCEPTION 'historical bank recognition prior pending state drift'
      USING ERRCODE = '23514';
  END IF;

  IF recognition.recognition_kind = 'initial' AND (
      prior_pending.source_type <> 'order_created'
      OR prior_pending.obligation_kind <> 'order_charge'
      OR NOT prior_pending.has_full_components
      OR prior_pending.has_correction_delta
    ) THEN
    RAISE EXCEPTION 'historical initial recognition has invalid pending lineage'
      USING ERRCODE = '23514';
  END IF;
  IF recognition.recognition_kind = 'positive_correction' AND (
      prior_pending.source_type <> 'order_correction'
      OR prior_pending.obligation_kind <> 'order_correction_charge'
      OR prior_pending.has_full_components
      OR NOT prior_pending.has_correction_delta
    ) THEN
    RAISE EXCEPTION 'historical correction recognition has invalid pending lineage'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

-- Preserve v1 correction lineage and add only owner-recognized historical
-- corrections, which are independently bound by the evidence trigger above.
CREATE OR REPLACE FUNCTION app.assert_payment_correction_component_delta()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  event_scope RECORD;
  base_revision RECORD;
  effective_revision RECORD;
  prior_pending RECORD;
  prior_pending_id_text TEXT;
  lineage_valid BOOLEAN := false;
BEGIN
  SELECT merchant_id, store_id, order_id, commercial_revision_id, kind,
         status, method, evidence_type, currency_code, minor_unit_exponent,
         amount_minor, source_type, source_id, metadata
  INTO STRICT event_scope
  FROM app.payment_events
  WHERE id = NEW.payment_event_id;

  SELECT revision, currency_code, minor_unit_exponent
  INTO STRICT base_revision
  FROM app.order_commercial_revisions
  WHERE id = NEW.base_commercial_revision_id;

  SELECT revision, currency_code, minor_unit_exponent, source_type, source_id
  INTO STRICT effective_revision
  FROM app.order_commercial_revisions
  WHERE id = NEW.effective_commercial_revision_id;

  IF event_scope.source_type = 'order_correction' THEN
    lineage_valid := event_scope.source_id = effective_revision.source_id;
  ELSIF event_scope.source_type IN (
    'manual_bank_correction_confirmation',
    'historical_bank_correction_recognition'
  ) THEN
    prior_pending_id_text := event_scope.metadata->>'priorPendingPaymentEventId';
    IF prior_pending_id_text IS NOT NULL
      AND prior_pending_id_text ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      AND event_scope.metadata->>'correctionId' = effective_revision.source_id
      AND event_scope.metadata->>'contractFingerprint' = NEW.contract_fingerprint
    THEN
      SELECT merchant_id, store_id, order_id, commercial_revision_id, kind,
             status, method, evidence_type, evidence_fingerprint,
             currency_code, minor_unit_exponent, amount_minor,
             source_type, source_id
      INTO prior_pending
      FROM app.payment_events
      WHERE id = prior_pending_id_text::uuid;

      lineage_valid := FOUND
        AND prior_pending.merchant_id = event_scope.merchant_id
        AND prior_pending.store_id = event_scope.store_id
        AND prior_pending.order_id = event_scope.order_id
        AND prior_pending.commercial_revision_id = event_scope.commercial_revision_id
        AND prior_pending.kind = 'charge'
        AND prior_pending.status = 'pending'
        AND prior_pending.method = 'manual_bank'
        AND prior_pending.evidence_type IS NULL
        AND prior_pending.evidence_fingerprint IS NULL
        AND prior_pending.currency_code = event_scope.currency_code
        AND prior_pending.minor_unit_exponent = event_scope.minor_unit_exponent
        AND prior_pending.amount_minor = event_scope.amount_minor
        AND prior_pending.source_type = 'order_correction'
        AND prior_pending.source_id = effective_revision.source_id
        AND event_scope.status = 'posted'
        AND event_scope.method = 'manual_bank'
        AND (
          (event_scope.source_type = 'manual_bank_correction_confirmation'
            AND event_scope.evidence_type = 'manual_verified')
          OR (event_scope.source_type = 'historical_bank_correction_recognition'
            AND event_scope.evidence_type = 'owner_historical_recognition')
        );
    END IF;
  END IF;

  IF event_scope.merchant_id <> NEW.merchant_id
    OR event_scope.store_id <> NEW.store_id
    OR event_scope.order_id <> NEW.order_id
    OR event_scope.commercial_revision_id <> NEW.effective_commercial_revision_id
    OR event_scope.kind <> 'charge'
    OR NOT lineage_valid
    OR effective_revision.source_type <> 'order_correction'
    OR effective_revision.revision <> base_revision.revision + 1
    OR event_scope.currency_code <> NEW.currency_code
    OR event_scope.minor_unit_exponent <> NEW.minor_unit_exponent
    OR base_revision.currency_code <> NEW.currency_code
    OR effective_revision.currency_code <> NEW.currency_code
    OR base_revision.minor_unit_exponent <> NEW.minor_unit_exponent
    OR effective_revision.minor_unit_exponent <> NEW.minor_unit_exponent
    OR event_scope.amount_minor <> NEW.total_delta_minor
  THEN
    RAISE EXCEPTION 'payment correction delta does not match event/revision lineage'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.payment_event_component_allocations full_components
    WHERE full_components.payment_event_id = NEW.payment_event_id
  ) THEN
    RAISE EXCEPTION 'payment event cannot have full and signed component bases'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS historical_bank_recognition_evidence_trg
  ON app.payment_event_evidence;
CREATE TRIGGER historical_bank_recognition_evidence_trg
  BEFORE INSERT ON app.payment_event_evidence
  FOR EACH ROW EXECUTE FUNCTION app.assert_historical_bank_recognition_evidence();

-- The evidence trigger binds the receipt to its manifest row. These two
-- triggers additionally make the financial basis immutable at the DB seam:
-- a privileged caller cannot substitute a same-total component split or a
-- different signed correction delta after that proof has been accepted.
CREATE OR REPLACE FUNCTION app.assert_historical_bank_recognition_components()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  recognition RECORD;
  source_components RECORD;
BEGIN
  SELECT items.* INTO recognition
  FROM app.payment_events events
  JOIN app.historical_bank_recognition_items items
    ON items.id = (events.metadata->>'historicalRecognitionItemId')::uuid
  WHERE events.id = NEW.payment_event_id
    AND events.evidence_type = 'owner_historical_recognition';
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF recognition.recognition_kind <> 'initial' THEN
    RAISE EXCEPTION 'historical correction recognition cannot use full components'
      USING ERRCODE = '23514';
  END IF;
  SELECT tax_mode, merchandise_gross_minor, discount_minor, merchandise_net_minor,
         shipping_minor, merchandise_vat_minor, shipping_vat_minor, vat_minor,
         unclassified_minor, total_minor
  INTO STRICT source_components
  FROM app.payment_event_component_allocations
  WHERE payment_event_id = recognition.source_pending_payment_event_id;
  IF NEW.commercial_revision_id <> recognition.source_commercial_revision_id
    OR NEW.merchant_id <> recognition.merchant_id
    OR NEW.store_id <> recognition.store_id
    OR NEW.currency_code <> recognition.currency_code
    OR NEW.minor_unit_exponent <> recognition.minor_unit_exponent
    OR NEW.tax_mode <> source_components.tax_mode
    OR NEW.merchandise_gross_minor <> source_components.merchandise_gross_minor
    OR NEW.discount_minor <> source_components.discount_minor
    OR NEW.merchandise_net_minor <> source_components.merchandise_net_minor
    OR NEW.shipping_minor <> source_components.shipping_minor
    OR NEW.merchandise_vat_minor <> source_components.merchandise_vat_minor
    OR NEW.shipping_vat_minor <> source_components.shipping_vat_minor
    OR NEW.vat_minor <> source_components.vat_minor
    OR NEW.unclassified_minor <> source_components.unclassified_minor
    OR NEW.total_minor <> source_components.total_minor
  THEN
    RAISE EXCEPTION 'historical initial recognition component basis drift'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_historical_bank_recognition_correction_delta()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  recognition RECORD;
  source_delta RECORD;
BEGIN
  SELECT items.* INTO recognition
  FROM app.payment_events events
  JOIN app.historical_bank_recognition_items items
    ON items.id = (events.metadata->>'historicalRecognitionItemId')::uuid
  WHERE events.id = NEW.payment_event_id
    AND events.evidence_type = 'owner_historical_recognition';
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF recognition.recognition_kind <> 'positive_correction' THEN
    RAISE EXCEPTION 'historical initial recognition cannot use a signed correction delta'
      USING ERRCODE = '23514';
  END IF;
  SELECT base_commercial_revision_id, effective_commercial_revision_id, currency_code,
         minor_unit_exponent, tax_mode, merchandise_gross_delta_minor,
         discount_delta_minor, merchandise_net_delta_minor, shipping_delta_minor,
         merchandise_vat_delta_minor, shipping_vat_delta_minor, vat_delta_minor,
         unclassified_delta_minor, total_delta_minor, base_snapshot_fingerprint,
         effective_snapshot_fingerprint, contract_fingerprint
  INTO STRICT source_delta
  FROM app.payment_correction_component_deltas
  WHERE payment_event_id = recognition.source_pending_payment_event_id;
  IF NEW.merchant_id <> recognition.merchant_id
    OR NEW.store_id <> recognition.store_id
    OR NEW.order_id <> recognition.order_id
    OR NEW.base_commercial_revision_id <> recognition.base_commercial_revision_id
    OR NEW.effective_commercial_revision_id <> recognition.source_commercial_revision_id
    OR NEW.base_commercial_revision_id <> source_delta.base_commercial_revision_id
    OR NEW.effective_commercial_revision_id <> source_delta.effective_commercial_revision_id
    OR NEW.currency_code <> source_delta.currency_code
    OR NEW.minor_unit_exponent <> source_delta.minor_unit_exponent
    OR NEW.tax_mode <> source_delta.tax_mode
    OR NEW.merchandise_gross_delta_minor <> source_delta.merchandise_gross_delta_minor
    OR NEW.discount_delta_minor <> source_delta.discount_delta_minor
    OR NEW.merchandise_net_delta_minor <> source_delta.merchandise_net_delta_minor
    OR NEW.shipping_delta_minor <> source_delta.shipping_delta_minor
    OR NEW.merchandise_vat_delta_minor <> source_delta.merchandise_vat_delta_minor
    OR NEW.shipping_vat_delta_minor <> source_delta.shipping_vat_delta_minor
    OR NEW.vat_delta_minor <> source_delta.vat_delta_minor
    OR NEW.unclassified_delta_minor <> source_delta.unclassified_delta_minor
    OR NEW.total_delta_minor <> source_delta.total_delta_minor
    OR NEW.base_snapshot_fingerprint <> source_delta.base_snapshot_fingerprint
    OR NEW.effective_snapshot_fingerprint <> source_delta.effective_snapshot_fingerprint
    OR NEW.contract_fingerprint <> source_delta.contract_fingerprint
  THEN
    RAISE EXCEPTION 'historical correction recognition delta basis drift'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS historical_bank_recognition_components_trg
  ON app.payment_event_component_allocations;
CREATE TRIGGER historical_bank_recognition_components_trg
  BEFORE INSERT ON app.payment_event_component_allocations
  FOR EACH ROW EXECUTE FUNCTION app.assert_historical_bank_recognition_components();

DROP TRIGGER IF EXISTS historical_bank_recognition_correction_delta_trg
  ON app.payment_correction_component_deltas;
CREATE TRIGGER historical_bank_recognition_correction_delta_trg
  BEFORE INSERT ON app.payment_correction_component_deltas
  FOR EACH ROW EXECUTE FUNCTION app.assert_historical_bank_recognition_correction_delta();

REVOKE ALL ON app.historical_bank_recognition_runs FROM PUBLIC;
REVOKE ALL ON app.historical_bank_recognition_items FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.reject_historical_bank_recognition_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.assert_historical_bank_recognition_evidence() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.assert_historical_bank_recognition_components() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.assert_historical_bank_recognition_correction_delta() FROM PUBLIC;
