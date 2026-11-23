-- Agent 14: owner settings permission grants and audit tenant envelope.

INSERT INTO app.permissions (id, description) VALUES
  ('settings:read', 'Read merchant-owned settings'),
  ('settings:write', 'Update merchant-owned settings'),
  ('subscription:read', 'Read merchant subscription package state'),
  ('subscription:bill', 'Create package billing orders'),
  ('subscription:apply', 'Apply verified subscription purchases'),
  ('integration_config:read', 'Read integration configuration status without secrets'),
  ('integration_config:write', 'Write integration configuration secrets'),
  ('platform:read', 'Read platform administration data')
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO app.role_permissions (role, permission_id) VALUES
  ('owner', 'settings:read'),
  ('owner', 'settings:write'),
  ('owner', 'subscription:read'),
  ('owner', 'subscription:bill'),
  ('owner', 'integration_config:read')
ON CONFLICT (role, permission_id) DO NOTHING;

ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE audit.events ADD COLUMN IF NOT EXISTS store_id TEXT;

CREATE INDEX IF NOT EXISTS audit_merchant_subject_idx
  ON audit.events(merchant_id, subject_type, subject_id, created_at DESC)
  WHERE merchant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_store_subject_idx
  ON audit.events(store_id, subject_type, subject_id, created_at DESC)
  WHERE store_id IS NOT NULL;
