-- Activation needs one currently eligible store, including after a concurrent status change.
CREATE FUNCTION integration.lock_active_control_ready_store(target_integration TEXT,target_merchant TEXT)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ready_store TEXT;
BEGIN
  PERFORM integration.lock_active_control_scope(target_merchant,NULL);
  SELECT s.id INTO ready_store
  FROM integration.integrations i
  JOIN integration.store_grants g ON g.integration_id=i.id AND g.merchant_id=i.merchant_id AND g.status='active'
  JOIN integration.assortments a ON a.id=g.assortment_id AND a.merchant_id=g.merchant_id AND a.status='active'
  JOIN app.stores s ON s.id=g.store_id AND s.merchant_id=g.merchant_id AND s.status='active'
  WHERE i.id=target_integration AND i.merchant_id=target_merchant
  ORDER BY s.id LIMIT 1 FOR SHARE OF s;
  RETURN ready_store IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION integration.lock_active_control_ready_store(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.lock_active_control_ready_store(TEXT,TEXT) TO snus_partner_control;
