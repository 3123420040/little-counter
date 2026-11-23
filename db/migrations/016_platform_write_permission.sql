-- 1.1.2-sub: explicit permission for platform store and membership mutations.
-- Keep this additive: migration 010 may already be recorded in the checksum
-- ledger and must never be edited after application.

INSERT INTO app.permissions (id, description)
VALUES ('platform:write', 'Change platform stores and operator memberships')
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description;
