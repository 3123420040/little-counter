\set ON_ERROR_STOP on

-- Required invocation (role passwords are created/rotated outside this file):
-- psql "$MIGRATION_DATABASE_URL" \
--   -v runtime_writer_role=snus_runtime_writer \
--   -v ai_runtime_role=snus_ai_runtime \
--   -v outbox_worker_role=snus_exact_outbox_worker \
--   -v report_reader_role=snus_report_reader \
--   -f scripts/provision-runtime-database-roles.sql
--
-- Read-only contract verification (never changes permanent ACLs):
--   add `-v verify_only=true` to the invocation above.

\if :{?runtime_writer_role}
\else
  \echo 'runtime_writer_role is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role contract failed'; END $$;
\endif
\if :{?ai_runtime_role}
\else
  \echo 'ai_runtime_role is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role contract failed'; END $$;
\endif
\if :{?outbox_worker_role}
\else
  \echo 'outbox_worker_role is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role contract failed'; END $$;
\endif
\if :{?report_reader_role}
\else
  \echo 'report_reader_role is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role contract failed'; END $$;
\endif
\if :{?verify_only}
\else
  \set verify_only false
\endif

SELECT (
  COUNT(*) = 4
  AND bool_and(rolcanlogin)
  AND bool_and(NOT rolsuper)
  AND bool_and(NOT rolcreatedb)
  AND bool_and(NOT rolcreaterole)
  AND bool_and(NOT rolreplication)
  AND bool_and(NOT rolbypassrls)
) AS runtime_roles_safe
FROM pg_catalog.pg_roles
WHERE rolname IN (
  :'runtime_writer_role', :'ai_runtime_role',
  :'outbox_worker_role', :'report_reader_role'
)
\gset

\if :runtime_roles_safe
\else
  \echo 'runtime roles must exist as four distinct safe LOGIN roles'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role contract failed'; END $$;
\endif

SELECT NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_proc procedure
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname IN ('app', 'outbox')
    AND owner_role.rolname IN (
      :'runtime_writer_role', :'ai_runtime_role',
      :'outbox_worker_role', :'report_reader_role'
    )
) AS runtime_owns_no_control_function
\gset

\if :runtime_owns_no_control_function
\else
  \echo 'a runtime role owns an app/outbox function; refusing unsafe grant topology'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role contract failed'; END $$;
\endif

\if :verify_only
\else
BEGIN;

GRANT CONNECT ON DATABASE :"DBNAME"
  TO :"runtime_writer_role", :"ai_runtime_role", :"outbox_worker_role", :"report_reader_role";

-- Keep provisioning self-contained even on a schema-only restore where ACL
-- statements were intentionally omitted. Narrow grants below are the only
-- executable app/outbox function capabilities available to runtime roles.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app, outbox FROM PUBLIC;

GRANT USAGE ON SCHEMA public, app, inventory, accounting, audit, notification, ai_module, outbox
  TO :"runtime_writer_role", :"ai_runtime_role", :"outbox_worker_role", :"report_reader_role";

-- The legacy Medusa extension schema is part of the main application writer
-- surface. Keep its movement ledger append-only and its operator identity
-- table non-deletable instead of granting broad schema-wide CRUD.
GRANT USAGE ON SCHEMA medusa TO :"runtime_writer_role";
REVOKE CREATE ON SCHEMA medusa FROM :"runtime_writer_role";
GRANT SELECT, INSERT, UPDATE ON medusa.staff_users TO :"runtime_writer_role";
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON medusa.staff_users
  FROM :"runtime_writer_role";
GRANT SELECT, INSERT ON medusa.stock_movements TO :"runtime_writer_role";
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON medusa.stock_movements
  FROM :"runtime_writer_role";

-- Application writer: retains the existing application surface, but canonical
-- facts, audit rows, collection-revision state and outbox control state are
-- append-only from this identity.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA
  public, app, inventory, accounting, audit, notification, ai_module
  TO :"runtime_writer_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA
  public, app, inventory, accounting, audit, notification, ai_module
  TO :"runtime_writer_role";
-- Additive partner release: preserve baseline provisioning before 041 exists.
SELECT set_config('app.partner_runtime_writer_role', :'runtime_writer_role', true);
DO $$ DECLARE writer TEXT:=current_setting('app.partner_runtime_writer_role'); BEGIN
  IF to_regprocedure('integration.lock_commerce_inputs(text,text[])') IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SCHEMA integration TO %I',writer);
    EXECUTE format('GRANT EXECUTE ON FUNCTION integration.lock_commerce_inputs(text,text[]) TO %I',writer);
  END IF;
