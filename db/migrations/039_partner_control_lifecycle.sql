-- Durable AS work contains identifiers/references only, never a credential.
ALTER TABLE integration.control_operations
  ADD COLUMN oauth_client_id TEXT,
  ADD COLUMN auth_method TEXT CHECK (auth_method IN ('private_key_jwt','client_secret_basic')),
  ADD COLUMN credential_reference TEXT,
  ADD COLUMN prior_client_id TEXT,
  ADD COLUMN overlap_seconds INTEGER CHECK (overlap_seconds BETWEEN 0 AND 86400),
  ADD COLUMN request_id TEXT,
  ADD COLUMN actor_id TEXT,
  ADD CONSTRAINT partner_control_prior_client_fk FOREIGN KEY (integration_id,prior_client_id)
    REFERENCES integration.clients(integration_id,id);
CREATE UNIQUE INDEX partner_control_oauth_client_idx ON integration.control_operations(oauth_client_id)
  WHERE oauth_client_id IS NOT NULL;
DROP INDEX integration.partner_control_due_idx;
CREATE INDEX partner_control_due_idx ON integration.control_operations(next_attempt_at)
  WHERE status IN ('pending','verified','failed');

GRANT USAGE ON SCHEMA app,public TO snus_partner_control;
GRANT SELECT (id,status,legacy_organization_id) ON app.merchants TO snus_partner_control;
GRANT SELECT (id,merchant_id,stock_location_id,status) ON app.stores TO snus_partner_control;
GRANT SELECT (id,deleted_at) ON public.stock_location TO snus_partner_control;
GRANT SELECT (id,merchant_id,status,deleted_at) ON public.product TO snus_partner_control;
GRANT SELECT (id,product_id,deleted_at) ON public.product_variant TO snus_partner_control;
GRANT SELECT (merchant_id,catalog_version_id,current_period_end,grace_ends_at) ON app.merchant_subscriptions TO snus_partner_control;
GRANT SELECT (id,feature_keys) ON app.package_catalog_versions TO snus_partner_control;

-- Lock all mutable authorization dependencies for a mutation, then re-read
-- with READ COMMITTED. Existing-row writers block on the same row locks.
-- Assortment item changes update their parent version through the 037 trigger.
CREATE OR REPLACE FUNCTION integration.lock_authorization(target_integration TEXT,target_client TEXT,target_store TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target_merchant TEXT; target_partner TEXT; target_assortment TEXT;
BEGIN
  SELECT merchant_id,partner_id INTO target_merchant,target_partner
    FROM integration.integrations WHERE id=target_integration FOR SHARE;
  PERFORM 1 FROM integration.partners WHERE id=target_partner FOR SHARE;
  PERFORM 1 FROM integration.clients WHERE id=target_client AND integration_id=target_integration FOR SHARE;
  SELECT assortment_id INTO target_assortment FROM integration.store_grants
    WHERE integration_id=target_integration AND store_id=target_store FOR SHARE;
  PERFORM 1 FROM app.merchants WHERE id=target_merchant FOR SHARE;
  PERFORM 1 FROM app.stores WHERE id=target_store AND merchant_id=target_merchant FOR SHARE;
  PERFORM 1 FROM public.stock_location l JOIN app.stores s ON s.stock_location_id=l.id
    WHERE s.id=target_store AND s.merchant_id=target_merchant FOR SHARE OF l;
  PERFORM 1 FROM integration.assortments WHERE id=target_assortment AND merchant_id=target_merchant FOR SHARE;
  PERFORM 1 FROM app.merchant_subscriptions WHERE merchant_id=target_merchant FOR SHARE;
  PERFORM 1 FROM app.package_catalog_versions c JOIN app.merchant_subscriptions s ON s.catalog_version_id=c.id
    WHERE s.merchant_id=target_merchant FOR SHARE OF c;
END $$;
REVOKE ALL ON FUNCTION integration.lock_authorization(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.lock_authorization(TEXT,TEXT,TEXT) TO snus_partner_api;
