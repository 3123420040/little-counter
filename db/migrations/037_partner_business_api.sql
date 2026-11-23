-- Partner v1 facade, system release 2.2. Additive; no runtime DDL or historical
-- partner backfill. Existing app images may ignore these tables on rollback.
CREATE SCHEMA IF NOT EXISTS integration;
REVOKE ALL ON SCHEMA integration FROM PUBLIC;

CREATE UNIQUE INDEX IF NOT EXISTS stores_partner_scope_unique
  ON app.stores(merchant_id, id, stock_location_id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_partner_scope_unique
  ON public."order"(merchant_id, store_id, id);

CREATE TABLE integration.partners (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE integration.policies (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id),
  currency TEXT NOT NULL CHECK (currency = 'VND'),
  max_order_total BIGINT NOT NULL CHECK (max_order_total BETWEEN 1 AND 9007199254740991),
  max_quantity INTEGER NOT NULL CHECK (max_quantity BETWEEN 1 AND 100),
  safety_stock INTEGER NOT NULL CHECK (safety_stock >= 0),
  delivery_fee BIGINT CHECK (delivery_fee BETWEEN 0 AND 9007199254740991),
  contact_retention_days INTEGER NOT NULL CHECK (contact_retention_days BETWEEN 1 AND 365),
  read_per_minute INTEGER NOT NULL CHECK (read_per_minute BETWEEN 1 AND 120000),
  quote_per_minute INTEGER NOT NULL CHECK (quote_per_minute BETWEEN 1 AND 30000),
  book_per_minute INTEGER NOT NULL CHECK (book_per_minute BETWEEN 1 AND 10000),
  read_burst INTEGER NOT NULL CHECK (read_burst BETWEEN 1 AND 10000),
  quote_burst INTEGER NOT NULL CHECK (quote_burst BETWEEN 1 AND 1000),
  book_burst INTEGER NOT NULL CHECK (book_burst BETWEEN 1 AND 1000),
  mutation_concurrency INTEGER NOT NULL CHECK (mutation_concurrency BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version),
  UNIQUE (merchant_id, id, version)
);
CREATE TABLE integration.integrations (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES integration.partners(id),
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id),
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
  installation_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','active','paused','revoked')),
  writes_enabled BOOLEAN NOT NULL DEFAULT false,
  grant_version INTEGER NOT NULL DEFAULT 1 CHECK (grant_version > 0),
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, merchant_id, environment, installation_key),
  UNIQUE (id, merchant_id),
  UNIQUE (id, partner_id, merchant_id),
  FOREIGN KEY (merchant_id, policy_id, policy_version)
    REFERENCES integration.policies(merchant_id, id, version)
);
CREATE TABLE integration.clients (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integration.integrations(id),
  issuer TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','active','revoked')),
  auth_method TEXT NOT NULL CHECK (auth_method IN ('private_key_jwt','client_secret_basic')),
  credential_reference TEXT NOT NULL,
  as_client_id TEXT,
  retire_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issuer, oauth_client_id),
  UNIQUE (integration_id, id)
);
CREATE TABLE integration.assortments (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES app.merchants(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  UNIQUE (merchant_id, id)
);
CREATE TABLE integration.assortment_items (
  assortment_id TEXT NOT NULL REFERENCES integration.assortments(id),
  variant_id TEXT NOT NULL REFERENCES public.product_variant(id),
  PRIMARY KEY (assortment_id, variant_id)
);
CREATE TABLE integration.store_grants (
  integration_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  stock_location_id TEXT NOT NULL,
  allowed_scopes TEXT[] NOT NULL CHECK (
    cardinality(allowed_scopes) > 0 AND allowed_scopes <@ ARRAY[
      'partner:read','catalog:read','inventory:read','orders:quote','orders:write','orders:read']::text[]
    AND array_position(allowed_scopes, NULL) IS NULL
  ),
  assortment_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','active','revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (integration_id, store_id),
  UNIQUE (integration_id, merchant_id, store_id, stock_location_id),
  FOREIGN KEY (integration_id, merchant_id) REFERENCES integration.integrations(id, merchant_id),
  FOREIGN KEY (merchant_id, store_id, stock_location_id) REFERENCES app.stores(merchant_id,id,stock_location_id),
  FOREIGN KEY (merchant_id, assortment_id) REFERENCES integration.assortments(merchant_id,id)
);
CREATE TABLE integration.quotes (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  stock_location_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK (grant_version > 0),
  store_grant_version INTEGER NOT NULL CHECK (store_grant_version > 0),
  pricing_version TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_order_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  UNIQUE (integration_id, merchant_id, store_id, id),
  FOREIGN KEY (integration_id, merchant_id, store_id, stock_location_id)
    REFERENCES integration.store_grants(integration_id, merchant_id, store_id, stock_location_id),
  FOREIGN KEY (merchant_id, policy_id, policy_version) REFERENCES integration.policies(merchant_id,id,version)
);
CREATE INDEX partner_quotes_expiry_idx ON integration.quotes(expires_at) WHERE consumed_order_id IS NULL;
CREATE TABLE integration.partner_orders (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  stock_location_id TEXT NOT NULL,
  core_order_id TEXT NOT NULL UNIQUE,
  quote_id TEXT NOT NULL UNIQUE,
  external_order_id TEXT NOT NULL CHECK (length(external_order_id) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  fingerprint_version TEXT NOT NULL,
  created_by_client_id TEXT NOT NULL,
  origin_request_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  initial_response JSONB NOT NULL CHECK (jsonb_typeof(initial_response) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (integration_id, external_order_id),
  UNIQUE (integration_id, store_id, id),
  UNIQUE (integration_id, merchant_id, store_id, quote_id, id),
  FOREIGN KEY (integration_id, partner_id, merchant_id) REFERENCES integration.integrations(id,partner_id,merchant_id),
  FOREIGN KEY (integration_id, merchant_id, store_id, stock_location_id)
    REFERENCES integration.store_grants(integration_id,merchant_id,store_id,stock_location_id),
  FOREIGN KEY (merchant_id, store_id, core_order_id) REFERENCES public."order"(merchant_id,store_id,id),
  FOREIGN KEY (integration_id, merchant_id, store_id, quote_id) REFERENCES integration.quotes(integration_id,merchant_id,store_id,id),
  FOREIGN KEY (integration_id, created_by_client_id) REFERENCES integration.clients(integration_id,id)
);
CREATE INDEX partner_orders_page_idx ON integration.partner_orders(integration_id,store_id,created_at DESC,id DESC);
ALTER TABLE integration.quotes ADD CONSTRAINT partner_quote_consumed_ownership_fk
  FOREIGN KEY (integration_id, merchant_id, store_id, id, consumed_order_id)
  REFERENCES integration.partner_orders(integration_id,merchant_id,store_id,quote_id,id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE integration.order_contacts (
  partner_order_id TEXT PRIMARY KEY REFERENCES integration.partner_orders(id),
  key_version TEXT NOT NULL,
  ciphertext BYTEA NOT NULL,
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  retention_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (retention_until > created_at)
);
CREATE INDEX partner_contacts_retention_idx ON integration.order_contacts(retention_until);
CREATE TABLE integration.idempotency_records (
  integration_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL CHECK (key_fingerprint ~ '^[a-f0-9]{64}$'),
  fingerprint_version TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('completed','tombstone')),
  public_response JSONB,
  response_status INTEGER NOT NULL CHECK (response_status IN (200,201)),
  original_request_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id,store_id,operation,fingerprint_version,key_fingerprint),
  FOREIGN KEY (integration_id,store_id,order_id) REFERENCES integration.partner_orders(integration_id,store_id,id),
  CHECK ((state = 'completed' AND public_response IS NOT NULL AND jsonb_typeof(public_response) = 'object')
    OR (state = 'tombstone' AND public_response IS NULL))
);
CREATE INDEX partner_idempotency_expiry_idx ON integration.idempotency_records(expires_at) WHERE state = 'completed';

-- AS is not part of the SQL transaction. Durable operations preserve partial
-- provisioning/revocation for a separately scheduled reconciliation process.
CREATE TABLE integration.control_operations (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integration.integrations(id),
  client_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('provision','revoke','rotate')),
  status TEXT NOT NULL CHECK (status IN ('pending','verified','completed','failed')),
  as_client_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (integration_id,client_id) REFERENCES integration.clients(integration_id,id)
);
CREATE INDEX partner_control_due_idx ON integration.control_operations(next_attempt_at) WHERE status IN ('pending','failed');

ALTER TABLE audit.events
  ADD COLUMN IF NOT EXISTS partner_id TEXT,
  ADD COLUMN IF NOT EXISTS integration_id TEXT,
  ADD COLUMN IF NOT EXISTS client_id TEXT,
  ADD COLUMN IF NOT EXISTS grant_version INTEGER,
  ADD COLUMN IF NOT EXISTS trace_id TEXT,
  ADD COLUMN IF NOT EXISTS origin_request_id TEXT;
CREATE INDEX partner_audit_integration_time_idx ON audit.events(integration_id,created_at DESC) WHERE integration_id IS NOT NULL;
CREATE INDEX partner_audit_request_idx ON audit.events(request_id) WHERE request_id IS NOT NULL;

CREATE FUNCTION integration.reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'partner immutable record cannot be changed' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER partner_policy_immutable BEFORE UPDATE OR DELETE ON integration.policies
  FOR EACH ROW EXECUTE FUNCTION integration.reject_immutable_change();
CREATE TRIGGER partner_order_immutable BEFORE UPDATE OR DELETE ON integration.partner_orders
  FOR EACH ROW EXECUTE FUNCTION integration.reject_immutable_change();

CREATE FUNCTION integration.guard_integration_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.id,NEW.partner_id,NEW.merchant_id,NEW.environment,NEW.installation_key)
    IS DISTINCT FROM (OLD.id,OLD.partner_id,OLD.merchant_id,OLD.environment,OLD.installation_key) THEN
    RAISE EXCEPTION 'partner integration ownership cannot change' USING ERRCODE = '23514';
  END IF;
  NEW.grant_version := OLD.grant_version;
  IF (NEW.status,NEW.writes_enabled,NEW.policy_id,NEW.policy_version)
    IS DISTINCT FROM (OLD.status,OLD.writes_enabled,OLD.policy_id,OLD.policy_version) THEN
    NEW.grant_version := OLD.grant_version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_integration_identity BEFORE UPDATE ON integration.integrations
  FOR EACH ROW EXECUTE FUNCTION integration.guard_integration_identity();

