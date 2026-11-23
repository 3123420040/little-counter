-- 029_customer_refund_payables.sql
-- Customer refund liability, append-only lifecycle and exact payout allocation.
--
-- Safety boundary:
--   * no historical payable is inferred or opened;
--   * the dedicated semantic liability account is not vendor payable 3311;
--   * commercial obligation reduction and cash/bank payout are separate facts;
--   * balances are derived from immutable open/clear events, never mutated;
--   * every payout clear is tied to one verified posted refund payment event.

INSERT INTO accounting.accounts (code, name, type, description)
VALUES (
  'CUSTOMER_REFUND_PAYABLE',
  'Phải trả hoàn tiền khách hàng',
  'liability',
  'Semantic customer-refund liability. Never use vendor payable 3311.'
)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type,
  description = EXCLUDED.description,
  is_active = true;

CREATE TABLE IF NOT EXISTS app.customer_refund_payables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES public."order"(id) ON DELETE RESTRICT,
  commercial_revision_id UUID NOT NULL,
  payable_kind TEXT NOT NULL CHECK (
    payable_kind IN (
      'negative_correction',
      'shipping_decrease',
      'order_cancellation',
      'manual_refund'
    )
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
  UNIQUE (merchant_id, store_id, source_type, source_id, payable_kind),
  UNIQUE (merchant_id, store_id, id)
);

CREATE TABLE IF NOT EXISTS app.customer_refund_payable_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payable_id UUID NOT NULL REFERENCES app.customer_refund_payables(id) ON DELETE RESTRICT,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('open', 'clear')),
  clearance_kind TEXT CHECK (
    clearance_kind IS NULL OR clearance_kind IN ('commercial_offset', 'payout')
  ),
  payment_event_id UUID REFERENCES app.payment_events(id) ON DELETE RESTRICT,
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 3),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key <> ''),
  source_type TEXT NOT NULL CHECK (source_type <> ''),
  source_id TEXT NOT NULL CHECK (source_id <> ''),
  source_occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (merchant_id, store_id, payable_id)
    REFERENCES app.customer_refund_payables(merchant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, store_id, payment_event_id)
    REFERENCES app.payment_events(merchant_id, store_id, id) ON DELETE RESTRICT,
  CHECK (
    (event_kind = 'open' AND clearance_kind IS NULL AND payment_event_id IS NULL)
    OR
    (event_kind = 'clear' AND clearance_kind = 'commercial_offset' AND payment_event_id IS NULL)
    OR
    (event_kind = 'clear' AND clearance_kind = 'payout' AND payment_event_id IS NOT NULL)
  ),
  UNIQUE (merchant_id, store_id, idempotency_key),
  UNIQUE (merchant_id, store_id, source_type, source_id, event_kind, payable_id),
  UNIQUE (merchant_id, store_id, id)
);

CREATE TABLE IF NOT EXISTS app.customer_refund_payout_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payable_id UUID NOT NULL REFERENCES app.customer_refund_payables(id) ON DELETE RESTRICT,
  payable_event_id UUID NOT NULL REFERENCES app.customer_refund_payable_events(id) ON DELETE RESTRICT,
  payment_event_id UUID NOT NULL REFERENCES app.payment_events(id) ON DELETE RESTRICT,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 3),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key <> ''),
  allocated_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, store_id, payable_id)
    REFERENCES app.customer_refund_payables(merchant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, store_id, payable_event_id)
    REFERENCES app.customer_refund_payable_events(merchant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, store_id, payment_event_id)
    REFERENCES app.payment_events(merchant_id, store_id, id) ON DELETE RESTRICT,
  UNIQUE (merchant_id, store_id, idempotency_key),
  UNIQUE (payable_event_id),
  UNIQUE (payable_id, payment_event_id, payable_event_id)
);

CREATE INDEX IF NOT EXISTS customer_refund_payables_scope_order_time_idx
  ON app.customer_refund_payables(
    merchant_id, store_id, order_id, source_occurred_at, id
  );
CREATE INDEX IF NOT EXISTS customer_refund_payable_events_payable_time_idx
  ON app.customer_refund_payable_events(
    merchant_id, store_id, payable_id, source_occurred_at, id
  );
CREATE INDEX IF NOT EXISTS customer_refund_payable_events_scope_time_idx
  ON app.customer_refund_payable_events(
    merchant_id, store_id, source_occurred_at, id
  );

