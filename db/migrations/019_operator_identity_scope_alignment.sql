-- 019_operator_identity_scope_alignment.sql
-- Align persisted Telegram operator identities with the runtime channel auth
-- model introduced for merchant-scoped Telegram sales.

ALTER TABLE app.operator_identities
  ADD COLUMN IF NOT EXISTS default_store_id TEXT,
  ADD COLUMN IF NOT EXISTS audit_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE app.operator_identities
SET audit_evidence = '{}'::jsonb
WHERE audit_evidence IS NULL;

ALTER TABLE app.operator_identities
  ALTER COLUMN audit_evidence SET DEFAULT '{}'::jsonb,
  ALTER COLUMN audit_evidence SET NOT NULL;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app'
      AND t.relname = 'operator_identities'
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname)::text[]
        FROM unnest(c.conkey) key(attnum)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.attnum
      ) IN (
        ARRAY['organization_id', 'provider', 'provider_user_id']::text[],
        ARRAY['operator_id', 'organization_id', 'provider']::text[]
      )
  LOOP
    EXECUTE format('ALTER TABLE app.operator_identities DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS operator_identities_legacy_provider_user_idx
  ON app.operator_identities(organization_id, provider, provider_user_id)
  WHERE merchant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS operator_identities_legacy_provider_operator_idx
  ON app.operator_identities(organization_id, provider, operator_id)
  WHERE merchant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS operator_identities_merchant_provider_user_idx
  ON app.operator_identities(merchant_id, provider, provider_user_id)
  WHERE merchant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS operator_identities_merchant_provider_operator_idx
  ON app.operator_identities(merchant_id, provider, operator_id)
  WHERE merchant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS operator_identities_default_store_idx
  ON app.operator_identities(default_store_id)
  WHERE default_store_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operator_identities_merchant_fk'
      AND conrelid = 'app.operator_identities'::regclass
  ) THEN
    ALTER TABLE app.operator_identities
      ADD CONSTRAINT operator_identities_merchant_fk
      FOREIGN KEY (merchant_id)
      REFERENCES app.merchants(id)
      ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operator_identities_default_store_fk'
      AND conrelid = 'app.operator_identities'::regclass
  ) THEN
    ALTER TABLE app.operator_identities
      ADD CONSTRAINT operator_identities_default_store_fk
      FOREIGN KEY (default_store_id)
      REFERENCES app.stores(id)
      ON UPDATE CASCADE;
  END IF;
END $$;
