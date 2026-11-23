-- CHECK treats UNKNOWN as success; explicitly exclude partial discriminators.
ALTER TABLE audit.events DROP CONSTRAINT partner_audit_credential_kind;
ALTER TABLE audit.events ADD CONSTRAINT partner_audit_credential_kind CHECK (
  (auth_method IS NULL AND credential_id IS NULL AND key_id IS NULL)
  OR (auth_method IS NOT NULL AND auth_method='oauth_client'
    AND credential_id IS NOT NULL AND client_id IS NOT NULL
    AND credential_id=client_id AND key_id IS NULL)
  OR (auth_method IS NOT NULL AND auth_method='mcp_key' AND integration_id IS NOT NULL
    AND credential_id IS NOT NULL AND key_id IS NOT NULL
    AND credential_id=key_id AND client_id IS NULL)
);