CREATE FUNCTION integration.guard_store_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.integration_id,NEW.merchant_id,NEW.store_id,NEW.stock_location_id)
    IS DISTINCT FROM (OLD.integration_id,OLD.merchant_id,OLD.store_id,OLD.stock_location_id) THEN
    RAISE EXCEPTION 'partner grant ownership cannot change' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version;
  IF (NEW.allowed_scopes,NEW.assortment_id,NEW.status)
    IS DISTINCT FROM (OLD.allowed_scopes,OLD.assortment_id,OLD.status) THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_store_grant_version BEFORE UPDATE ON integration.store_grants
  FOR EACH ROW EXECUTE FUNCTION integration.guard_store_grant();

CREATE FUNCTION integration.guard_client_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.id,NEW.integration_id,NEW.issuer,NEW.oauth_client_id,NEW.subject)
    IS DISTINCT FROM (OLD.id,OLD.integration_id,OLD.issuer,OLD.oauth_client_id,OLD.subject) THEN
    RAISE EXCEPTION 'partner client identity cannot change; rotate with a sibling client' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_client_identity BEFORE UPDATE ON integration.clients
  FOR EACH ROW EXECUTE FUNCTION integration.guard_client_identity();

CREATE FUNCTION integration.guard_quote_consumption() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.consumed_order_id IS NOT NULL OR OLD.expires_at > statement_timestamp() THEN
      RAISE EXCEPTION 'only expired unconsumed quotes may be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'consumed_order_id') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_order_id')
    OR OLD.consumed_order_id IS NOT NULL OR NEW.consumed_order_id IS NULL THEN
    RAISE EXCEPTION 'quote can only be consumed once without changing its snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_quote_consume_once BEFORE UPDATE OR DELETE ON integration.quotes
  FOR EACH ROW EXECUTE FUNCTION integration.guard_quote_consumption();