END $$;
GRANT SELECT, INSERT ON outbox.events TO :"runtime_writer_role";
GRANT SELECT ON outbox.aggregate_sequences TO :"runtime_writer_role";
GRANT EXECUTE ON FUNCTION outbox.allocate_aggregate_sequence(text, text, text, text)
  TO :"runtime_writer_role";
REVOKE EXECUTE ON FUNCTION app.bump_order_collection_revision(
  text, text, text, text, text
) FROM
  PUBLIC,
  :"runtime_writer_role",
  :"ai_runtime_role",
  :"outbox_worker_role",
  :"report_reader_role";
GRANT EXECUTE ON FUNCTION app.bump_order_collection_revision(
  text, text, text, text, text
) TO :"runtime_writer_role";

REVOKE INSERT, UPDATE, DELETE ON
  app.order_collection_revisions,
  app.order_collection_revision_events
  FROM :"runtime_writer_role";
-- PostgreSQL row-locking SELECTs require UPDATE privilege. These four
-- canonical tables are intentionally lockable by the application writer for
-- financial serialization, while their always-enabled immutable triggers
-- still reject every attempted row mutation with SQLSTATE 55000.
GRANT UPDATE ON
  app.order_commercial_revisions,
  app.commercial_obligations,
  app.payment_events,
  app.customer_refund_payables
  TO :"runtime_writer_role";
REVOKE DELETE ON
  app.order_commercial_revisions,
  app.order_commercial_revision_components,
  app.order_commercial_revision_lines,
  app.commercial_obligations,
  app.payment_events,
  app.payment_event_evidence,
  app.payment_event_allocations,
  app.payment_event_component_allocations,
  app.payment_correction_component_deltas,
  app.customer_refund_payables,
  app.customer_refund_payable_events,
  app.customer_refund_payout_allocations,
  app.historical_reconciliation_runs,
  app.historical_reconciliation_items
  FROM :"runtime_writer_role";
REVOKE UPDATE ON
  app.order_commercial_revision_components,
  app.order_commercial_revision_lines,
  app.payment_event_evidence,
  app.payment_event_allocations,
  app.payment_event_component_allocations,
  app.payment_correction_component_deltas,
  app.customer_refund_payable_events,
  app.customer_refund_payout_allocations,
  app.historical_reconciliation_runs,
  app.historical_reconciliation_items
  FROM :"runtime_writer_role";
-- 035 is deliberately applied after the immutable 1.8/1.9 bootstrap in a
-- new release. The base role script must remain runnable before that additive
-- table pair exists, but must remove every writer capability once it does.
SELECT set_config('app.provision_runtime_writer_role', :'runtime_writer_role', true);
DO $$
DECLARE
  runtime_writer_role text := current_setting('app.provision_runtime_writer_role', true);
BEGIN
  IF to_regclass('app.historical_bank_recognition_runs') IS NOT NULL THEN
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON app.historical_bank_recognition_runs FROM %I',
      runtime_writer_role
    );
  END IF;
  IF to_regclass('app.historical_bank_recognition_items') IS NOT NULL THEN
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON app.historical_bank_recognition_items FROM %I',
      runtime_writer_role
    );
  END IF;
END;
$$;
REVOKE UPDATE, DELETE ON ALL TABLES IN SCHEMA audit FROM :"runtime_writer_role";

-- AI API: read access plus its owned AI decision tables. It cannot write
-- commercial/payment/accounting/outbox/audit facts.
GRANT SELECT ON ALL TABLES IN SCHEMA
  public, app, inventory, accounting, audit, notification, ai_module, outbox
  TO :"ai_runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai_module
  TO :"ai_runtime_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ai_module
  TO :"ai_runtime_role";

-- Dedicated exact worker: handler-specific destinations plus read access. The
-- claim/control columns remain inaccessible except through the three
-- SECURITY DEFINER CAS functions.
GRANT SELECT ON ALL TABLES IN SCHEMA
  public, app, inventory, accounting, audit, notification, ai_module, outbox
  TO :"outbox_worker_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA
  accounting, notification, ai_module
  TO :"outbox_worker_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA
  accounting, notification, ai_module
  TO :"outbox_worker_role";
GRANT INSERT ON app.product_variant_images, app.vision_scan_image_artifacts
  TO :"outbox_worker_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app
  TO :"outbox_worker_role";
GRANT UPDATE (metadata, updated_at) ON public.product
  TO :"outbox_worker_role";
GRANT INSERT ON audit.events TO :"outbox_worker_role";
GRANT EXECUTE ON FUNCTION outbox.claim_exact_events(text, integer, integer)
  TO :"outbox_worker_role";
GRANT EXECUTE ON FUNCTION outbox.complete_exact_event_claim(uuid, text, uuid, bigint)
  TO :"outbox_worker_role";
