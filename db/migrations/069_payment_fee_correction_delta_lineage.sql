-- Preserve current035 confirmation/historical lineage and add exact V2 signed component checks.
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
  IF NEW.component_version = 2 AND NOT EXISTS (
    SELECT 1 FROM app.order_commercial_revision_components b
    JOIN app.order_commercial_revision_components e ON e.revision_id = NEW.effective_commercial_revision_id
    JOIN app.order_commercial_revisions r ON r.id = e.revision_id
    WHERE b.revision_id = NEW.base_commercial_revision_id
      AND b.merchant_id = NEW.merchant_id AND e.merchant_id = NEW.merchant_id
      AND b.store_id = NEW.store_id AND e.store_id = NEW.store_id
      AND b.order_id = NEW.order_id AND e.order_id = NEW.order_id
      AND b.currency_code = NEW.currency_code AND e.currency_code = NEW.currency_code
      AND b.minor_unit_exponent = NEW.minor_unit_exponent AND e.minor_unit_exponent = NEW.minor_unit_exponent
      AND b.tax_mode = NEW.tax_mode AND e.tax_mode = NEW.tax_mode
      AND e.component_version = 2 AND r.metadata->>'bundleVersion' = '2'
      AND b.component_version IN (1,2)
      AND (b.component_version = 2 OR (b.payment_fee_minor = 0 AND b.payment_fee_vat_minor = 0))
      AND (NEW.merchandise_gross_delta_minor, NEW.discount_delta_minor, NEW.merchandise_net_delta_minor,
        NEW.shipping_delta_minor, NEW.merchandise_vat_delta_minor, NEW.shipping_vat_delta_minor,
        NEW.vat_delta_minor, NEW.unclassified_delta_minor, NEW.total_delta_minor,
        NEW.payment_fee_delta_minor, NEW.payment_fee_vat_delta_minor)
        IS NOT DISTINCT FROM
        (e.merchandise_gross_minor-b.merchandise_gross_minor, e.discount_minor-b.discount_minor,
        e.merchandise_net_minor-b.merchandise_net_minor, e.shipping_minor-b.shipping_minor,
        e.merchandise_vat_minor-b.merchandise_vat_minor, e.shipping_vat_minor-b.shipping_vat_minor,
        e.vat_minor-b.vat_minor, e.unclassified_minor-b.unclassified_minor, e.total_minor-b.total_minor,
        e.payment_fee_minor-b.payment_fee_minor, e.payment_fee_vat_minor-b.payment_fee_vat_minor)
  ) THEN
    RAISE EXCEPTION 'V2 correction delta differs from immutable revision snapshots' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

-- CREATE OR REPLACE in067 must retain032's deterministic trigger search path.
ALTER FUNCTION app.assert_payment_component_allocation() SET search_path = pg_catalog, app;
REVOKE ALL ON FUNCTION app.assert_payment_component_allocation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assert_payment_correction_component_delta() FROM PUBLIC;
