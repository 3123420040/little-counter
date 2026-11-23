-- 026_effective_orders_and_payment_events.sql
-- Immutable commercial-revision and payment-event foundation.
--
-- Expand-only safety boundary:
--   * creates schema objects for future writes; it does not rewrite any order,
--     correction, payment, journal, stock or historical financial row;
--   * stores amounts as non-negative integer minor units with an explicit
--     currency/exponent;
--   * a posted collection/negative event requires approved evidence identity;
--   * all facts are tenant/store scoped and immutable after insert;
--   * customer-refund-payable state is intentionally deferred to DB-029.

CREATE UNIQUE INDEX IF NOT EXISTS stores_merchant_id_id_unique_idx
  ON app.stores(merchant_id, id);

CREATE TABLE IF NOT EXISTS app.order_commercial_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES public."order"(id) ON DELETE RESTRICT,
  revision INT NOT NULL CHECK (revision >= 0),
  source_type TEXT NOT NULL CHECK (
    source_type IN ('original_order', 'order_correction', 'order_cancellation')
  ),
  source_id TEXT NOT NULL,
  source_correction_id TEXT,
  commercial_state TEXT NOT NULL CHECK (commercial_state IN ('active', 'cancelled')),
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 3),
  effective_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key <> ''),
  data_quality TEXT NOT NULL DEFAULT 'complete'
    CHECK (data_quality IN ('complete', 'partial', 'unavailable')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (merchant_id, store_id)
    REFERENCES app.stores(merchant_id, id) ON UPDATE CASCADE,
  UNIQUE (merchant_id, store_id, order_id, revision),
  UNIQUE (merchant_id, store_id, source_type, source_id),
  UNIQUE (merchant_id, store_id, idempotency_key),
  UNIQUE (merchant_id, store_id, order_id, id),
  UNIQUE (merchant_id, store_id, order_id, revision, id)
);

CREATE TABLE IF NOT EXISTS app.order_commercial_revision_components (
  revision_id UUID PRIMARY KEY
    REFERENCES app.order_commercial_revisions(id) ON DELETE RESTRICT,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  revision INT NOT NULL CHECK (revision >= 0),
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 3),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  merchandise_gross_minor BIGINT NOT NULL CHECK (merchandise_gross_minor >= 0),
  discount_minor BIGINT NOT NULL CHECK (
    discount_minor >= 0 AND discount_minor <= merchandise_gross_minor
  ),
  merchandise_net_minor BIGINT NOT NULL CHECK (
    merchandise_net_minor = merchandise_gross_minor - discount_minor
  ),
  shipping_minor BIGINT NOT NULL CHECK (shipping_minor >= 0),
  merchandise_vat_minor BIGINT NOT NULL CHECK (merchandise_vat_minor >= 0),
  shipping_vat_minor BIGINT NOT NULL CHECK (shipping_vat_minor >= 0),
  vat_minor BIGINT NOT NULL CHECK (vat_minor >= 0),
  CHECK (vat_minor = merchandise_vat_minor + shipping_vat_minor),
  CHECK (
    tax_mode <> 'inclusive'
    OR (
      merchandise_vat_minor <= merchandise_net_minor
      AND shipping_vat_minor <= shipping_minor
    )
  ),
  unclassified_minor BIGINT NOT NULL CHECK (unclassified_minor >= 0),
  total_minor BIGINT NOT NULL CHECK (
    merchandise_gross_minor - discount_minor
      + shipping_minor
      + unclassified_minor
      + CASE tax_mode WHEN 'exclusive' THEN vat_minor ELSE 0 END
    = total_minor
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, store_id, order_id, revision)
    REFERENCES app.order_commercial_revisions(merchant_id, store_id, order_id, revision)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS app.order_commercial_revision_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id UUID NOT NULL,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  revision INT NOT NULL CHECK (revision >= 0),
  line_key TEXT NOT NULL CHECK (line_key <> ''),
  source_line_id TEXT,
  product_id TEXT,
  variant_id TEXT,
  sku_snapshot TEXT NOT NULL CHECK (sku_snapshot <> ''),
  title_snapshot TEXT NOT NULL CHECK (title_snapshot <> ''),
  archived_variant BOOLEAN NOT NULL DEFAULT false,
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor BIGINT NOT NULL CHECK (
    line_total_minor >= 0 AND line_total_minor = quantity::BIGINT * unit_price_minor
  ),
  cost_minor BIGINT CHECK (cost_minor IS NULL OR cost_minor >= 0),
  cost_evidence_id TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, store_id, order_id, revision, revision_id)
    REFERENCES app.order_commercial_revisions(
      merchant_id, store_id, order_id, revision, id
    )
    ON DELETE RESTRICT,
  CHECK ((cost_minor IS NULL) = (cost_evidence_id IS NULL)),
  UNIQUE (revision_id, line_key)
);

