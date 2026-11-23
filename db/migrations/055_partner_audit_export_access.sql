-- Separate internal audit export capability. The public partner API never
-- receives these read privileges or the staff route's database credential.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='snus_partner_audit') THEN
    CREATE ROLE snus_partner_audit NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA integration,app,audit TO snus_partner_audit;
GRANT SELECT (id,merchant_id,environment) ON integration.integrations TO snus_partner_audit;
GRANT SELECT (id,integration_id,merchant_id,store_id) ON integration.partner_orders TO snus_partner_audit;
GRANT SELECT (id,legacy_organization_id) ON app.merchants TO snus_partner_audit;
GRANT SELECT (id,created_at,merchant_id,store_id,actor_type,actor_id,action,subject_type,subject_id,
  correlation_id,request_id,partner_id,integration_id,client_id,key_id,auth_method,credential_id,
  grant_version,trace_id,origin_request_id) ON audit.events TO snus_partner_audit;
GRANT INSERT ON audit.events TO snus_partner_audit;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA audit TO snus_partner_audit;
-- No UPDATE/DELETE, no customer/contact data, no before/after/reason or key hash.
CREATE INDEX partner_audit_scope_page ON audit.events(merchant_id,created_at,id)
  WHERE action LIKE 'partner.%';
