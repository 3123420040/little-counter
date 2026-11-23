-- Operational telemetry, separate from durable business audit and commerce.
CREATE SCHEMA IF NOT EXISTS observability;
CREATE TABLE observability.partner_logs (
  event_key TEXT PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  merchant_id TEXT,
  integration_id TEXT,
  credential_id TEXT,
  security BOOLEAN NOT NULL,
  attributes JSONB NOT NULL CHECK(jsonb_typeof(attributes)='object' AND octet_length(attributes::text)<=8192)
);
CREATE INDEX partner_logs_scope_time ON observability.partner_logs(merchant_id,observed_at DESC,event_key);
CREATE INDEX partner_logs_expiry ON observability.partner_logs(observed_at);
CREATE TABLE observability.partner_alerts (
  alert_key TEXT PRIMARY KEY,
  merchant_id TEXT,
  integration_id TEXT,
  code TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL,
  detail JSONB NOT NULL CHECK(octet_length(detail::text)<=2048)
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='snus_partner_observer') THEN CREATE ROLE snus_partner_observer NOLOGIN; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='snus_partner_operations') THEN CREATE ROLE snus_partner_operations NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA observability,integration,app,outbox TO snus_partner_observer,snus_partner_operations;
GRANT USAGE ON SCHEMA audit TO snus_partner_operations;
GRANT SELECT,INSERT,DELETE ON observability.partner_logs TO snus_partner_observer;
GRANT SELECT,INSERT,UPDATE,DELETE ON observability.partner_alerts TO snus_partner_observer;
GRANT SELECT ON observability.partner_logs,observability.partner_alerts TO snus_partner_operations;
GRANT SELECT(id,merchant_id,integration_id,core_order_id,store_id,created_at) ON integration.partner_orders TO snus_partner_operations;
GRANT SELECT(id,merchant_id,environment) ON integration.integrations TO snus_partner_operations,snus_partner_observer;
GRANT SELECT(id,legacy_organization_id) ON app.merchants TO snus_partner_operations;
GRANT SELECT(id,merchant_id,store_id,order_id,revision,commercial_state,currency_code,data_quality)
  ON app.order_commercial_revisions TO snus_partner_operations;
GRANT SELECT(revision_id,total_minor) ON app.order_commercial_revision_components TO snus_partner_operations;
GRANT SELECT(id,merchant_id,aggregate_id,status,created_at,event_type) ON outbox.events TO snus_partner_operations,snus_partner_observer;
GRANT INSERT ON audit.events TO snus_partner_operations;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA audit TO snus_partner_operations;
-- No audit/commerce write, customer/contact/key/token access for either role.