CREATE TABLE IF NOT EXISTS app.payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES public."order"(id) ON DELETE RESTRICT,
  commercial_revision_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('charge', 'refund', 'reversal', 'chargeback')),
  status TEXT NOT NULL CHECK (status IN ('posted', 'pending')),
  method TEXT NOT NULL CHECK (
    method IN ('cash', 'cod', 'manual_bank', 'provider', 'unknown')
  ),
  evidence_type TEXT CHECK (
    evidence_type IS NULL OR evidence_type IN (
      'cash_receipt',
      'cod_order_created',
      'manual_verified',
      'provider_webhook_success',
      'negative_collection_confirmed'
    )
  ),
  evidence_fingerprint TEXT CHECK (
    evidence_fingerprint IS NULL OR evidence_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 3),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key <> ''),
  source_type TEXT NOT NULL CHECK (source_type <> ''),
  source_id TEXT NOT NULL CHECK (source_id <> ''),
  source_occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (merchant_id, store_id)
    REFERENCES app.stores(merchant_id, id) ON UPDATE CASCADE,
  FOREIGN KEY (merchant_id, store_id, order_id, commercial_revision_id)
    REFERENCES app.order_commercial_revisions(merchant_id, store_id, order_id, id)
    ON DELETE RESTRICT,
  CHECK (
    status = 'pending'
    OR (
      evidence_type IS NOT NULL
      AND evidence_fingerprint IS NOT NULL
      AND (
        (kind = 'charge' AND method = 'cash' AND evidence_type = 'cash_receipt')
        OR (kind = 'charge' AND method = 'cod' AND evidence_type = 'cod_order_created')
        OR (kind = 'charge' AND method = 'manual_bank' AND evidence_type = 'manual_verified')
        OR (kind = 'charge' AND method = 'provider' AND evidence_type = 'provider_webhook_success')
        OR (kind IN ('refund', 'reversal', 'chargeback')
          AND evidence_type = 'negative_collection_confirmed')
      )
    )
  ),
  UNIQUE (merchant_id, store_id, idempotency_key),
  UNIQUE (merchant_id, store_id, source_type, source_id, kind),
  UNIQUE (merchant_id, store_id, id)
);

CREATE TABLE IF NOT EXISTS app.payment_event_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_event_id UUID NOT NULL REFERENCES app.payment_events(id) ON DELETE RESTRICT,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK (
    evidence_type IN (
      'cash_receipt',
      'cod_order_created',
      'manual_verified',
      'provider_webhook_success',
      'negative_collection_confirmed'
    )
  ),
  source_system TEXT NOT NULL CHECK (source_system <> ''),
  source_reference TEXT NOT NULL CHECK (source_reference <> ''),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('verified', 'rejected')),
  evidence_fingerprint TEXT NOT NULL CHECK (evidence_fingerprint ~ '^[a-f0-9]{64}$'),
  source_occurred_at TIMESTAMPTZ NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (merchant_id, store_id, payment_event_id)
    REFERENCES app.payment_events(merchant_id, store_id, id) ON DELETE RESTRICT,
  UNIQUE (merchant_id, store_id, source_system, source_reference),
  UNIQUE (payment_event_id, evidence_fingerprint)
);

