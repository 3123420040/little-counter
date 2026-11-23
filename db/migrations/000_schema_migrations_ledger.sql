-- ═══════════════════════════════════════════════════════════════════════
-- 000_schema_migrations_ledger.sql
-- Bootstrap the custom migration ledger used by scripts/prod-apply-migrations.sh.
--
-- Applied first (and unconditionally) by the ordered runner so there is a
-- deterministic place to record checksums. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_by TEXT NOT NULL DEFAULT current_user
);
