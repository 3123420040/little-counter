-- Control commands lock tenant lifecycle rows without obtaining tenant UPDATE privileges.
CREATE FUNCTION integration.lock_active_control_scope(target_merchant TEXT,target_store TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE entity_status TEXT;
BEGIN
  SELECT status INTO entity_status FROM app.merchants WHERE id=target_merchant FOR SHARE;
  IF entity_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Business scope inactive' USING ERRCODE='P0001';
  END IF;
  IF target_store IS NOT NULL THEN
    SELECT status INTO entity_status FROM app.stores
      WHERE id=target_store AND merchant_id=target_merchant FOR SHARE;
    IF entity_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Business scope inactive' USING ERRCODE='P0001';
    END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION integration.lock_active_control_scope(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.lock_active_control_scope(TEXT,TEXT) TO snus_partner_control;
