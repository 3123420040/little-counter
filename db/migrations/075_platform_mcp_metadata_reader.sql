-- Metadata authority must also work in a fresh READ COMMITTED READ ONLY transaction.
CREATE FUNCTION integration.platform_mcp_reader_role(target_operator TEXT,target_session_version INTEGER,target_session_expires_at TIMESTAMPTZ)
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT m.role_key FROM medusa.staff_users u
    JOIN app.operator_security_state s ON s.operator_id=u.operator_id
    JOIN app.operator_memberships m ON m.operator_id=u.operator_id
  WHERE u.operator_id=target_operator AND u.is_active AND s.global_status='active' AND NOT s.requires_password_change
    AND s.session_version=target_session_version AND target_session_expires_at>clock_timestamp()
    AND m.scope_type='platform' AND m.merchant_id IS NULL AND m.store_id IS NULL AND m.status='active'
    AND m.role_key IN ('platform_admin','platform_readonly')
    AND m.valid_from<=clock_timestamp() AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp())
  ORDER BY CASE m.role_key WHEN 'platform_admin' THEN 0 ELSE 1 END,m.id LIMIT 1
$$;
REVOKE ALL ON FUNCTION integration.platform_mcp_reader_role(TEXT,INTEGER,TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.platform_mcp_reader_role(TEXT,INTEGER,TIMESTAMPTZ) TO snus_partner_control;
CREATE INDEX platform_mcp_receipts_metadata_page ON integration.control_request_receipts(result_integration_id,id);