CREATE FUNCTION integration.guard_replay_tombstone() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - 'state' - 'public_response') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'public_response')
    OR OLD.state <> 'completed' OR NEW.state <> 'tombstone'
    OR NEW.public_response IS NOT NULL OR OLD.expires_at > statement_timestamp() THEN
    RAISE EXCEPTION 'replay may only expire to a permanent tombstone' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_replay_tombstone BEFORE UPDATE ON integration.idempotency_records
  FOR EACH ROW EXECUTE FUNCTION integration.guard_replay_tombstone();

CREATE FUNCTION integration.guard_assortment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.id,NEW.merchant_id) IS DISTINCT FROM (OLD.id,OLD.merchant_id) THEN
    RAISE EXCEPTION 'assortment ownership cannot change' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_assortment_version BEFORE UPDATE ON integration.assortments
  FOR EACH ROW EXECUTE FUNCTION integration.guard_assortment();
CREATE FUNCTION integration.guard_assortment_item() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE scope_merchant TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'replace assortment item with delete and insert' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    UPDATE integration.assortments SET version = version + 1 WHERE id = OLD.assortment_id;
    RETURN OLD;
  END IF;
  UPDATE integration.assortments SET version = version + 1 WHERE id = NEW.assortment_id
    RETURNING merchant_id INTO STRICT scope_merchant;
  IF NOT EXISTS (SELECT 1 FROM public.product_variant v JOIN public.product p ON p.id=v.product_id
    WHERE v.id=NEW.variant_id AND p.merchant_id=scope_merchant AND v.deleted_at IS NULL AND p.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'assortment variant outside merchant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_assortment_item_scope BEFORE INSERT OR UPDATE OR DELETE ON integration.assortment_items
  FOR EACH ROW EXECUTE FUNCTION integration.guard_assortment_item();

REVOKE ALL ON ALL TABLES IN SCHEMA integration FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA integration FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'snus_partner_api') THEN
    CREATE ROLE snus_partner_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'snus_partner_control') THEN
    CREATE ROLE snus_partner_control NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'snus_partner_maintenance') THEN
    CREATE ROLE snus_partner_maintenance NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA integration TO snus_partner_api, snus_partner_control, snus_partner_maintenance;
