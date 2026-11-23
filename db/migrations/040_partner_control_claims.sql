-- A crashed reconciliation process can be replaced; stale attempts cannot
-- acknowledge a reclaimed operation or activate a locally revoked client.
ALTER TABLE integration.control_operations
  ADD COLUMN claim_token UUID,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT partner_control_claim_pair CHECK ((claim_token IS NULL)=(lease_expires_at IS NULL));
CREATE INDEX partner_control_lease_idx ON integration.control_operations(lease_expires_at)
  WHERE claim_token IS NOT NULL;