CREATE OR REPLACE VIEW app.customer_refund_payable_balances
WITH (security_barrier = true)
AS
SELECT
  payable.merchant_id,
  payable.store_id,
  payable.order_id,
  payable.id AS payable_id,
  payable.commercial_revision_id,
  payable.payable_kind,
  payable.currency_code,
  payable.minor_unit_exponent,
  payable.amount_minor AS opened_minor,
  COALESCE(SUM(event.amount_minor) FILTER (WHERE event.event_kind = 'clear'), 0)::BIGINT
    AS cleared_minor,
  (
    payable.amount_minor
    - COALESCE(SUM(event.amount_minor) FILTER (WHERE event.event_kind = 'clear'), 0)
  )::BIGINT AS balance_minor,
  CASE
    WHEN COALESCE(SUM(event.amount_minor) FILTER (WHERE event.event_kind = 'clear'), 0) = 0
      THEN 'open'
    WHEN COALESCE(SUM(event.amount_minor) FILTER (WHERE event.event_kind = 'clear'), 0)
      = payable.amount_minor
      THEN 'cleared'
    ELSE 'partially_cleared'
  END AS status,
  payable.source_occurred_at,
  payable.recorded_at
FROM app.customer_refund_payables payable
LEFT JOIN app.customer_refund_payable_events event
  ON event.payable_id = payable.id
 AND event.event_kind = 'clear'
GROUP BY payable.id;

CREATE OR REPLACE FUNCTION app.assert_customer_refund_payable_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public."order" orders
    WHERE orders.id = NEW.order_id
      AND orders.merchant_id = NEW.merchant_id
      AND orders.store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'customer refund payable order scope mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_customer_refund_payable_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  payable_fact RECORD;
  payment_fact RECORD;
  cleared_total NUMERIC;
BEGIN
  SELECT merchant_id, store_id, order_id, currency_code, minor_unit_exponent, amount_minor
  INTO STRICT payable_fact
  FROM app.customer_refund_payables
  WHERE id = NEW.payable_id
  FOR UPDATE;

  IF payable_fact.merchant_id <> NEW.merchant_id
    OR payable_fact.store_id <> NEW.store_id
    OR payable_fact.order_id <> NEW.order_id
    OR payable_fact.currency_code <> NEW.currency_code
    OR payable_fact.minor_unit_exponent <> NEW.minor_unit_exponent
  THEN
    RAISE EXCEPTION 'customer refund payable event scope/currency mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(amount_minor), 0)
  INTO cleared_total
  FROM app.customer_refund_payable_events
  WHERE payable_id = NEW.payable_id AND event_kind = 'clear';

  IF NEW.event_kind = 'open' AND NEW.amount_minor <> payable_fact.amount_minor THEN
    RAISE EXCEPTION 'customer refund payable open event must equal payable amount'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_kind = 'clear' AND cleared_total + NEW.amount_minor > payable_fact.amount_minor THEN
    RAISE EXCEPTION 'customer refund payable clear exceeds open balance'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.payment_event_id IS NOT NULL THEN
    SELECT merchant_id, store_id, order_id, kind, status, currency_code,
           minor_unit_exponent, amount_minor
    INTO STRICT payment_fact
    FROM app.payment_events
    WHERE id = NEW.payment_event_id;
    IF payment_fact.merchant_id <> NEW.merchant_id
      OR payment_fact.store_id <> NEW.store_id
      OR payment_fact.order_id <> NEW.order_id
      OR payment_fact.kind <> 'refund'
      OR payment_fact.status <> 'posted'
      OR payment_fact.currency_code <> NEW.currency_code
      OR payment_fact.minor_unit_exponent <> NEW.minor_unit_exponent
      OR payment_fact.amount_minor < NEW.amount_minor
    THEN
      RAISE EXCEPTION 'customer refund payable payout event mismatch'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_customer_refund_payout_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  clear_fact RECORD;
BEGIN
  SELECT payable_id, payment_event_id, merchant_id, store_id, order_id,
         currency_code, minor_unit_exponent, amount_minor, event_kind, clearance_kind
  INTO STRICT clear_fact
  FROM app.customer_refund_payable_events
  WHERE id = NEW.payable_event_id;

  IF clear_fact.payable_id <> NEW.payable_id
    OR clear_fact.payment_event_id <> NEW.payment_event_id
    OR clear_fact.merchant_id <> NEW.merchant_id
    OR clear_fact.store_id <> NEW.store_id
    OR clear_fact.order_id <> NEW.order_id
    OR clear_fact.currency_code <> NEW.currency_code
    OR clear_fact.minor_unit_exponent <> NEW.minor_unit_exponent
    OR clear_fact.amount_minor <> NEW.amount_minor
    OR clear_fact.event_kind <> 'clear'
    OR clear_fact.clearance_kind <> 'payout'
  THEN
    RAISE EXCEPTION 'customer refund payout allocation does not match clear event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_customer_refund_payable_bundle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  open_count INT;
  payout_event_count INT;
  payout_allocation_count INT;
