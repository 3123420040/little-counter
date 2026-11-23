-- 028_order_collection_revision_and_cursor_indexes.sql
-- Durable store-scoped cursor invalidation and immutable-field order indexes.
--
-- This migration initializes one zero-valued state row per existing store. It
-- does not rewrite orders, corrections, payments or accounting facts. Every
-- later list-visible order/effective-revision transaction bumps its store at
-- most once when the application supplies one mutation id (the transaction id
-- is the fail-safe fallback).

CREATE TABLE IF NOT EXISTS app.order_collection_revisions (
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id) ON UPDATE CASCADE,
  store_id TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, store_id),
  FOREIGN KEY (merchant_id, store_id)
    REFERENCES app.stores(merchant_id, id) ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS app.order_collection_revision_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  mutation_id TEXT NOT NULL CHECK (mutation_id <> ''),
  source_relation TEXT NOT NULL CHECK (source_relation <> ''),
  source_action TEXT NOT NULL CHECK (
    source_action IN ('insert', 'update', 'delete')
  ),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, store_id)
    REFERENCES app.order_collection_revisions(merchant_id, store_id)
    ON DELETE RESTRICT,
  UNIQUE (merchant_id, store_id, mutation_id),
  UNIQUE (merchant_id, store_id, revision)
);

INSERT INTO app.order_collection_revisions (merchant_id, store_id, revision, updated_at)
SELECT stores.merchant_id, stores.id, 0, clock_timestamp()
FROM app.stores stores
ON CONFLICT (merchant_id, store_id) DO NOTHING;

CREATE OR REPLACE VIEW app.order_collection_revision_vector
WITH (security_barrier = true)
AS
SELECT
  stores.merchant_id,
  stores.id AS store_id,
  COALESCE(revisions.revision, 0)::BIGINT AS revision,
  revisions.updated_at
FROM app.stores stores
LEFT JOIN app.order_collection_revisions revisions
  ON revisions.merchant_id = stores.merchant_id
 AND revisions.store_id = stores.id;

CREATE OR REPLACE FUNCTION app.bump_order_collection_revision(
  p_merchant_id TEXT,
  p_store_id TEXT,
  p_mutation_id TEXT,
  p_source_relation TEXT,
  p_source_action TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $function$
DECLARE
  current_revision BIGINT;
  existing_revision BIGINT;
  next_revision BIGINT;
BEGIN
  IF p_merchant_id IS NULL OR p_merchant_id = ''
    OR p_store_id IS NULL OR p_store_id = ''
    OR p_mutation_id IS NULL OR p_mutation_id = ''
    OR p_source_relation IS NULL OR p_source_relation = ''
    OR p_source_action NOT IN ('insert', 'update', 'delete')
  THEN
    RAISE EXCEPTION 'collection revision bump requires exact scope/mutation/source'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.stores
    WHERE merchant_id = p_merchant_id AND id = p_store_id
  ) THEN
    RAISE EXCEPTION 'collection revision store is not owned by merchant'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO app.order_collection_revisions (
    merchant_id,
    store_id,
    revision,
    updated_at
  )
  VALUES (p_merchant_id, p_store_id, 0, clock_timestamp())
  ON CONFLICT (merchant_id, store_id) DO NOTHING;

  SELECT revision
  INTO STRICT current_revision
  FROM app.order_collection_revisions
  WHERE merchant_id = p_merchant_id AND store_id = p_store_id
  FOR UPDATE;

  SELECT revision
  INTO existing_revision
  FROM app.order_collection_revision_events
  WHERE merchant_id = p_merchant_id
    AND store_id = p_store_id
    AND mutation_id = p_mutation_id;
  IF FOUND THEN
    RETURN existing_revision;
  END IF;

  UPDATE app.order_collection_revisions
  SET
    revision = app.order_collection_revisions.revision + 1,
    updated_at = clock_timestamp()
  WHERE merchant_id = p_merchant_id AND store_id = p_store_id
  RETURNING revision INTO next_revision;

  INSERT INTO app.order_collection_revision_events (
    merchant_id,
    store_id,
    revision,
    mutation_id,
    source_relation,
    source_action,
    changed_at
  )
  VALUES (
    p_merchant_id,
    p_store_id,
    next_revision,
    p_mutation_id,
    p_source_relation,
    p_source_action,
    clock_timestamp()
  );

  RETURN next_revision;
