import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(
    new URL("../../../../db/migrations/029_customer_refund_payables.sql", import.meta.url),
  ),
  "utf8",
);

describe("DB-029 customer refund payable migration", () => {
  it("uses a dedicated customer liability and never vendor payable semantics", () => {
    expect(source).toContain("'CUSTOMER_REFUND_PAYABLE'");
    expect(source).toContain("'liability'");
    expect(source).not.toMatch(/['"]3311['"]/);
  });

  it("separates payable, lifecycle event, payment event and payout allocation facts", () => {
    for (const relation of [
      "app.customer_refund_payables",
      "app.customer_refund_payable_events",
      "app.customer_refund_payout_allocations",
      "app.customer_refund_payable_balances",
    ]) expect(source).toContain(relation);
    expect(source).toContain("event_kind IN ('open', 'clear')");
    expect(source).toContain("clearance_kind = 'payout'");
    expect(source).toContain("payment_event_id UUID NOT NULL");
  });

  it("fails closed on tenant/currency/amount drift and over-clearance", () => {
    for (const invariant of [
      "customer refund payable order scope mismatch",
      "customer refund payable event scope/currency mismatch",
      "customer refund payable clear exceeds open balance",
      "customer refund payable payout event mismatch",
      "customer refund payout allocation does not match clear event",
    ]) expect(source).toContain(invariant);
  });

  it("keeps financial facts immutable and checks deferred bundle completeness", () => {
    expect(source).toContain("reject_immutable_customer_refund_fact_mutation");
    expect(source).toContain("BEFORE UPDATE OR DELETE");
    expect(source).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(source).toContain("customer refund payable requires one exact open event");
    expect(source).toContain("customer refund payout clear requires one exact allocation");
  });

  it("is additive and contains no destructive schema operation", () => {
    expect(source).not.toMatch(/\bDROP\s+(TABLE|VIEW|COLUMN|SCHEMA)\b/i);
    expect(source).not.toMatch(/\bTRUNCATE\b/i);
  });
});