BEGIN
  SELECT COUNT(*) INTO open_count
  FROM app.customer_refund_payable_events
  WHERE payable_id = NEW.id
    AND event_kind = 'open'
    AND amount_minor = NEW.amount_minor;
  IF open_count <> 1 THEN
    RAISE EXCEPTION 'customer refund payable requires one exact open event'
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO payout_event_count
  FROM app.customer_refund_payable_events
  WHERE payable_id = NEW.id AND clearance_kind = 'payout';
  SELECT COUNT(*) INTO payout_allocation_count
  FROM app.customer_refund_payout_allocations
  WHERE payable_id = NEW.id;
  IF payout_event_count <> payout_allocation_count THEN
    RAISE EXCEPTION 'customer refund payable payout events/allocations mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_customer_refund_payout_event_bundle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  allocation_count INT;
BEGIN
  IF NEW.event_kind <> 'clear' OR NEW.clearance_kind <> 'payout' THEN
    RETURN NEW;
  END IF;
  SELECT COUNT(*) INTO allocation_count
  FROM app.customer_refund_payout_allocations allocation
  WHERE allocation.payable_event_id = NEW.id
    AND allocation.payable_id = NEW.payable_id
    AND allocation.payment_event_id = NEW.payment_event_id
    AND allocation.amount_minor = NEW.amount_minor;
  IF allocation_count <> 1 THEN
    RAISE EXCEPTION 'customer refund payout clear requires one exact allocation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.reject_immutable_customer_refund_fact_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'immutable customer refund fact % cannot be %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$function$;

DO $triggers$
DECLARE
  relation_name TEXT;
  trigger_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'customer_refund_payables',
    'customer_refund_payable_events',
    'customer_refund_payout_allocations'
  ]
  LOOP
    trigger_name := relation_name || '_immutable_trg';
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = format('app.%I', relation_name)::regclass
        AND tgname = trigger_name
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I '
        || 'FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_customer_refund_fact_mutation()',
        trigger_name,
        relation_name
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.customer_refund_payables'::regclass
      AND tgname = 'customer_refund_payables_scope_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER customer_refund_payables_scope_trg
      BEFORE INSERT ON app.customer_refund_payables
      FOR EACH ROW EXECUTE FUNCTION app.assert_customer_refund_payable_scope();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.customer_refund_payable_events'::regclass
      AND tgname = 'customer_refund_payable_events_validate_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER customer_refund_payable_events_validate_trg
      BEFORE INSERT ON app.customer_refund_payable_events
      FOR EACH ROW EXECUTE FUNCTION app.assert_customer_refund_payable_event();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.customer_refund_payout_allocations'::regclass
      AND tgname = 'customer_refund_payout_allocations_validate_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER customer_refund_payout_allocations_validate_trg
      BEFORE INSERT ON app.customer_refund_payout_allocations
      FOR EACH ROW EXECUTE FUNCTION app.assert_customer_refund_payout_allocation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.customer_refund_payables'::regclass
      AND tgname = 'customer_refund_payable_bundle_trg'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE CONSTRAINT TRIGGER customer_refund_payable_bundle_trg '
      || 'AFTER INSERT ON app.customer_refund_payables '
      || 'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
      || 'EXECUTE FUNCTION app.assert_customer_refund_payable_bundle()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.customer_refund_payable_events'::regclass
      AND tgname = 'customer_refund_payout_event_bundle_trg'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE CONSTRAINT TRIGGER customer_refund_payout_event_bundle_trg '
      || 'AFTER INSERT ON app.customer_refund_payable_events '
      || 'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
      || 'EXECUTE FUNCTION app.assert_customer_refund_payout_event_bundle()';
  END IF;
END;
$triggers$;

REVOKE UPDATE, DELETE ON app.customer_refund_payables FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.customer_refund_payable_events FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.customer_refund_payout_allocations FROM PUBLIC;
