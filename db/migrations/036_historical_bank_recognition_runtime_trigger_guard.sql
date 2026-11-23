-- 036_historical_bank_recognition_runtime_trigger_guard.sql
--
-- The 035 component/delta guards were intentionally attached to every new
-- financial component row.  Their initial registry join, however, required a
-- normal runtime checkout to read the append-only historical registry.  That
-- conflicts with 035's least-privilege ACL.  This additive repair first reads
-- only the payment event (which the runtime already owns) and touches the
-- historical registry solely for the narrow owner-historical evidence path.
-- No role receives a new grant, and an attempted forged historical path still
-- fails closed at the registry boundary.

CREATE OR REPLACE FUNCTION app.assert_historical_bank_recognition_components()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
DECLARE
  event_evidence_type TEXT;
  recognition RECORD;
  source_components RECORD;
BEGIN
  SELECT events.evidence_type INTO STRICT event_evidence_type
  FROM app.payment_events events
  WHERE events.id = NEW.payment_event_id;
  IF event_evidence_type IS DISTINCT FROM 'owner_historical_recognition' THEN
    RETURN NEW;
  END IF;

  SELECT items.* INTO STRICT recognition
  FROM app.payment_events events
  JOIN app.historical_bank_recognition_items items
    ON items.id = (events.metadata->>'historicalRecognitionItemId')::uuid
  WHERE events.id = NEW.payment_event_id;
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
  event_evidence_type TEXT;
  recognition RECORD;
  source_delta RECORD;
BEGIN
  SELECT events.evidence_type INTO STRICT event_evidence_type
  FROM app.payment_events events
  WHERE events.id = NEW.payment_event_id;
  IF event_evidence_type IS DISTINCT FROM 'owner_historical_recognition' THEN
    RETURN NEW;
  END IF;

  SELECT items.* INTO STRICT recognition
  FROM app.payment_events events
  JOIN app.historical_bank_recognition_items items
    ON items.id = (events.metadata->>'historicalRecognitionItemId')::uuid
  WHERE events.id = NEW.payment_event_id;
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

REVOKE EXECUTE ON FUNCTION app.assert_historical_bank_recognition_components() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.assert_historical_bank_recognition_correction_delta() FROM PUBLIC;
