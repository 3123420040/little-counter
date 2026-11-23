-- 033_login_backoff_hardening.sql
-- Durable, pair-scoped login throttling. Only irreversible identifiers are
-- stored so unknown account names and client addresses never enter evidence.

CREATE TABLE IF NOT EXISTS app.auth_login_failures (
  account_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ,
  last_failure_code TEXT NOT NULL,
  PRIMARY KEY (account_hash, ip_hash)
);

CREATE INDEX IF NOT EXISTS auth_login_failures_retention_idx
  ON app.auth_login_failures(last_attempt_at);