CREATE TABLE IF NOT EXISTS app.payment_event_component_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_event_id UUID NOT NULL REFERENCES app.payment_events(id) ON DELETE RESTRICT,
  commercial_revision_id UUID NOT NULL
    REFERENCES app.order_commercial_revisions(id) ON DELETE RESTRICT,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 3),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  merchandise_gross_minor BIGINT NOT NULL CHECK (merchandise_gross_minor >= 0),
  discount_minor BIGINT NOT NULL CHECK (
    discount_minor >= 0 AND discount_minor <= merchandise_gross_minor
  ),
  merchandise_net_minor BIGINT NOT NULL CHECK (
    merchandise_net_minor = merchandise_gross_minor - discount_minor
  ),
  shipping_minor BIGINT NOT NULL CHECK (shipping_minor >= 0),
  merchandise_vat_minor BIGINT NOT NULL CHECK (merchandise_vat_minor >= 0),
  shipping_vat_minor BIGINT NOT NULL CHECK (shipping_vat_minor >= 0),
  vat_minor BIGINT NOT NULL CHECK (vat_minor >= 0),
  CHECK (vat_minor = merchandise_vat_minor + shipping_vat_minor),
  CHECK (
    tax_mode <> 'inclusive'
    OR (
      merchandise_vat_minor <= merchandise_net_minor
      AND shipping_vat_minor <= shipping_minor
    )
  ),
  unclassified_minor BIGINT NOT NULL CHECK (unclassified_minor >= 0),
  total_minor BIGINT NOT NULL CHECK (
    merchandise_gross_minor - discount_minor
      + shipping_minor
      + unclassified_minor
      + CASE tax_mode WHEN 'exclusive' THEN vat_minor ELSE 0 END
    = total_minor
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, store_id, payment_event_id)
    REFERENCES app.payment_events(merchant_id, store_id, id) ON DELETE RESTRICT,
  UNIQUE (payment_event_id)
);

-- A positive correction can contain negative component contributions (for
-- example a reduced shipping charge while merchandise increases). Keep that
-- signed lineage separate from the non-negative full snapshot above.
CREATE TABLE IF NOT EXISTS app.payment_correction_component_deltas (
  payment_event_id UUID PRIMARY KEY
    REFERENCES app.payment_events(id) ON DELETE RESTRICT,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  base_commercial_revision_id UUID NOT NULL
    REFERENCES app.order_commercial_revisions(id) ON DELETE RESTRICT,
  effective_commercial_revision_id UUID NOT NULL
    REFERENCES app.order_commercial_revisions(id) ON DELETE RESTRICT,
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 3),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  merchandise_gross_delta_minor BIGINT NOT NULL,
  discount_delta_minor BIGINT NOT NULL,
  merchandise_net_delta_minor BIGINT NOT NULL CHECK (
    merchandise_net_delta_minor = merchandise_gross_delta_minor - discount_delta_minor
  ),
  shipping_delta_minor BIGINT NOT NULL,
  merchandise_vat_delta_minor BIGINT NOT NULL,
  shipping_vat_delta_minor BIGINT NOT NULL,
  vat_delta_minor BIGINT NOT NULL CHECK (
    vat_delta_minor = merchandise_vat_delta_minor + shipping_vat_delta_minor
  ),
  unclassified_delta_minor BIGINT NOT NULL,
  total_delta_minor BIGINT NOT NULL CHECK (total_delta_minor > 0),
  CHECK (
    merchandise_net_delta_minor
      + shipping_delta_minor
      + unclassified_delta_minor
      + CASE tax_mode WHEN 'exclusive' THEN vat_delta_minor ELSE 0 END
    = total_delta_minor
  ),
  base_snapshot_fingerprint TEXT NOT NULL CHECK (
    base_snapshot_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  effective_snapshot_fingerprint TEXT NOT NULL CHECK (
    effective_snapshot_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  contract_fingerprint TEXT NOT NULL CHECK (
    contract_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, store_id, payment_event_id)
    REFERENCES app.payment_events(merchant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, store_id, order_id, base_commercial_revision_id)
    REFERENCES app.order_commercial_revisions(merchant_id, store_id, order_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, store_id, order_id, effective_commercial_revision_id)
    REFERENCES app.order_commercial_revisions(merchant_id, store_id, order_id, id)
    ON DELETE RESTRICT,
  CHECK (base_commercial_revision_id <> effective_commercial_revision_id)
);

CREATE TABLE IF NOT EXISTS app.commercial_obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES public."order"(id) ON DELETE RESTRICT,
  commercial_revision_id UUID NOT NULL,
  obligation_kind TEXT NOT NULL CHECK (
    obligation_kind IN ('order_charge', 'order_correction_charge')
  ),
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 3),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key <> ''),
  source_type TEXT NOT NULL CHECK (source_type <> ''),
  source_id TEXT NOT NULL CHECK (source_id <> ''),
  source_occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (merchant_id, store_id)
    REFERENCES app.stores(merchant_id, id) ON UPDATE CASCADE,
  FOREIGN KEY (merchant_id, store_id, order_id, commercial_revision_id)
    REFERENCES app.order_commercial_revisions(merchant_id, store_id, order_id, id)
    ON DELETE RESTRICT,
  UNIQUE (merchant_id, store_id, idempotency_key),
  UNIQUE (merchant_id, store_id, source_type, source_id, obligation_kind),
  UNIQUE (merchant_id, store_id, id)
);

