-- v1.9: split email verification from the one-time tenant provisioning capability.
-- Existing token rows retain their original purpose and remain valid under the
-- expanded constraint. Raw capabilities are never persisted.

ALTER TABLE app.signup_verification_tokens
  DROP CONSTRAINT IF EXISTS signup_verification_tokens_purpose_check;

ALTER TABLE app.signup_verification_tokens
  ADD CONSTRAINT signup_verification_tokens_purpose_check
  CHECK (purpose IN ('email_verification', 'tenant_provisioning', 'password_reset'));

CREATE INDEX IF NOT EXISTS signup_verification_tokens_active_purpose_idx
  ON app.signup_verification_tokens (request_id, purpose, created_at DESC)
  WHERE consumed_at IS NULL;
