-- Staff delivery contact access is a separate process capability. It cannot
-- manage integrations, mutate orders, or read staff/customer credential tables.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='snus_partner_contacts') THEN
    CREATE ROLE snus_partner_contacts NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA integration,app,audit TO snus_partner_contacts;
GRANT SELECT (id,merchant_id,store_id,core_order_id) ON integration.partner_orders TO snus_partner_contacts;
GRANT SELECT ON integration.order_contacts TO snus_partner_contacts;
GRANT SELECT (id,legacy_organization_id) ON app.merchants TO snus_partner_contacts;
GRANT INSERT ON audit.events TO snus_partner_contacts;
GRANT SELECT (id,created_at) ON audit.events TO snus_partner_contacts;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA audit TO snus_partner_contacts;
REVOKE SELECT ON integration.order_contacts FROM snus_partner_control;
