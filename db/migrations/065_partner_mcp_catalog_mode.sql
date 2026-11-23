-- MCP catalog expansion is opt-in per active store grant. Existing grants keep
-- their explicit assortment until a scoped staff control action changes it.
ALTER TABLE integration.store_grants
  ADD COLUMN mcp_catalog_mode TEXT NOT NULL DEFAULT 'explicit'
    CHECK (mcp_catalog_mode IN ('explicit','merchant_published'));

CREATE OR REPLACE FUNCTION integration.guard_store_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.integration_id,NEW.merchant_id,NEW.store_id,NEW.stock_location_id)
    IS DISTINCT FROM (OLD.integration_id,OLD.merchant_id,OLD.store_id,OLD.stock_location_id) THEN
    RAISE EXCEPTION 'partner grant ownership cannot change' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version;
  IF (NEW.allowed_scopes,NEW.assortment_id,NEW.status,NEW.mcp_catalog_mode)
    IS DISTINCT FROM (OLD.allowed_scopes,OLD.assortment_id,OLD.status,OLD.mcp_catalog_mode) THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;
