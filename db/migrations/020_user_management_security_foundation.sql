-- 020_user_management_security_foundation.sql
-- Additive foundation for scoped user management, server-side session
-- invalidation, explicit platform grants, and actor-chain audit.

INSERT INTO app.permissions (id, description) VALUES
  ('profile:read', 'Read own operator profile and security state'),
  ('profile:write', 'Update own operator profile metadata'),
  ('profile:password_write', 'Change own operator password'),
  ('profile:telegram_write', 'Link or unlink own Telegram identity'),
  ('team:read', 'Read merchant team operators and memberships'),
  ('team:write', 'Create or update merchant team non-owner operators'),
  ('team:reset_password', 'Reset merchant team non-owner passwords'),
  ('platform_operator:read', 'Read platform-wide operators and security state'),
  ('platform_operator:reset_password', 'Reset operator password from platform administration'),
  ('platform_operator:suspend', 'Suspend or unsuspend an operator globally'),
  ('platform_membership:write', 'Grant or revoke platform-sensitive permissions'),
  ('platform_impersonation:start', 'Start read-only platform owner impersonation')
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO app.role_permissions (role, permission_id) VALUES
  ('staff', 'profile:read'),
  ('staff', 'profile:write'),
  ('staff', 'profile:password_write'),
  ('staff', 'profile:telegram_write'),
  ('manager', 'profile:read'),
  ('manager', 'profile:write'),
  ('manager', 'profile:password_write'),
  ('manager', 'profile:telegram_write'),
  ('manager', 'team:read'),
  ('manager', 'team:write'),
  ('manager', 'team:reset_password'),
  ('accountant', 'profile:read'),
  ('accountant', 'profile:write'),
  ('accountant', 'profile:password_write'),
  ('accountant', 'profile:telegram_write'),
  ('owner', 'profile:read'),
  ('owner', 'profile:write'),
  ('owner', 'profile:password_write'),
  ('owner', 'profile:telegram_write'),
  ('owner', 'team:read'),
  ('owner', 'team:write'),
  ('owner', 'team:reset_password')
ON CONFLICT (role, permission_id) DO NOTHING;

DO $$
BEGIN
  IF to_regclass('app.operator_memberships') IS NOT NULL THEN
    ALTER TABLE app.operator_memberships
      DROP CONSTRAINT IF EXISTS operator_memberships_status_check;
    ALTER TABLE app.operator_memberships
      ADD CONSTRAINT operator_memberships_status_check
      CHECK (status IN ('active', 'disabled', 'pending', 'revoked'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app.operator_security_state (
  operator_id TEXT PRIMARY KEY,
  requires_password_change BOOLEAN NOT NULL DEFAULT false,
  force_logout_after TIMESTAMPTZ,
  session_version INT NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  global_status TEXT NOT NULL DEFAULT 'active' CHECK (global_status IN ('active', 'suspended')),
  password_changed_at TIMESTAMPTZ,
  temporary_password_hash TEXT,
  temporary_password_expires_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app.operator_security_state (operator_id, password_changed_at, last_login_at)
SELECT operator_id, created_at, last_login_at
FROM medusa.staff_users
ON CONFLICT (operator_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS app.operator_profiles (
  operator_id TEXT PRIMARY KEY,
  email TEXT,
  normalized_email TEXT,
  phone_e164 TEXT,
  locale TEXT,
  avatar_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operator_profiles_normalized_email_idx
  ON app.operator_profiles(normalized_email)
  WHERE normalized_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.operator_explicit_permission_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id TEXT NOT NULL,
  permission_id TEXT NOT NULL REFERENCES app.permissions(id),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'merchant', 'store')),
  merchant_id TEXT,
  store_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_by TEXT NOT NULL,
  revoked_by TEXT,
  reason TEXT NOT NULL DEFAULT '',
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operator_explicit_permission_scope_check CHECK (
    (scope_type = 'platform' AND merchant_id IS NULL AND store_id IS NULL)
    OR (scope_type = 'merchant' AND merchant_id IS NOT NULL AND store_id IS NULL)
    OR (scope_type = 'store' AND merchant_id IS NOT NULL AND store_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS operator_explicit_permission_active_unique_idx
  ON app.operator_explicit_permission_grants(
    operator_id, permission_id, scope_type, COALESCE(merchant_id, ''), COALESCE(store_id, '')
  )
  WHERE status = 'active' AND valid_to IS NULL;

CREATE INDEX IF NOT EXISTS operator_explicit_permission_operator_idx
  ON app.operator_explicit_permission_grants(operator_id, status, valid_from DESC);

CREATE TABLE IF NOT EXISTS app.impersonation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actual_operator_id TEXT NOT NULL,
  effective_operator_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'read_only' CHECK (mode IN ('read_only')),
  reason TEXT NOT NULL,
  ticket_ref TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS impersonation_sessions_active_idx
  ON app.impersonation_sessions(actual_operator_id, effective_operator_id, expires_at)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS app.operator_identity_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('telegram')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operator_identity_link_tokens_operator_idx
  ON app.operator_identity_link_tokens(operator_id, provider, expires_at DESC);

DO $$
BEGIN
  IF to_regclass('audit.events') IS NOT NULL THEN
    ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS effective_actor_id TEXT;
    ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS actual_actor_id TEXT;
    ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS impersonation_session_id TEXT;
    ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS actor_chain JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS audit_actor_chain_idx
      ON audit.events(actual_actor_id, effective_actor_id, created_at DESC)
      WHERE actual_actor_id IS NOT NULL OR effective_actor_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS audit_impersonation_session_idx
      ON audit.events(impersonation_session_id, created_at DESC)
      WHERE impersonation_session_id IS NOT NULL;
  END IF;
END $$;