END;
$function$;

CREATE OR REPLACE FUNCTION app.invalidate_order_collection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  target_merchant_id TEXT;
  target_store_id TEXT;
  mutation_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
    OR NEW.store_id IS DISTINCT FROM OLD.store_id
  ) THEN
    RAISE EXCEPTION 'order tenant scope is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    target_merchant_id := OLD.merchant_id;
    target_store_id := OLD.store_id;
  ELSE
    target_merchant_id := NEW.merchant_id;
    target_store_id := NEW.store_id;
  END IF;

  IF target_merchant_id IS NULL OR target_store_id IS NULL THEN
    RAISE EXCEPTION 'list-visible mutation is missing merchant/store scope'
      USING ERRCODE = '23514';
  END IF;

  mutation_id := NULLIF(
    current_setting('app.collection_mutation_id', true),
    ''
  );
  IF mutation_id IS NULL THEN
    mutation_id := format(
      'tx:%s:%s:%s',
      txid_current(),
      target_merchant_id,
      target_store_id
    );
  END IF;

  PERFORM app.bump_order_collection_revision(
    target_merchant_id,
    target_store_id,
    mutation_id,
    format('%I.%I', TG_TABLE_SCHEMA, TG_TABLE_NAME),
    lower(TG_OP)
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.guard_order_collection_revision_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order collection revision state cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
    OR NEW.store_id IS DISTINCT FROM OLD.store_id
    OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'order collection revision must advance by exactly one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.reject_collection_revision_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'order collection revision event is immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_collection_revision_event_pair()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.order_collection_revision_events event
    WHERE event.merchant_id = NEW.merchant_id
      AND event.store_id = NEW.store_id
      AND event.revision = NEW.revision
  ) THEN
    RAISE EXCEPTION 'revision advance lacks immutable mutation event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DO $triggers$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.order_collection_revisions'::regclass
      AND tgname = 'order_collection_revision_event_pair_trg'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE CONSTRAINT TRIGGER order_collection_revision_event_pair_trg '
      || 'AFTER UPDATE ON app.order_collection_revisions '
      || 'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW '
      || 'EXECUTE FUNCTION app.assert_collection_revision_event_pair()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public."order"'::regclass
      AND tgname = 'order_collection_invalidation_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER order_collection_invalidation_trg
      AFTER INSERT OR UPDATE OR DELETE ON public."order"
      FOR EACH ROW EXECUTE FUNCTION app.invalidate_order_collection();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.order_commercial_revisions'::regclass
      AND tgname = 'order_commercial_revision_collection_invalidation_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER order_commercial_revision_collection_invalidation_trg
      AFTER INSERT ON app.order_commercial_revisions
      FOR EACH ROW EXECUTE FUNCTION app.invalidate_order_collection();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.order_collection_revisions'::regclass
      AND tgname = 'order_collection_revision_state_guard_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER order_collection_revision_state_guard_trg
      BEFORE UPDATE OR DELETE ON app.order_collection_revisions
      FOR EACH ROW EXECUTE FUNCTION app.guard_order_collection_revision_state();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'app.order_collection_revision_events'::regclass
      AND tgname = 'order_collection_revision_events_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER order_collection_revision_events_immutable_trg
      BEFORE UPDATE OR DELETE ON app.order_collection_revision_events
      FOR EACH ROW EXECUTE FUNCTION app.reject_collection_revision_event_mutation();
  END IF;
END;
$triggers$;

CREATE INDEX IF NOT EXISTS order_scope_created_id_cursor_idx
  ON public."order"(merchant_id, store_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS order_scope_status_created_id_cursor_idx
  ON public."order"(merchant_id, store_id, status, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS order_scope_display_id_cursor_idx
  ON public."order"(
    merchant_id,
    store_id,
    lower(custom_display_id) text_pattern_ops,
    created_at DESC,
    id DESC
  )
  WHERE deleted_at IS NULL AND custom_display_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS order_collection_revision_events_scope_time_idx
  ON app.order_collection_revision_events(
    merchant_id,
    store_id,
    changed_at DESC,
    revision DESC
  );

REVOKE DELETE ON app.order_collection_revisions FROM PUBLIC;
REVOKE UPDATE, DELETE ON app.order_collection_revision_events FROM PUBLIC;
