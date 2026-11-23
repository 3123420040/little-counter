-- Expand fee components without rewriting immutable revisions, events or hashes.
-- Deploy explicit V1 projections in both target and recovery before applying.
DO $migration$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['order_commercial_revision_components', 'payment_event_component_allocations'] LOOP
    EXECUTE format('ALTER TABLE app.%I
      ADD COLUMN IF NOT EXISTS component_version SMALLINT NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS payment_fee_minor BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS payment_fee_vat_minor BIGINT NOT NULL DEFAULT 0', relation_name);
    EXECUTE format('ALTER TABLE app.%I
      DROP CONSTRAINT IF EXISTS %I,
      DROP CONSTRAINT IF EXISTS %I,
      DROP CONSTRAINT IF EXISTS %I', relation_name,
      relation_name || '_check2', relation_name || '_check3', relation_name || '_check4');
    EXECUTE format('ALTER TABLE app.%I
      ADD CONSTRAINT payment_fee_version_v2_check CHECK (
        component_version IN (1,2)
        AND payment_fee_minor BETWEEN 0 AND 9007199254740991
        AND payment_fee_vat_minor BETWEEN 0 AND 9007199254740991
        AND (component_version = 2 OR (payment_fee_minor = 0 AND payment_fee_vat_minor = 0))
      ),
      ADD CONSTRAINT payment_fee_vat_v2_check CHECK (
        vat_minor = merchandise_vat_minor + shipping_vat_minor + payment_fee_vat_minor
      ),
      ADD CONSTRAINT payment_fee_inclusive_v2_check CHECK (
        tax_mode <> ''inclusive'' OR (
          merchandise_vat_minor <= merchandise_net_minor
          AND shipping_vat_minor <= shipping_minor AND payment_fee_vat_minor <= payment_fee_minor
        )
      ),
      ADD CONSTRAINT payment_fee_total_v2_check CHECK (
        merchandise_net_minor + shipping_minor + payment_fee_minor + unclassified_minor
        + CASE tax_mode WHEN ''exclusive'' THEN vat_minor ELSE 0 END = total_minor
      )', relation_name);
  END LOOP;
END;
$migration$;

ALTER TABLE app.payment_correction_component_deltas
  ADD COLUMN IF NOT EXISTS component_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS payment_fee_delta_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_fee_vat_delta_minor BIGINT NOT NULL DEFAULT 0,
  DROP CONSTRAINT IF EXISTS payment_correction_component_deltas_check1,
  DROP CONSTRAINT IF EXISTS payment_correction_component_deltas_check2,
  ADD CONSTRAINT payment_fee_delta_version_v2_check CHECK (
    component_version IN (1,2)
    AND payment_fee_delta_minor BETWEEN -9007199254740991 AND 9007199254740991
    AND payment_fee_vat_delta_minor BETWEEN -9007199254740991 AND 9007199254740991
    AND (component_version = 2 OR (payment_fee_delta_minor = 0 AND payment_fee_vat_delta_minor = 0))
  ),
  ADD CONSTRAINT payment_fee_delta_vat_v2_check CHECK (
    vat_delta_minor = merchandise_vat_delta_minor + shipping_vat_delta_minor + payment_fee_vat_delta_minor
  ),
  ADD CONSTRAINT payment_fee_delta_total_v2_check CHECK (
    merchandise_net_delta_minor + shipping_delta_minor + payment_fee_delta_minor + unclassified_delta_minor
    + CASE tax_mode WHEN 'exclusive' THEN vat_delta_minor ELSE 0 END = total_delta_minor
  );

CREATE OR REPLACE FUNCTION app.assert_payment_component_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE event_scope RECORD;
BEGIN
  SELECT merchant_id, store_id, commercial_revision_id, currency_code, minor_unit_exponent, amount_minor
  INTO STRICT event_scope FROM app.payment_events WHERE id = NEW.payment_event_id;
  IF event_scope.merchant_id <> NEW.merchant_id OR event_scope.store_id <> NEW.store_id
    OR event_scope.commercial_revision_id <> NEW.commercial_revision_id
    OR event_scope.currency_code <> NEW.currency_code OR event_scope.minor_unit_exponent <> NEW.minor_unit_exponent
    OR event_scope.amount_minor <> NEW.total_minor THEN
    RAISE EXCEPTION 'payment component allocation does not equal its event headline' USING ERRCODE = '23514';
  END IF;
  IF NEW.component_version = 2 AND NOT EXISTS (
    SELECT 1 FROM app.order_commercial_revision_components c
    JOIN app.order_commercial_revisions r ON r.id = c.revision_id
    WHERE c.revision_id = NEW.commercial_revision_id
      AND c.merchant_id = NEW.merchant_id AND c.store_id = NEW.store_id
      AND c.currency_code = NEW.currency_code AND c.minor_unit_exponent = NEW.minor_unit_exponent
      AND c.component_version = 2 AND r.metadata->>'bundleVersion' = '2'
      AND (c.tax_mode, c.merchandise_gross_minor, c.discount_minor, c.merchandise_net_minor,
        c.shipping_minor, c.merchandise_vat_minor, c.shipping_vat_minor, c.vat_minor,
        c.unclassified_minor, c.total_minor, c.payment_fee_minor, c.payment_fee_vat_minor)
        IS NOT DISTINCT FROM
        (NEW.tax_mode, NEW.merchandise_gross_minor, NEW.discount_minor, NEW.merchandise_net_minor,
        NEW.shipping_minor, NEW.merchandise_vat_minor, NEW.shipping_vat_minor, NEW.vat_minor,
        NEW.unclassified_minor, NEW.total_minor, NEW.payment_fee_minor, NEW.payment_fee_vat_minor)
  ) THEN
    RAISE EXCEPTION 'V2 payment components differ from immutable revision snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
