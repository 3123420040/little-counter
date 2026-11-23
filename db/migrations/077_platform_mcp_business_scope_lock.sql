-- Lock the whole confirmed selection, without granting control tenant UPDATE rights.
CREATE FUNCTION integration.lock_platform_mcp_business_scope(target_merchant TEXT,target_stores TEXT[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected_store TEXT; selected_count INTEGER:=0; subscription_row RECORD; catalog_row RECORD;
BEGIN
  IF target_stores IS NULL OR array_ndims(target_stores) IS DISTINCT FROM 1 OR cardinality(target_stores)=0 THEN
    RAISE EXCEPTION 'Invalid selected business scope' USING ERRCODE='22023';
  END IF;
  IF array_position(target_stores,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT id) FROM unnest(target_stores) id)<>cardinality(target_stores) THEN
    RAISE EXCEPTION 'Invalid selected business scope' USING ERRCODE='22023';
  END IF;
  PERFORM integration.lock_active_control_scope(target_merchant,NULL);
  FOR selected_store IN
    SELECT s.id FROM app.stores s JOIN public.stock_location l ON l.id=s.stock_location_id AND l.deleted_at IS NULL
    WHERE s.merchant_id=target_merchant AND s.id=ANY(target_stores) AND s.status='active'
    ORDER BY s.id FOR SHARE OF s,l
  LOOP
    selected_count:=selected_count+1;
  END LOOP;
  IF selected_count<>cardinality(target_stores) THEN
    RAISE EXCEPTION 'Business scope inactive' USING ERRCODE='P0001';
  END IF;
  SELECT catalog_version_id,current_period_end,grace_ends_at INTO subscription_row
    FROM app.merchant_subscriptions WHERE merchant_id=target_merchant FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT feature_keys INTO catalog_row FROM app.package_catalog_versions
    WHERE id=subscription_row.catalog_version_id FOR SHARE;
  RETURN COALESCE(catalog_row.feature_keys ? 'partner_api'
    AND GREATEST(subscription_row.current_period_end,COALESCE(subscription_row.grace_ends_at,
      subscription_row.current_period_end+interval '7 days'))>clock_timestamp(),false);
END $$;
REVOKE ALL ON FUNCTION integration.lock_platform_mcp_business_scope(TEXT,TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.lock_platform_mcp_business_scope(TEXT,TEXT[]) TO snus_partner_control;
