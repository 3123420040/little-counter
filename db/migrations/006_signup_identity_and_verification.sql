-- ═══════════════════════════════════════════════════════════════════════
-- 006_signup_identity_and_verification.sql
-- Release 1.1.2 — Public signup, email verification and transactional
-- delivery ledger (additive only).
-- Agent 4 (public signup and transactional email)
--
-- Contract references:
--   docs/07-release-audits/1.1.2-in-dev/annual-package-commercial-and-lifecycle-spec.md §7
--   docs/07-release-audits/1.1.2-in-dev/multi-agent-implementation-plan.md (W4)
--   docs/07-release-audits/1.1.2-in-dev/multi-agent-development-prompt-pack.md
--
-- Safety rules:
--   * Additive only. No DROP, no RENAME, no destructive data mutation.
--   * CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / guarded indexes.
--   * Re-running this file after first success is a no-op.
-- ═══════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS audit;

-- ── 1. Public signup request ledger ─────────────────────────────────────
-- Each email gets at most one active signup request. Normalized email is
-- unique-protected so retry/replay cannot create duplicate accounts.
CREATE TABLE IF NOT EXISTS app.signup_requests (
    id TEXT PRIMARY KEY,
    normalized_email TEXT NOT NULL,
    email_hash TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified', 'provisioned', 'expired', 'failed')),
    request_ip TEXT,
    user_agent TEXT,
    terms_version TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_at TIMESTAMPTZ,
    provisioned_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS signup_requests_normalized_email_idx
    ON app.signup_requests(normalized_email)
    WHERE status IN ('pending', 'verified', 'provisioned');

CREATE INDEX IF NOT EXISTS signup_requests_status_created_idx
    ON app.signup_requests(status, created_at DESC);

-- ── 2. One-time hashed verification tokens ─────────────────────────────
-- Tokens are single-use, short-lived, and bound to exactly one signup
-- request. The raw token is never stored; only sha256 hash.
CREATE TABLE IF NOT EXISTS app.signup_verification_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id TEXT NOT NULL REFERENCES app.signup_requests(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL DEFAULT 'email_verification'
        CHECK (purpose IN ('email_verification', 'password_reset')),
    attempts_remaining SMALLINT NOT NULL DEFAULT 3 CHECK (attempts_remaining >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signup_verification_tokens_request_idx
    ON app.signup_verification_tokens(request_id, created_at DESC);

-- ── 3. Rate-limit buckets for public signup ───────────────────────────
-- Separate from general API rate limits because signup is unauthenticated
-- and has asymmetric cost. Buckets auto-expire.
CREATE TABLE IF NOT EXISTS app.signup_rate_limit_buckets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    window_key TEXT NOT NULL,
    window_type TEXT NOT NULL CHECK (window_type IN ('email', 'ip')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (window_key, window_type, window_start)
);

CREATE INDEX IF NOT EXISTS signup_rate_limit_window_end_idx
    ON app.signup_rate_limit_buckets(window_end);

-- ── 4. Transactional email delivery ledger ────────────────────────────
-- Records every delivery attempt with provider metadata. Does NOT store
-- API keys or full email bodies. Audit logs are kept via audit.events.
CREATE TABLE IF NOT EXISTS app.email_delivery_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (provider IN ('mailpit', 'resend', 'ses', 'log', 'test')),
    request_id TEXT,
    template_key TEXT NOT NULL,
    recipient_normalized_email TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'bounced', 'failed', 'deferred')),
    provider_message_id TEXT,
    provider_response_code TEXT,
    error_code TEXT,
    error_message TEXT,
    sent_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_delivery_attempts_request_idx
    ON app.email_delivery_attempts(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_delivery_attempts_recipient_idx
    ON app.email_delivery_attempts(recipient_normalized_email, created_at DESC);
CREATE INDEX IF NOT EXISTS email_delivery_attempts_status_idx
    ON app.email_delivery_attempts(status, created_at DESC);
