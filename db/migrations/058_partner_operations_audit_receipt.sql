-- INSERT ... RETURNING discloses only receipt identity/time, never audit payload.
GRANT SELECT(id,created_at) ON audit.events TO snus_partner_operations;
