-- Partner commerce may lock lifecycle rows without receiving tenant UPDATE authority.
CREATE FUNCTION integration.lock_active_business_scope(target_merchant TEXT,target_store TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE merchant_status TEXT; store_status TEXT;
BEGIN
  SELECT status INTO merchant_status FROM app.merchants WHERE id=target_merchant FOR SHARE;
  IF merchant_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Business scope inactive' USING ERRCODE='P0001';
  END IF;
  SELECT status INTO store_status FROM app.stores
    WHERE id=target_store AND merchant_id=target_merchant FOR SHARE;
  IF store_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Business scope inactive' USING ERRCODE='P0001';
  END IF;
END $$;
REVOKE ALL ON FUNCTION integration.lock_active_business_scope(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.lock_active_business_scope(TEXT,TEXT) TO snus_partner_api;