GRANT SELECT ON integration.partners, integration.policies, integration.integrations,
  integration.clients, integration.assortments, integration.assortment_items,
  integration.store_grants TO snus_partner_api;
-- FOR SHARE requires UPDATE privileges; do not grant registry mutations to
-- the public facade just to lock. This capability only acquires ordered locks.
CREATE FUNCTION integration.lock_authorization(target_integration TEXT, target_client TEXT, target_store TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM integration.integrations WHERE id=target_integration FOR SHARE;
  PERFORM 1 FROM integration.partners WHERE id=(SELECT partner_id FROM integration.integrations WHERE id=target_integration) FOR SHARE;
  PERFORM 1 FROM integration.clients WHERE integration_id=target_integration AND id=target_client FOR SHARE;
  PERFORM 1 FROM integration.store_grants WHERE integration_id=target_integration AND store_id=target_store FOR SHARE;
END $$;
REVOKE ALL ON FUNCTION integration.lock_authorization(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.lock_authorization(TEXT,TEXT,TEXT) TO snus_partner_api;
GRANT SELECT,INSERT ON integration.partner_orders TO snus_partner_api;
GRANT SELECT,INSERT,UPDATE ON integration.quotes, integration.idempotency_records TO snus_partner_api;
GRANT INSERT ON integration.order_contacts TO snus_partner_api;
GRANT SELECT,INSERT,UPDATE ON integration.partners, integration.integrations, integration.clients,
  integration.assortments, integration.assortment_items, integration.store_grants,
  integration.control_operations TO snus_partner_control;
GRANT SELECT,INSERT ON integration.policies TO snus_partner_control;
GRANT DELETE ON integration.assortment_items TO snus_partner_control;
GRANT SELECT ON integration.partner_orders, integration.order_contacts TO snus_partner_control;
GRANT SELECT,UPDATE ON integration.idempotency_records TO snus_partner_maintenance;
GRANT SELECT,DELETE ON integration.order_contacts, integration.quotes TO snus_partner_maintenance;
GRANT SELECT,UPDATE ON integration.control_operations TO snus_partner_maintenance;
GRANT USAGE ON SCHEMA audit TO snus_partner_api,snus_partner_control,snus_partner_maintenance;
GRANT INSERT ON audit.events TO snus_partner_api,snus_partner_control,snus_partner_maintenance;
GRANT SELECT (id,created_at) ON audit.events TO snus_partner_api,snus_partner_control,snus_partner_maintenance;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA audit TO snus_partner_api,snus_partner_control,snus_partner_maintenance;

INSERT INTO app.permissions(id,description) VALUES
  ('partner:manage','Manage merchant partner integrations, grants and credentials'),
  ('partner:contact_read','Read scoped partner delivery contact with audit')
ON CONFLICT (id) DO NOTHING;
INSERT INTO app.role_permissions(role,permission_id) VALUES
  ('owner','partner:manage'), ('owner','partner:contact_read'),
  ('manager','partner:contact_read'), ('staff','partner:contact_read')
ON CONFLICT DO NOTHING;
