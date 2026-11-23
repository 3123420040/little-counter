-- Remote MCP credentials are independent of OAuth AS clients. Raw bearer keys
-- never enter this table; key lifecycle/audit is owned by the control transaction.
CREATE TABLE integration.partner_mcp_keys (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-f0-9]{32}$'),
  integration_id TEXT NOT NULL REFERENCES integration.integrations(id),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 128),
  secret_hash TEXT NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  scopes TEXT[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 6 AND array_position(scopes,NULL) IS NULL
    AND scopes <@ ARRAY['partner:read','catalog:read','inventory:read','orders:read','orders:quote','orders:write']::text[]
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 256),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT CHECK (length(revoked_by) BETWEEN 1 AND 256),
  UNIQUE (integration_id,id),
  CHECK (expires_at > created_at),
  CHECK ((status='active' AND revoked_at IS NULL AND revoked_by IS NULL)
    OR (status='revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_at>=created_at))
);
CREATE INDEX partner_mcp_keys_integration_status_idx ON integration.partner_mcp_keys(integration_id,status,id);

CREATE FUNCTION integration.guard_mcp_key() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'MCP credentials must be revoked, not deleted' USING ERRCODE='23514';
  END IF;
  IF (NEW.id,NEW.integration_id,NEW.secret_hash,NEW.created_at,NEW.created_by)
    IS DISTINCT FROM (OLD.id,OLD.integration_id,OLD.secret_hash,OLD.created_at,OLD.created_by)
    OR NEW.expires_at>OLD.expires_at OR OLD.status='revoked' THEN
    RAISE EXCEPTION 'MCP credential identity and revocation are immutable; rotate instead' USING ERRCODE='23514';
  END IF;
  NEW.version := OLD.version;
  IF (NEW.scopes,NEW.status,NEW.expires_at) IS DISTINCT FROM (OLD.scopes,OLD.status,OLD.expires_at) THEN
    NEW.version := OLD.version+1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_mcp_key_identity BEFORE UPDATE OR DELETE ON integration.partner_mcp_keys
  FOR EACH ROW EXECUTE FUNCTION integration.guard_mcp_key();
REVOKE ALL ON integration.partner_mcp_keys FROM PUBLIC;
REVOKE ALL ON FUNCTION integration.guard_mcp_key() FROM PUBLIC;
GRANT SELECT ON integration.partner_mcp_keys TO snus_partner_api;
GRANT SELECT,INSERT,UPDATE ON integration.partner_mcp_keys TO snus_partner_control;