CREATE TABLE IF NOT EXISTS app.payment_event_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  obligation_id UUID NOT NULL REFERENCES app.commercial_obligations(id) ON DELETE RESTRICT,
  payment_event_id UUID NOT NULL REFERENCES app.payment_events(id) ON DELETE RESTRICT,
  allocation_kind TEXT NOT NULL CHECK (
    allocation_kind IN ('collection', 'refund', 'reversal', 'chargeback')
  ),
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 3),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key <> ''),
  allocated_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, store_id, obligation_id)
    REFERENCES app.commercial_obligations(merchant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, store_id, payment_event_id)
    REFERENCES app.payment_events(merchant_id, store_id, id) ON DELETE RESTRICT,
  UNIQUE (merchant_id, store_id, idempotency_key),
  UNIQUE (obligation_id, payment_event_id, allocation_kind)
);

CREATE INDEX IF NOT EXISTS order_commercial_revisions_scope_order_idx
  ON app.order_commercial_revisions(merchant_id, store_id, order_id, revision DESC);
CREATE INDEX IF NOT EXISTS order_commercial_revisions_scope_effective_idx
  ON app.order_commercial_revisions(merchant_id, store_id, effective_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS order_commercial_revision_lines_sku_idx
  ON app.order_commercial_revision_lines(
    merchant_id, store_id, lower(sku_snapshot) text_pattern_ops, revision_id
  );
CREATE INDEX IF NOT EXISTS order_commercial_revision_lines_title_idx
  ON app.order_commercial_revision_lines(
    merchant_id, store_id, lower(title_snapshot) text_pattern_ops, revision_id
  );
CREATE INDEX IF NOT EXISTS payment_events_scope_time_idx
  ON app.payment_events(merchant_id, store_id, source_occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS payment_events_scope_order_time_idx
  ON app.payment_events(merchant_id, store_id, order_id, source_occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS payment_events_scope_kind_status_time_idx
  ON app.payment_events(merchant_id, store_id, kind, status, source_occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS commercial_obligations_scope_order_time_idx
  ON app.commercial_obligations(merchant_id, store_id, order_id, source_occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS payment_event_allocations_obligation_time_idx
  ON app.payment_event_allocations(merchant_id, store_id, obligation_id, allocated_at, id);

CREATE OR REPLACE FUNCTION app.assert_order_financial_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public."order" o
    WHERE o.id = NEW.order_id
      AND o.merchant_id = NEW.merchant_id
      AND o.store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'financial fact order scope mismatch for order %', NEW.order_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_payment_allocation_scope_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  obligation_scope RECORD;
  event_scope RECORD;
  event_allocated NUMERIC;
  obligation_collected NUMERIC;
  obligation_negative NUMERIC;
BEGIN
  SELECT merchant_id, store_id, currency_code, minor_unit_exponent, amount_minor
  INTO STRICT obligation_scope
  FROM app.commercial_obligations
  WHERE id = NEW.obligation_id
  FOR UPDATE;

  SELECT merchant_id, store_id, currency_code, minor_unit_exponent, kind, amount_minor
  INTO STRICT event_scope
  FROM app.payment_events
  WHERE id = NEW.payment_event_id
  FOR UPDATE;

  IF obligation_scope.merchant_id <> NEW.merchant_id
    OR obligation_scope.store_id <> NEW.store_id
    OR event_scope.merchant_id <> NEW.merchant_id
    OR event_scope.store_id <> NEW.store_id
    OR obligation_scope.currency_code <> NEW.currency_code
    OR event_scope.currency_code <> NEW.currency_code
    OR obligation_scope.minor_unit_exponent <> NEW.minor_unit_exponent
    OR event_scope.minor_unit_exponent <> NEW.minor_unit_exponent
    OR event_scope.kind <> (CASE NEW.allocation_kind
      WHEN 'collection' THEN 'charge'
      ELSE NEW.allocation_kind
    END)
  THEN
    RAISE EXCEPTION 'payment allocation scope, currency or kind mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(amount_minor), 0)
  INTO event_allocated
  FROM app.payment_event_allocations
  WHERE payment_event_id = NEW.payment_event_id;
  IF event_allocated + NEW.amount_minor > event_scope.amount_minor THEN
    RAISE EXCEPTION 'allocation exceeds payment event amount'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    COALESCE(SUM(amount_minor) FILTER (WHERE allocation_kind = 'collection'), 0),
    COALESCE(SUM(amount_minor) FILTER (
      WHERE allocation_kind IN ('refund', 'reversal', 'chargeback')
    ), 0)
  INTO obligation_collected, obligation_negative
  FROM app.payment_event_allocations
  WHERE obligation_id = NEW.obligation_id;

  IF NEW.allocation_kind = 'collection'
    AND obligation_collected + NEW.amount_minor > obligation_scope.amount_minor
  THEN
    RAISE EXCEPTION 'collection allocation exceeds commercial obligation'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.allocation_kind IN ('refund', 'reversal', 'chargeback')
    AND obligation_negative + NEW.amount_minor > obligation_collected
  THEN
    RAISE EXCEPTION 'negative allocation exceeds recorded collection'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_payment_component_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  event_scope RECORD;
BEGIN
  SELECT
    merchant_id,
    store_id,
    commercial_revision_id,
    currency_code,
    minor_unit_exponent,
    amount_minor
  INTO STRICT event_scope
  FROM app.payment_events
  WHERE id = NEW.payment_event_id;

  IF event_scope.merchant_id <> NEW.merchant_id
    OR event_scope.store_id <> NEW.store_id
    OR event_scope.commercial_revision_id <> NEW.commercial_revision_id
    OR event_scope.currency_code <> NEW.currency_code
    OR event_scope.minor_unit_exponent <> NEW.minor_unit_exponent
    OR event_scope.amount_minor <> NEW.total_minor
  THEN
    RAISE EXCEPTION 'payment component allocation does not equal its event headline'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_payment_correction_component_delta()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  event_scope RECORD;
  base_revision RECORD;
  effective_revision RECORD;
BEGIN
  SELECT merchant_id, store_id, order_id, commercial_revision_id, kind,
         currency_code, minor_unit_exponent, amount_minor, source_type, source_id
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

  IF event_scope.merchant_id <> NEW.merchant_id
    OR event_scope.store_id <> NEW.store_id
    OR event_scope.order_id <> NEW.order_id
    OR event_scope.commercial_revision_id <> NEW.effective_commercial_revision_id
    OR event_scope.kind <> 'charge'
    OR event_scope.source_type <> 'order_correction'
    OR event_scope.source_id <> effective_revision.source_id
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

CREATE OR REPLACE FUNCTION app.assert_payment_event_evidence_match()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  event_fact RECORD;
BEGIN
  SELECT
    status,
    evidence_type,
    evidence_fingerprint,
    source_occurred_at
  INTO STRICT event_fact
  FROM app.payment_events
  WHERE id = NEW.payment_event_id;

  IF event_fact.evidence_type IS DISTINCT FROM NEW.evidence_type
    OR event_fact.evidence_fingerprint IS DISTINCT FROM NEW.evidence_fingerprint
    OR event_fact.source_occurred_at IS DISTINCT FROM NEW.source_occurred_at
    OR (event_fact.status = 'posted' AND NEW.verification_status <> 'verified')
  THEN
    RAISE EXCEPTION 'payment evidence does not match immutable event evidence identity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_commercial_revision_bundle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  component_fact RECORD;
  line_total NUMERIC;
BEGIN
  SELECT
    merchant_id,
    store_id,
    order_id,
    revision,
    currency_code,
    minor_unit_exponent,
    merchandise_gross_minor
  INTO component_fact
  FROM app.order_commercial_revision_components
  WHERE revision_id = NEW.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'commercial revision lacks component snapshot'
      USING ERRCODE = '23514';
  END IF;
  IF component_fact.merchant_id <> NEW.merchant_id
    OR component_fact.store_id <> NEW.store_id
    OR component_fact.order_id <> NEW.order_id
    OR component_fact.revision <> NEW.revision
    OR component_fact.currency_code <> NEW.currency_code
    OR component_fact.minor_unit_exponent <> NEW.minor_unit_exponent
  THEN
    RAISE EXCEPTION 'commercial revision component scope/currency mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(line_total_minor), 0)
  INTO line_total
  FROM app.order_commercial_revision_lines
  WHERE revision_id = NEW.id;
  IF line_total <> component_fact.merchandise_gross_minor THEN
    RAISE EXCEPTION 'commercial revision line total does not reconcile'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_posted_payment_event_bundle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  allocated_total NUMERIC;
  component_basis_count INT;
BEGIN
  IF NEW.status <> 'posted' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.payment_event_evidence evidence
    WHERE evidence.payment_event_id = NEW.id
      AND evidence.evidence_type = NEW.evidence_type
      AND evidence.evidence_fingerprint = NEW.evidence_fingerprint
      AND evidence.verification_status = 'verified'
      AND evidence.source_occurred_at = NEW.source_occurred_at
  ) THEN
    RAISE EXCEPTION 'posted payment event lacks verified exact evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.kind = 'charge' THEN
    SELECT
      (SELECT COUNT(*) FROM app.payment_event_component_allocations components
        WHERE components.payment_event_id = NEW.id
          AND components.commercial_revision_id = NEW.commercial_revision_id
          AND components.total_minor = NEW.amount_minor)
      +
      (SELECT COUNT(*) FROM app.payment_correction_component_deltas deltas
        WHERE deltas.payment_event_id = NEW.id
          AND deltas.effective_commercial_revision_id = NEW.commercial_revision_id
          AND deltas.total_delta_minor = NEW.amount_minor)
    INTO component_basis_count;
    IF component_basis_count <> 1 THEN
      RAISE EXCEPTION 'posted charge event requires exactly one component basis'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM app.payment_event_component_allocations components
      WHERE components.payment_event_id = NEW.id
    ) OR EXISTS (
      SELECT 1 FROM app.payment_correction_component_deltas deltas
      WHERE deltas.payment_event_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'posted negative payment event cannot carry a charge component basis'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT COALESCE(SUM(amount_minor), 0)
  INTO allocated_total
  FROM app.payment_event_allocations
  WHERE payment_event_id = NEW.id;
  IF allocated_total <> NEW.amount_minor THEN
    RAISE EXCEPTION 'posted payment event is not fully allocated to obligations'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.reject_immutable_financial_fact_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'immutable financial fact % cannot be %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$function$;

DO $triggers$
DECLARE
  relation_name TEXT;
  trigger_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'order_commercial_revisions',
    'order_commercial_revision_components',
    'order_commercial_revision_lines',
    'payment_events',
    'payment_event_evidence',
    'payment_event_component_allocations',
    'payment_correction_component_deltas',
    'commercial_obligations',
    'payment_event_allocations'
  ]
  LOOP
    trigger_name := relation_name || '_immutable_trg';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = format('app.%I', relation_name)::regclass
        AND tgname = trigger_name
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I '
        || 'FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_financial_fact_mutation()',
        trigger_name,
        relation_name
      );
    END IF;
  END LOOP;

  FOREACH relation_name IN ARRAY ARRAY[
    'order_commercial_revisions',
    'payment_events',
    'commercial_obligations'
  ]
  LOOP
    trigger_name := relation_name || '_scope_trg';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = format('app.%I', relation_name)::regclass
        AND tgname = trigger_name
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT ON app.%I '
        || 'FOR EACH ROW EXECUTE FUNCTION app.assert_order_financial_scope()',
        trigger_name,
        relation_name
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.payment_event_evidence'::regclass
      AND tgname = 'payment_event_evidence_match_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER payment_event_evidence_match_trg
      BEFORE INSERT ON app.payment_event_evidence
      FOR EACH ROW EXECUTE FUNCTION app.assert_payment_event_evidence_match();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.payment_correction_component_deltas'::regclass
      AND tgname = 'payment_correction_component_deltas_scope_amount_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER payment_correction_component_deltas_scope_amount_trg
      BEFORE INSERT ON app.payment_correction_component_deltas
      FOR EACH ROW EXECUTE FUNCTION app.assert_payment_correction_component_delta();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.payment_event_component_allocations'::regclass
      AND tgname = 'payment_event_component_allocations_scope_amount_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER payment_event_component_allocations_scope_amount_trg
      BEFORE INSERT ON app.payment_event_component_allocations
      FOR EACH ROW EXECUTE FUNCTION app.assert_payment_component_allocation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.payment_event_allocations'::regclass
      AND tgname = 'payment_event_allocations_scope_currency_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER payment_event_allocations_scope_currency_trg
      BEFORE INSERT ON app.payment_event_allocations
      FOR EACH ROW EXECUTE FUNCTION app.assert_payment_allocation_scope_currency();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.order_commercial_revisions'::regclass
      AND tgname = 'order_commercial_revision_bundle_trg'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE CONSTRAINT TRIGGER order_commercial_revision_bundle_trg '
      || 'AFTER INSERT ON app.order_commercial_revisions '
      || 'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
      || 'EXECUTE FUNCTION app.assert_commercial_revision_bundle()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.payment_events'::regclass
      AND tgname = 'posted_payment_event_bundle_trg'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE CONSTRAINT TRIGGER posted_payment_event_bundle_trg '
      || 'AFTER INSERT ON app.payment_events '
      || 'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
      || 'EXECUTE FUNCTION app.assert_posted_payment_event_bundle()';
  END IF;
END;
$triggers$;

REVOKE UPDATE, DELETE ON app.order_commercial_revisions FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.order_commercial_revision_components FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.order_commercial_revision_lines FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.payment_events FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.payment_event_evidence FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.payment_event_component_allocations FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.payment_correction_component_deltas FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.commercial_obligations FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.payment_event_allocations FROM PUBLIC;