GRANT EXECUTE ON FUNCTION outbox.fail_exact_event_claim(
  uuid, text, uuid, bigint, text, text, timestamptz, boolean, text
) TO :"outbox_worker_role";
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA outbox FROM :"outbox_worker_role";

-- Report identity is defense-in-depth read only even if a later accidental
-- table grant is introduced.
GRANT USAGE ON SCHEMA medusa TO :"report_reader_role";
GRANT SELECT (operator_id, display_name) ON medusa.staff_users TO :"report_reader_role";
GRANT SELECT ON ALL TABLES IN SCHEMA
  public, app, inventory, accounting, audit, notification, ai_module, outbox
  TO :"report_reader_role";
ALTER ROLE :"report_reader_role" SET default_transaction_read_only = on;
ALTER ROLE :"report_reader_role" SET statement_timeout = '15s';
ALTER ROLE :"report_reader_role" SET lock_timeout = '2s';
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public, app, inventory, accounting, audit, notification, ai_module, outbox
  FROM :"report_reader_role";
REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA
  public, app, inventory, accounting, audit, notification, ai_module, outbox
  FROM :"report_reader_role";
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app, outbox FROM :"report_reader_role";

COMMIT;
\endif

-- Machine-readable positive and negative postconditions. This is also the
-- source of truth for read-only preflight (`verify_only=true`). Any row is a
-- release blocker, and psql exits non-zero instead of relying on log grep.
CREATE TEMP TABLE runtime_role_access_violations (
  role_name text NOT NULL,
  violation text NOT NULL
);

