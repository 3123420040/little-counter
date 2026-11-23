\set ON_ERROR_STOP on

-- This script is executed only inside the fenced Stage-2 maintenance window.
-- Passwords arrive as base64-encoded psql variables over stdin so they are not
-- stored in Git, the release packet, a temporary SQL file or process arguments.

\if :{?runtime_writer_role}
\else
  \echo 'runtime_writer_role is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role login contract failed'; END $$;
\endif
\if :{?runtime_writer_password_b64}
\else
  \echo 'runtime_writer_password_b64 is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role login contract failed'; END $$;
\endif
\if :{?ai_runtime_role}
\else
  \echo 'ai_runtime_role is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role login contract failed'; END $$;
\endif
\if :{?ai_runtime_password_b64}
\else
  \echo 'ai_runtime_password_b64 is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role login contract failed'; END $$;
\endif
\if :{?outbox_worker_role}
\else
  \echo 'outbox_worker_role is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role login contract failed'; END $$;
\endif
\if :{?outbox_worker_password_b64}
\else
  \echo 'outbox_worker_password_b64 is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role login contract failed'; END $$;
\endif
\if :{?report_reader_role}
\else
  \echo 'report_reader_role is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role login contract failed'; END $$;
\endif
\if :{?report_reader_password_b64}
\else
  \echo 'report_reader_password_b64 is required'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role login contract failed'; END $$;
\endif

BEGIN;

CREATE TEMP TABLE requested_runtime_role_logins (
  role_name text PRIMARY KEY,
  password_text text NOT NULL
) ON COMMIT DROP;

INSERT INTO requested_runtime_role_logins (role_name, password_text)
VALUES
  (
    :'runtime_writer_role',
    convert_from(decode(:'runtime_writer_password_b64', 'base64'), 'UTF8')
  ),
  (
    :'ai_runtime_role',
    convert_from(decode(:'ai_runtime_password_b64', 'base64'), 'UTF8')
  ),
  (
    :'outbox_worker_role',
    convert_from(decode(:'outbox_worker_password_b64', 'base64'), 'UTF8')
  ),
  (
    :'report_reader_role',
    convert_from(decode(:'report_reader_password_b64', 'base64'), 'UTF8')
  );

SELECT (
  count(*) = 4
  AND count(DISTINCT password_text) = 4
  AND bool_and(role_name ~ '^[a-z_][a-z0-9_]{0,62}$')
  AND bool_and(password_text ~ '^[A-Za-z0-9_-]{43}$')
  AND bool_and(role_name <> current_user)
) AS runtime_role_inputs_safe
FROM requested_runtime_role_logins
\gset

\if :runtime_role_inputs_safe
\else
  \echo 'runtime role names/passwords violate the production credential contract'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role login contract failed'; END $$;
\endif

SELECT CASE
  WHEN existing.oid IS NULL THEN format(
    'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
    requested.role_name,
    requested.password_text
  )
  ELSE format(
    'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
    requested.role_name,
    requested.password_text
  )
END
FROM requested_runtime_role_logins requested
LEFT JOIN pg_catalog.pg_roles existing
  ON existing.rolname = requested.role_name
ORDER BY requested.role_name
\gexec

SELECT format('ALTER ROLE %I RESET ALL', role_name)
FROM requested_runtime_role_logins
ORDER BY role_name
\gexec

SELECT (
  count(*) = 4
  AND bool_and(roles.rolcanlogin)
  AND bool_and(NOT roles.rolsuper)
  AND bool_and(NOT roles.rolcreatedb)
  AND bool_and(NOT roles.rolcreaterole)
  AND bool_and(NOT roles.rolinherit)
  AND bool_and(NOT roles.rolreplication)
  AND bool_and(NOT roles.rolbypassrls)
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members memberships
    JOIN pg_catalog.pg_roles member_role
      ON member_role.oid = memberships.member
    JOIN requested_runtime_role_logins requested_member
      ON requested_member.role_name = member_role.rolname
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relations
    JOIN pg_catalog.pg_roles owner_role
      ON owner_role.oid = relations.relowner
    JOIN requested_runtime_role_logins requested_owner
      ON requested_owner.role_name = owner_role.rolname
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc functions
    JOIN pg_catalog.pg_roles owner_role
      ON owner_role.oid = functions.proowner
    JOIN requested_runtime_role_logins requested_owner
      ON requested_owner.role_name = owner_role.rolname
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespaces
    JOIN pg_catalog.pg_roles owner_role
      ON owner_role.oid = namespaces.nspowner
    JOIN requested_runtime_role_logins requested_owner
      ON requested_owner.role_name = owner_role.rolname
  )
) AS runtime_role_logins_safe
FROM pg_catalog.pg_roles roles
JOIN requested_runtime_role_logins requested
  ON requested.role_name = roles.rolname
\gset

\if :runtime_role_logins_safe
\else
  \echo 'runtime role login postcondition failed'
  DO $$ BEGIN RAISE EXCEPTION 'runtime role login contract failed'; END $$;
\endif

SELECT role_name, 'safe_login' AS posture
FROM requested_runtime_role_logins
ORDER BY role_name;

COMMIT;
