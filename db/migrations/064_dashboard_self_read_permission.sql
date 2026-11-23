-- Staff can read only their own sales dashboard.  This is intentionally a
-- separate permission from reports:read: reports:read exposes accounting and
-- other whole-store financial evidence.
INSERT INTO app.permissions (id, description)
VALUES ('dashboard:self:read', 'Read the operator self-only sales dashboard')
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.role_permissions (role, permission_id)
VALUES ('staff', 'dashboard:self:read')
ON CONFLICT (role, permission_id) DO NOTHING;

-- Existing read-only report identities need names, never credential columns.
DO $$ DECLARE reader RECORD; BEGIN
  FOR reader IN SELECT rolname FROM pg_roles
    WHERE rolcanlogin AND NOT rolsuper
      AND 'default_transaction_read_only=on' = ANY(COALESCE(rolconfig, ARRAY[]::text[]))
      AND has_table_privilege(oid, 'app.operator_memberships', 'SELECT')
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA medusa TO %I', reader.rolname);
    EXECUTE format('GRANT SELECT (operator_id, display_name) ON medusa.staff_users TO %I', reader.rolname);
  END LOOP;
END $$;
