-- Durable environment cursor prevents replica handoff/restarts from repeatedly
-- repairing only the first mapped AS clients. This is operational state only.
CREATE TABLE integration.as_convergence_cursors (
  environment text PRIMARY KEY CHECK (environment IN ('sandbox','production')),
  last_client_id text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON integration.as_convergence_cursors FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON integration.as_convergence_cursors TO snus_partner_control;