INSERT INTO runtime_role_access_violations (role_name, violation)
SELECT role_name, violation
FROM (
  SELECT :'runtime_writer_role' AS role_name,
    'missing_medusa_schema_usage' AS violation
  WHERE NOT has_schema_privilege(:'runtime_writer_role', 'medusa', 'USAGE')
  UNION ALL
  SELECT :'runtime_writer_role', 'unexpected_medusa_schema_create'
  WHERE has_schema_privilege(:'runtime_writer_role', 'medusa', 'CREATE')
  UNION ALL
  SELECT :'runtime_writer_role', 'missing_staff_users_select'
  WHERE NOT has_table_privilege(
    :'runtime_writer_role', 'medusa.staff_users', 'SELECT'
  )
  UNION ALL
  SELECT :'runtime_writer_role', 'missing_staff_users_insert'
  WHERE NOT has_table_privilege(
    :'runtime_writer_role', 'medusa.staff_users', 'INSERT'
  )
  UNION ALL
  SELECT :'runtime_writer_role', 'missing_staff_users_update'
  WHERE NOT has_table_privilege(
    :'runtime_writer_role', 'medusa.staff_users', 'UPDATE'
  )
  UNION ALL
  SELECT :'runtime_writer_role', 'unexpected_staff_users_control_privilege'
  WHERE has_table_privilege(
    :'runtime_writer_role', 'medusa.staff_users', 'DELETE'
  ) OR has_table_privilege(
    :'runtime_writer_role', 'medusa.staff_users', 'TRUNCATE'
  ) OR has_table_privilege(
    :'runtime_writer_role', 'medusa.staff_users', 'REFERENCES'
  ) OR has_table_privilege(
    :'runtime_writer_role', 'medusa.staff_users', 'TRIGGER'
  )
  UNION ALL
  SELECT :'runtime_writer_role', 'missing_stock_movements_select'
  WHERE NOT has_table_privilege(
    :'runtime_writer_role', 'medusa.stock_movements', 'SELECT'
  )
  UNION ALL
  SELECT :'runtime_writer_role', 'missing_stock_movements_insert'
  WHERE NOT has_table_privilege(
    :'runtime_writer_role', 'medusa.stock_movements', 'INSERT'
  )
  UNION ALL
  SELECT :'runtime_writer_role', 'unexpected_stock_movements_control_privilege'
  WHERE has_table_privilege(
    :'runtime_writer_role', 'medusa.stock_movements', 'UPDATE'
  ) OR has_table_privilege(
    :'runtime_writer_role', 'medusa.stock_movements', 'DELETE'
  ) OR has_table_privilege(
    :'runtime_writer_role', 'medusa.stock_movements', 'TRUNCATE'
  ) OR has_table_privilege(
    :'runtime_writer_role', 'medusa.stock_movements', 'REFERENCES'
  ) OR has_table_privilege(
    :'runtime_writer_role', 'medusa.stock_movements', 'TRIGGER'
  )
  UNION ALL
  SELECT :'runtime_writer_role',
    'missing_order_collection_revision_bump_execute'
  WHERE NOT has_function_privilege(
    :'runtime_writer_role',
    'app.bump_order_collection_revision(text,text,text,text,text)',
    'EXECUTE'
  )
  UNION ALL
  SELECT runtime_role.role_name,
    'unexpected_order_collection_revision_bump_execute'
  FROM (
    VALUES
      (:'ai_runtime_role'),
      (:'outbox_worker_role'),
      (:'report_reader_role')
  ) AS runtime_role(role_name)
  WHERE has_function_privilege(
    runtime_role.role_name,
    'app.bump_order_collection_revision(text,text,text,text,text)',
    'EXECUTE'
  )
  UNION ALL
  SELECT :'runtime_writer_role',
    'unexpected_order_collection_revision_bump_acl'
  WHERE NOT (
    SELECT
      -- v2.2 public booking writes the same canonical facts through its
      -- restricted role. Permit that explicit additional writer, never PUBLIC
      -- or AI/worker/report roles; baseline without partner remains valid.
      count(*) BETWEEN 1 AND 2
      AND bool_or(privilege.grantee = writer_role.oid)
      AND bool_and(
        (privilege.grantee = writer_role.oid
          OR COALESCE(privilege.grantee = to_regrole('snus_partner_api')::oid,false))
        AND NOT privilege.is_grantable
      )
    FROM pg_catalog.pg_proc procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) privilege
    CROSS JOIN pg_catalog.pg_roles writer_role
    WHERE procedure.oid =
      'app.bump_order_collection_revision(text,text,text,text,text)'::regprocedure
      AND privilege.privilege_type = 'EXECUTE'
      AND privilege.grantee <> procedure.proowner
      AND writer_role.rolname = :'runtime_writer_role'
  )
  UNION ALL
  SELECT :'report_reader_role', 'table_write'
  WHERE EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = :'report_reader_role'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  )
  UNION ALL
  SELECT :'outbox_worker_role', 'direct_outbox_write'
  WHERE EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = :'outbox_worker_role'
      AND table_schema = 'outbox'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  )
  UNION ALL
  SELECT :'runtime_writer_role', 'missing_lockable_immutable_update'
  WHERE EXISTS (
    SELECT 1
    FROM (VALUES
      ('order_commercial_revisions'),
      ('commercial_obligations'),
      ('payment_events'),
      ('customer_refund_payables')
    ) AS lockable(table_name)
    WHERE NOT has_table_privilege(
      :'runtime_writer_role', format('app.%I', lockable.table_name), 'UPDATE'
    )
  )
  UNION ALL
  SELECT :'runtime_writer_role', 'unsafe_lockable_immutable_control_privilege'
  WHERE EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = :'runtime_writer_role'
      AND table_schema = 'app'
      AND table_name IN (
        'order_commercial_revisions', 'commercial_obligations',
        'payment_events', 'customer_refund_payables'
      )
      AND privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  )
  UNION ALL
  SELECT :'runtime_writer_role', 'missing_lockable_immutable_trigger'
  WHERE EXISTS (
    SELECT 1
    FROM (VALUES
      ('order_commercial_revisions', 'order_commercial_revisions_immutable_trg'),
      ('commercial_obligations', 'commercial_obligations_immutable_trg'),
      ('payment_events', 'payment_events_immutable_trg'),
      ('customer_refund_payables', 'customer_refund_payables_immutable_trg')
    ) AS required_trigger(table_name, trigger_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger trigger
      WHERE trigger.tgrelid = format('app.%I', required_trigger.table_name)::regclass
        AND trigger.tgname = required_trigger.trigger_name
        AND trigger.tgenabled = 'O'
        AND NOT trigger.tgisinternal
    )
  )
  UNION ALL
  SELECT :'runtime_writer_role', 'non_lockable_immutable_update_or_delete'
  WHERE EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = :'runtime_writer_role'
      AND table_schema = 'app'
      AND table_name IN (
        'order_commercial_revision_components',
        'order_commercial_revision_lines',
        'payment_event_evidence', 'payment_event_allocations',
        'payment_event_component_allocations', 'payment_correction_component_deltas',
        'customer_refund_payable_events',
        'customer_refund_payout_allocations', 'historical_reconciliation_runs',
        'historical_reconciliation_items', 'order_collection_revisions',
        'order_collection_revision_events'
      )
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  )
  UNION ALL
  SELECT :'runtime_writer_role', 'historical_bank_registry_writer_capability'
  WHERE EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = :'runtime_writer_role'
      AND table_schema = 'app'
      AND table_name IN (
        'historical_bank_recognition_runs', 'historical_bank_recognition_items'
      )
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  )
) violations;

SELECT role_name, violation
FROM runtime_role_access_violations
ORDER BY role_name, violation;

SELECT NOT EXISTS (
  SELECT 1 FROM runtime_role_access_violations
) AS runtime_role_access_safe
\gset

\if :runtime_role_access_safe
\else
  \echo 'runtime role access postcondition failed'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role contract failed'; END $$;
\endif
