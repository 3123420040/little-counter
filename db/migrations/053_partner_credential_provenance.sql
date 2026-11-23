-- Additive provenance: existing orders remain OAuth with their original FK.
ALTER TABLE integration.partner_orders
  ALTER COLUMN created_by_client_id DROP NOT NULL,
  ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'oauth_client',
  ADD COLUMN created_by_key_id TEXT,
  ADD CONSTRAINT partner_order_credential_kind CHECK (
    (auth_method='oauth_client' AND created_by_client_id IS NOT NULL AND created_by_key_id IS NULL)
    OR (auth_method='mcp_key' AND created_by_client_id IS NULL AND created_by_key_id IS NOT NULL)),
  ADD CONSTRAINT partner_order_key_ownership_fk FOREIGN KEY (integration_id,created_by_key_id)
    REFERENCES integration.partner_mcp_keys(integration_id,id);

-- Historical staff and OAuth audit rows stay byte-for-byte intact. Nullable
-- new columns allow the previous application image to continue on this schema.
ALTER TABLE audit.events
  ADD COLUMN auth_method TEXT,
  ADD COLUMN credential_id TEXT,
  ADD COLUMN key_id TEXT,
  ADD CONSTRAINT partner_audit_credential_kind CHECK (
    (auth_method IS NULL AND credential_id IS NULL AND key_id IS NULL)
    OR (auth_method='oauth_client' AND credential_id IS NOT NULL AND client_id IS NOT NULL
      AND credential_id=client_id AND key_id IS NULL)
    OR (auth_method='mcp_key' AND credential_id IS NOT NULL AND key_id IS NOT NULL
      AND credential_id=key_id AND client_id IS NULL)),
  ADD CONSTRAINT partner_audit_key_ownership_fk FOREIGN KEY (integration_id,key_id)
    REFERENCES integration.partner_mcp_keys(integration_id,id);

CREATE OR REPLACE FUNCTION integration.lock_authorization(target_integration TEXT,target_credential TEXT,target_store TEXT,target_auth_method TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target_merchant TEXT; target_partner TEXT; target_assortment TEXT;
BEGIN
  SELECT merchant_id,partner_id INTO target_merchant,target_partner
    FROM integration.integrations WHERE id=target_integration FOR SHARE;
  PERFORM 1 FROM integration.partners WHERE id=target_partner FOR SHARE;
  IF target_auth_method='oauth_client' THEN
    PERFORM 1 FROM integration.clients WHERE id=target_credential AND integration_id=target_integration FOR SHARE;
  ELSIF target_auth_method='mcp_key' THEN
    PERFORM 1 FROM integration.partner_mcp_keys WHERE id=target_credential AND integration_id=target_integration FOR SHARE;
  ELSE
    RAISE EXCEPTION 'Unsupported partner credential type' USING ERRCODE='22023';
  END IF;
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
REVOKE ALL ON FUNCTION integration.lock_authorization(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.lock_authorization(TEXT,TEXT,TEXT,TEXT) TO snus_partner_api;

-- Preserve the exact previous OAuth lock entrypoint for rollback compatibility.
CREATE OR REPLACE FUNCTION integration.lock_authorization(target_integration TEXT,target_client TEXT,target_store TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM integration.lock_authorization(target_integration,target_client,target_store,'oauth_client');
END $$;
REVOKE ALL ON FUNCTION integration.lock_authorization(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.lock_authorization(TEXT,TEXT,TEXT) TO snus_partner_api;
