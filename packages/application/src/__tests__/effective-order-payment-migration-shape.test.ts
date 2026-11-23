import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = resolve(
  __dirname,
  "../../../../db/migrations/026_effective_orders_and_payment_events.sql",
);

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

function withoutCommentsOrFunctionBodies(value: string): string {
  return value
    .replace(/--.*$/gm, "")
    .replace(/\$[a-z_]*\$[\s\S]*?\$[a-z_]*\$/gi, "");
}

describe("DB-026 effective-order/payment migration contract", () => {
  it("is expand-only and performs no top-level business-data mutation", () => {
    const source = withoutCommentsOrFunctionBodies(sql());

    expect(source).not.toMatch(/^\s*(insert|update|delete|merge|truncate)\b/gim);
    expect(source).not.toMatch(/\b(drop\s+(table|column|schema)|alter\s+column\s+.+\s+type)\b/i);
    expect(source).not.toMatch(/\b(3311|customer_refund_payable|historical[_ ]?cod)\b/i);
  });

  it("defines tenant-scoped immutable commercial revision snapshots", () => {
    const source = sql().toLowerCase();

    for (const relation of [
      "app.order_commercial_revisions",
      "app.order_commercial_revision_components",
      "app.order_commercial_revision_lines",
    ]) {
      expect(source).toContain(`create table if not exists ${relation}`);
    }
    expect(source).toContain("unique (merchant_id, store_id, order_id, revision)");
    expect(source).toContain("merchandise_gross_minor");
    expect(source).toContain("discount_minor");
    expect(source).toContain("shipping_minor");
    expect(source).toContain("tax_mode");
    expect(source).toContain("merchandise_vat_minor");
    expect(source).toContain("shipping_vat_minor");
    expect(source).toContain("vat_minor");
    expect(source).toContain("unclassified_minor");
    expect(source).toContain("total_minor");
    expect(source).toMatch(/vat_minor\s*=\s*merchandise_vat_minor\s*\+\s*shipping_vat_minor/i);
    expect(source).toMatch(/case\s+tax_mode[\s\S]*when\s+'exclusive'\s+then\s+vat_minor[\s\S]*else\s+0[\s\S]*end[\s\S]*=\s*total_minor/i);
    expect(source).toContain("reject_immutable_financial_fact_mutation");
    expect(source).toContain("assert_order_financial_scope");
    expect(source).toContain("assert_commercial_revision_bundle");
    expect(source).toContain("commercial revision line total does not reconcile");
  });

  it("binds every line snapshot to the exact scoped revision header", () => {
    const source = sql().toLowerCase();

    expect(source).toMatch(
      /unique\s*\(\s*merchant_id\s*,\s*store_id\s*,\s*order_id\s*,\s*revision\s*,\s*id\s*\)/,
    );
    expect(source).toMatch(
      /foreign key\s*\(\s*merchant_id\s*,\s*store_id\s*,\s*order_id\s*,\s*revision\s*,\s*revision_id\s*\)\s*references\s+app\.order_commercial_revisions\s*\(\s*merchant_id\s*,\s*store_id\s*,\s*order_id\s*,\s*revision\s*,\s*id\s*\)/,
    );
  });

  it("defines evidence-bound payment events and currency-safe allocations", () => {
    const source = sql().toLowerCase();

    for (const relation of [
      "app.payment_events",
      "app.payment_event_evidence",
      "app.payment_event_component_allocations",
      "app.payment_correction_component_deltas",
      "app.commercial_obligations",
      "app.payment_event_allocations",
    ]) {
      expect(source).toContain(`create table if not exists ${relation}`);
    }
    expect(source).toContain("amount_minor bigint");
    expect(source).toContain("minor_unit_exponent");
    expect(source).toContain("evidence_fingerprint");
    expect(source).toContain("provider_webhook_success");
    expect(source).toContain("cod_order_created");
    expect(source).toContain("commercial_revision_id");
    expect(source).toContain("unique (merchant_id, store_id, idempotency_key)");
    expect(source).toContain("assert_payment_component_allocation");
    expect(source).toContain("assert_payment_event_evidence_match");
    expect(source).toContain("assert_posted_payment_event_bundle");
    expect(source).toContain("posted payment event lacks verified exact evidence");
    expect(source).toContain("posted charge event requires exactly one component basis");
    expect(source).toContain("posted payment event is not fully allocated to obligations");
    expect(source).toContain("deferrable initially deferred");
    expect(source).toContain("assert_payment_allocation_scope_currency");
    expect(source).toContain("when 'collection' then 'charge'");
    expect(source).toContain("allocation exceeds payment event amount");
    expect(source).toContain("collection allocation exceeds commercial obligation");
    expect(source).toContain("negative allocation exceeds recorded collection");
    expect(source).toContain("order_correction_charge");
    expect(source).toContain("merchandise_gross_delta_minor bigint not null");
    expect(source).toContain("discount_delta_minor bigint not null");
    expect(source).toContain("total_delta_minor bigint not null check (total_delta_minor > 0)");
    expect(source).toContain("payment event cannot have full and signed component bases");
    expect(source).toContain("assert_payment_correction_component_delta");
  });
});
