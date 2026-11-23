-- Metadata-only command replay and durable maximum approval; no plaintext credential column.
CREATE TABLE integration.control_request_receipts (
  id UUID PRIMARY KEY,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
  operation TEXT NOT NULL CHECK(operation IN ('create_connection','issue_key','rotate_key','revoke_key','set_status')),
  target_integration_id TEXT NOT NULL DEFAULT '', target_key_id TEXT NOT NULL DEFAULT '',
  idempotency_key_sha256 TEXT NOT NULL CHECK(idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  result_integration_id TEXT NOT NULL, result_key_id TEXT,
  state TEXT NOT NULL DEFAULT 'completed' CHECK(state IN ('completed','tombstone')),
  created_at TIMESTAMPTZ NOT NULL, replay_until TIMESTAMPTZ NOT NULL,
  result_metadata JSONB,
  workflow_version TEXT, max_approved_profile TEXT CHECK(max_approved_profile IN ('read','commerce')),
  approved_scopes TEXT[], approved_store_ids TEXT[], preset_version TEXT,
  policy_id TEXT, policy_version INTEGER, policy_sha256 TEXT, readiness_sha256 TEXT,
  UNIQUE(environment,merchant_id,actor_id,operation,target_integration_id,target_key_id,idempotency_key_sha256),
  FOREIGN KEY(result_integration_id,merchant_id) REFERENCES integration.integrations(id,merchant_id),
  FOREIGN KEY(result_integration_id,result_key_id) REFERENCES integration.partner_mcp_keys(integration_id,id),
  FOREIGN KEY(merchant_id,policy_id,policy_version) REFERENCES integration.policies(merchant_id,id,version),
  CHECK((operation='create_connection' AND target_integration_id='' AND target_key_id='') OR
    (operation<>'create_connection' AND target_integration_id=result_integration_id)),
  CHECK((operation IN ('create_connection','issue_key') AND target_key_id='' AND result_key_id IS NOT NULL) OR
    (operation='rotate_key' AND target_key_id<>'' AND result_key_id IS NOT NULL AND target_key_id<>result_key_id) OR
    (operation='revoke_key' AND result_key_id IS NOT NULL AND target_key_id=result_key_id AND target_key_id<>'') OR
    (operation='set_status' AND target_key_id='' AND result_key_id IS NULL)),
  CHECK((state='completed' AND jsonb_typeof(result_metadata)='object' AND result_metadata IS NOT NULL) OR
    (state='tombstone' AND result_metadata IS NULL))
);
CREATE UNIQUE INDEX platform_mcp_origin_receipt_unique ON integration.control_request_receipts(result_integration_id)
  WHERE operation='create_connection';
CREATE INDEX platform_mcp_receipts_retention ON integration.control_request_receipts(replay_until,id) WHERE state='completed';
ALTER TABLE integration.integrations ADD COLUMN platform_mcp_origin_receipt_id UUID
  REFERENCES integration.control_request_receipts(id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION integration.guard_platform_mcp_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.platform_mcp_origin_receipt_id IS DISTINCT FROM OLD.platform_mcp_origin_receipt_id THEN
    RAISE EXCEPTION 'Platform MCP origin is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_mcp_origin_immutable BEFORE UPDATE ON integration.integrations
  FOR EACH ROW EXECUTE FUNCTION integration.guard_platform_mcp_origin();

CREATE FUNCTION integration.check_platform_mcp_origin_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.platform_mcp_origin_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM integration.control_request_receipts r
    WHERE r.id=NEW.platform_mcp_origin_receipt_id AND r.operation='create_connection' AND r.environment=NEW.environment
      AND r.merchant_id=NEW.merchant_id AND r.result_integration_id=NEW.id) THEN
    RAISE EXCEPTION 'Platform MCP origin receipt does not match its integration' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER platform_mcp_origin_binding AFTER INSERT ON integration.integrations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration.check_platform_mcp_origin_binding();

CREATE FUNCTION integration.guard_control_request_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE i integration.integrations%ROWTYPE; k integration.partner_mcp_keys%ROWTYPE; expected_scopes TEXT[]; metadata JSONB;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Control receipt identities cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['state','result_metadata']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','result_metadata'])
      OR OLD.state<>'completed' OR NEW.state<>'tombstone' OR NEW.result_metadata IS NOT NULL OR OLD.replay_until>clock_timestamp() THEN
      RAISE EXCEPTION 'Control receipt binding and approval are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  NEW.created_at:=clock_timestamp(); NEW.replay_until:=NEW.created_at+interval '30 days';
  IF NEW.state<>'completed' THEN RAISE EXCEPTION 'New control receipt must be completed' USING ERRCODE='23514'; END IF;
  IF NEW.operation IN ('rotate_key','revoke_key') AND (NEW.result_key_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM integration.partner_mcp_keys WHERE integration_id=NEW.result_integration_id AND id=NEW.target_key_id)) THEN
    RAISE EXCEPTION 'Invalid receipt target key binding' USING ERRCODE='23514';
  END IF;
  SELECT * INTO i FROM integration.integrations WHERE id=NEW.result_integration_id AND merchant_id=NEW.merchant_id AND environment=NEW.environment;
  metadata:=NEW.result_metadata;
  IF i.id IS NULL OR jsonb_typeof(metadata) IS DISTINCT FROM 'object'
    OR NOT (metadata ?& ARRAY['receiptId','merchantId','integrationId','environment','integrationVersion','integrationStatus','writesEnabled','mcpUrl','key'])
    OR (metadata-ARRAY['receiptId','merchantId','integrationId','environment','integrationVersion','integrationStatus','writesEnabled','mcpUrl','key'])<>'{}'::jsonb
    OR (metadata-ARRAY['mcpUrl','key']) IS DISTINCT FROM jsonb_build_object('receiptId',NEW.id::text,'merchantId',NEW.merchant_id,
      'integrationId',i.id,'environment',i.environment,'integrationVersion',i.grant_version,'integrationStatus',i.status,'writesEnabled',i.writes_enabled)
    OR (metadata->'mcpUrl'<>'null'::jsonb AND jsonb_typeof(metadata->'mcpUrl')<>'string') THEN
    RAISE EXCEPTION 'Invalid metadata-only control receipt' USING ERRCODE='23514';
  END IF;
  IF NEW.result_key_id IS NULL THEN
    IF metadata->'key' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Invalid receipt key binding' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO k FROM integration.partner_mcp_keys WHERE id=NEW.result_key_id AND integration_id=i.id;
    IF k.id IS NULL OR metadata->'key' IS DISTINCT FROM jsonb_build_object('id',k.id,'version',k.version,'status',k.status,
      'label',k.label,'scopes',k.scopes,'expiresAt',to_char(k.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) THEN
      RAISE EXCEPTION 'Invalid receipt key binding' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.operation='revoke_key' AND k.status IS DISTINCT FROM 'revoked' THEN
    RAISE EXCEPTION 'Revocation receipt requires a revoked key' USING ERRCODE='23514';
  END IF;
  IF NEW.operation='create_connection' THEN
    expected_scopes:=ARRAY['partner:read','catalog:read','inventory:read','orders:read'];
    IF NEW.max_approved_profile='commerce' THEN expected_scopes:=expected_scopes||ARRAY['orders:quote','orders:write']; END IF;
    IF NEW.workflow_version IS DISTINCT FROM 'platform-mcp-v1' OR NEW.preset_version IS DISTINCT FROM 'platform-mcp-v1'
      OR NEW.max_approved_profile IS NULL OR NEW.approved_scopes IS NULL
      OR NOT (NEW.approved_scopes @> expected_scopes AND NEW.approved_scopes <@ expected_scopes)
      OR cardinality(NEW.approved_scopes)<>cardinality(expected_scopes) OR array_ndims(NEW.approved_scopes) IS DISTINCT FROM 1 OR array_position(NEW.approved_scopes,NULL) IS NOT NULL
      OR NEW.approved_store_ids IS NULL OR array_ndims(NEW.approved_store_ids) IS DISTINCT FROM 1
      OR cardinality(NEW.approved_store_ids) NOT BETWEEN 1 AND 20 OR array_position(NEW.approved_store_ids,NULL) IS NOT NULL
      OR (SELECT count(*) FROM app.stores WHERE merchant_id=NEW.merchant_id AND id=ANY(NEW.approved_store_ids))<>cardinality(NEW.approved_store_ids)
      OR NEW.policy_id IS DISTINCT FROM i.policy_id OR NEW.policy_version IS DISTINCT FROM i.policy_version
      OR NEW.policy_sha256 IS NULL OR NEW.policy_sha256 !~ '^[a-f0-9]{64}$'
      OR NEW.readiness_sha256 IS NULL OR NEW.readiness_sha256 !~ '^[a-f0-9]{64}$'
      OR i.platform_mcp_origin_receipt_id IS DISTINCT FROM NEW.id
      OR i.status IS DISTINCT FROM 'active' OR i.writes_enabled IS DISTINCT FROM (NEW.max_approved_profile='commerce')
      OR k.status IS DISTINCT FROM 'active' OR k.expires_at<=clock_timestamp()
      OR k.scopes IS NULL OR NOT (k.scopes @> NEW.approved_scopes AND k.scopes <@ NEW.approved_scopes)
      OR cardinality(k.scopes)<>cardinality(NEW.approved_scopes)
      OR NOT EXISTS(SELECT 1 FROM app.merchants WHERE id=NEW.merchant_id AND status='active')
      OR (SELECT count(*) FROM integration.store_grants WHERE integration_id=i.id)<>cardinality(NEW.approved_store_ids)
      OR EXISTS(SELECT 1 FROM integration.store_grants g
        LEFT JOIN app.stores s ON s.id=g.store_id AND s.merchant_id=g.merchant_id AND s.status='active' AND s.stock_location_id=g.stock_location_id
        LEFT JOIN integration.assortments a ON a.id=g.assortment_id AND a.merchant_id=g.merchant_id AND a.status='active'
        WHERE g.integration_id=i.id AND (s.id IS NULL OR a.id IS NULL OR g.merchant_id<>NEW.merchant_id
          OR NOT(g.store_id=ANY(NEW.approved_store_ids)) OR g.status<>'active' OR g.mcp_catalog_mode<>'merchant_published'
          OR NOT(g.allowed_scopes @> NEW.approved_scopes AND g.allowed_scopes <@ NEW.approved_scopes)
          OR cardinality(g.allowed_scopes)<>cardinality(NEW.approved_scopes))) THEN
      RAISE EXCEPTION 'Invalid durable platform MCP approval' USING ERRCODE='23514';
    END IF;
  ELSIF (NEW.workflow_version,NEW.max_approved_profile,NEW.approved_scopes,NEW.approved_store_ids,NEW.preset_version,NEW.policy_id,NEW.policy_version,NEW.policy_sha256,NEW.readiness_sha256)
    IS DISTINCT FROM (NULL::text,NULL::text,NULL::text[],NULL::text[],NULL::text,NULL::text,NULL::integer,NULL::text,NULL::text) THEN
    RAISE EXCEPTION 'Only connection origin owns durable approval' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_mcp_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON integration.control_request_receipts
  FOR EACH ROW EXECUTE FUNCTION integration.guard_control_request_receipt();

CREATE FUNCTION integration.lock_platform_mcp_admin(target_operator TEXT,target_session_version INTEGER,target_session_expires_at TIMESTAMPTZ)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE active_staff BOOLEAN; security_state RECORD;
BEGIN
  SELECT is_active INTO active_staff FROM medusa.staff_users WHERE operator_id=target_operator FOR SHARE;
  SELECT global_status,session_version,requires_password_change INTO security_state FROM app.operator_security_state WHERE operator_id=target_operator FOR SHARE;
  PERFORM id FROM app.operator_memberships WHERE operator_id=target_operator AND scope_type='platform' AND role_key='platform_admin'
    AND merchant_id IS NULL AND store_id IS NULL AND status='active' ORDER BY id FOR SHARE;
  RETURN COALESCE(active_staff AND security_state.global_status='active' AND NOT security_state.requires_password_change
    AND security_state.session_version=target_session_version AND target_session_expires_at>clock_timestamp()
    AND EXISTS(SELECT 1 FROM app.operator_memberships WHERE operator_id=target_operator AND scope_type='platform'
      AND role_key='platform_admin' AND merchant_id IS NULL AND store_id IS NULL AND status='active'
      AND valid_from<=clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp())),false);
END $$;
REVOKE ALL ON integration.control_request_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON integration.control_request_receipts TO snus_partner_control;
GRANT SELECT ON integration.control_request_receipts TO snus_partner_maintenance;
GRANT UPDATE(state,result_metadata) ON integration.control_request_receipts TO snus_partner_maintenance;
REVOKE ALL ON FUNCTION integration.guard_platform_mcp_origin() FROM PUBLIC;
REVOKE ALL ON FUNCTION integration.check_platform_mcp_origin_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION integration.guard_control_request_receipt() FROM PUBLIC;
REVOKE ALL ON FUNCTION integration.lock_platform_mcp_admin(TEXT,INTEGER,TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.lock_platform_mcp_admin(TEXT,INTEGER,TIMESTAMPTZ) TO snus_partner_control;
