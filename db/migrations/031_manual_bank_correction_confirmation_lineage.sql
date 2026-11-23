-- 031_manual_bank_correction_confirmation_lineage.sql
-- Additive trigger-contract extension for an immutable posted manual-bank
-- confirmation of an already persisted pending positive-correction charge.
--
-- This migration:
--   * never updates or backfills a business fact;
--   * preserves accepted migration 026-029 bytes;
--   * permits a second signed-delta basis only when it is byte-for-byte bound
--     to the exact prior pending correction event and commercial revisions;
--   * leaves all existing order_correction delta validation unchanged.

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
  ELSIF event_scope.source_type = 'manual_bank_correction_confirmation' THEN
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
        AND event_scope.evidence_type = 'manual_verified';
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

COMMENT ON FUNCTION app.assert_payment_correction_component_delta() IS
  'Validates original positive-correction deltas and immutable manual-bank correction confirmations bound to the exact prior pending event.';
