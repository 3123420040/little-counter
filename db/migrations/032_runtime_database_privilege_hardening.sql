-- 032_runtime_database_privilege_hardening.sql
-- Additive privilege boundary for release 1.8.0.
--
-- Role membership/passwords are intentionally not embedded in a migration.
-- `scripts/provision-runtime-database-roles.sql` grants the reviewed runtime
-- capabilities after the secret-managed LOGIN roles exist. This migration
-- makes the database objects safe before any capability is granted.

REVOKE ALL ON SCHEMA app, outbox FROM PUBLIC;

-- Every function introduced or replaced by 026-031 has a deterministic,
-- non-user-writable search path. Trigger functions do not require callers to
-- hold EXECUTE, so PUBLIC can be removed without breaking trigger execution.
ALTER FUNCTION app.assert_order_financial_scope()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.assert_payment_allocation_scope_currency()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.assert_payment_component_allocation()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.assert_payment_correction_component_delta()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.assert_payment_event_evidence_match()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.assert_commercial_revision_bundle()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.assert_posted_payment_event_bundle()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.reject_immutable_financial_fact_mutation()
  SET search_path = pg_catalog, app;

ALTER FUNCTION outbox.allocate_aggregate_sequence(text, text, text, text)
  SET search_path = pg_catalog, app, outbox;
ALTER FUNCTION outbox.enforce_new_event_causality()
  SET search_path = pg_catalog, app, outbox;
ALTER FUNCTION outbox.reject_outbox_causality_mutation()
  SET search_path = pg_catalog, outbox;
ALTER FUNCTION outbox.reject_outbox_event_delete()
  SET search_path = pg_catalog, outbox;
ALTER FUNCTION outbox.claim_exact_events(text, integer, integer)
  SET search_path = pg_catalog, outbox;
ALTER FUNCTION outbox.complete_exact_event_claim(uuid, text, uuid, bigint)
  SET search_path = pg_catalog, outbox;
ALTER FUNCTION outbox.fail_exact_event_claim(
  uuid, text, uuid, bigint, text, text, timestamptz, boolean, text
) SET search_path = pg_catalog, outbox;

ALTER FUNCTION app.bump_order_collection_revision(text, text, text, text, text)
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.invalidate_order_collection()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.guard_order_collection_revision_state()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.reject_collection_revision_event_mutation()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.assert_collection_revision_event_pair()
  SET search_path = pg_catalog, app;

ALTER FUNCTION app.assert_customer_refund_payable_scope()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.assert_customer_refund_payable_event()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.assert_customer_refund_payout_allocation()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.assert_customer_refund_payable_bundle()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.assert_customer_refund_payout_event_bundle()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.reject_immutable_customer_refund_fact_mutation()
  SET search_path = pg_catalog, app;
ALTER FUNCTION app.reject_historical_reconciliation_mutation()
  SET search_path = pg_catalog, app;

-- Only narrowly scoped state coordinators need elevated execution. Their owner
-- remains the non-login migration owner; the provisioning script rejects a
-- runtime role that owns any of them.
ALTER FUNCTION outbox.allocate_aggregate_sequence(text, text, text, text)
  SECURITY DEFINER;
ALTER FUNCTION outbox.claim_exact_events(text, integer, integer)
  SECURITY DEFINER;
ALTER FUNCTION outbox.complete_exact_event_claim(uuid, text, uuid, bigint)
  SECURITY DEFINER;
ALTER FUNCTION outbox.fail_exact_event_claim(
  uuid, text, uuid, bigint, text, text, timestamptz, boolean, text
) SECURITY DEFINER;
ALTER FUNCTION app.bump_order_collection_revision(text, text, text, text, text)
  SECURITY DEFINER;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA outbox FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA outbox FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA outbox FROM PUBLIC;

COMMENT ON FUNCTION outbox.claim_exact_events(text, integer, integer) IS
  'Security-definer exact claim coordinator; only the dedicated exact-outbox worker role receives EXECUTE.';
COMMENT ON FUNCTION outbox.allocate_aggregate_sequence(text, text, text, text) IS
  'Security-definer exact sequence allocator; only the application writer role receives EXECUTE.';
