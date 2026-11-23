-- Expose one digest, without granting control/API access to the migration ledger.
CREATE FUNCTION integration.platform_mcp_schema_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT encode(sha256(convert_to(COALESCE(string_agg(filename||':'||checksum,E'\n' ORDER BY filename),''),'UTF8')),'hex')
  FROM app.schema_migrations
$$;
REVOKE ALL ON FUNCTION integration.platform_mcp_schema_fingerprint() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.platform_mcp_schema_fingerprint() TO snus_partner_control,snus_partner_api;
