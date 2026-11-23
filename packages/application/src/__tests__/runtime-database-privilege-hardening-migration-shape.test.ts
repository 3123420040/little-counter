import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  __dirname,
  "../../../../db/migrations/032_runtime_database_privilege_hardening.sql",
), "utf8");
const clientSource = readFileSync(resolve(__dirname, "../db/client.ts"), "utf8");
const dashboardSource = readFileSync(resolve(__dirname, "../services/dashboard-service.ts"), "utf8");
const featureRouteSource = readFileSync(resolve(
  __dirname,
  "../services/order-financial-feature-route-service.ts",
), "utf8");

describe("migration 032 runtime database privilege hardening", () => {
  it("hardens all 026-031 app/outbox functions without changing their prior bytes", () => {
    expect(migration).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC");
    expect(migration).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA outbox FROM PUBLIC");
    expect(migration).not.toMatch(/search_path\s*=.*public/i);

    for (const signature of [
      "app.assert_order_financial_scope()",
      "app.assert_payment_allocation_scope_currency()",
      "app.assert_payment_component_allocation()",
      "app.assert_payment_correction_component_delta()",
      "app.assert_payment_event_evidence_match()",
      "app.assert_commercial_revision_bundle()",
      "app.assert_posted_payment_event_bundle()",
      "app.reject_immutable_financial_fact_mutation()",
      "outbox.allocate_aggregate_sequence(text, text, text, text)",
      "outbox.enforce_new_event_causality()",
      "outbox.reject_outbox_causality_mutation()",
      "outbox.reject_outbox_event_delete()",
      "outbox.claim_exact_events(text, integer, integer)",
      "outbox.complete_exact_event_claim(uuid, text, uuid, bigint)",
      "app.bump_order_collection_revision(text, text, text, text, text)",
      "app.invalidate_order_collection()",
      "app.guard_order_collection_revision_state()",
      "app.reject_collection_revision_event_mutation()",
      "app.assert_collection_revision_event_pair()",
      "app.assert_customer_refund_payable_scope()",
      "app.assert_customer_refund_payable_event()",
      "app.assert_customer_refund_payout_allocation()",
      "app.assert_customer_refund_payable_bundle()",
      "app.assert_customer_refund_payout_event_bundle()",
      "app.reject_immutable_customer_refund_fact_mutation()",
      "app.reject_historical_reconciliation_mutation()",
    ]) {
      expect(migration).toContain(`ALTER FUNCTION ${signature}`);
    }
    expect(migration).toContain("uuid, text, uuid, bigint, text, text, timestamptz, boolean, text");
  });

  it("uses security-definer only for narrow state coordinators", () => {
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(5);
    expect(migration).toContain("outbox.allocate_aggregate_sequence(text, text, text, text)\n  SECURITY DEFINER");
    expect(migration).toContain("outbox.claim_exact_events(text, integer, integer)\n  SECURITY DEFINER");
    expect(migration).toContain("app.bump_order_collection_revision(text, text, text, text, text)\n  SECURITY DEFINER");
  });

  it("routes dashboard and effective-order reads through a distinct report pool", () => {
    expect(clientSource).toContain("getReportDatabaseUrl");
    expect(clientSource).toContain("connectReportClient");
    expect(dashboardSource).toContain("withConnectedReportClient");
    expect(featureRouteSource).toContain("withConnectedReportClient");
    expect(featureRouteSource).not.toContain("withConnectedClient");
  });
});
