import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../services/dashboard-service.ts", import.meta.url),
  "utf8",
);

describe("live dashboard effective-order wiring", () => {
  it("reads commercial cards, daily series, items and top products from latest revisions", () => {
    expect(source).toContain("app.order_commercial_revisions");
    expect(source).toContain("app.order_commercial_revision_components");
    expect(source).toContain("app.order_commercial_revision_lines");
    expect(source).toContain("ORDER BY candidate.revision DESC");
    expect(source).toContain("commercial_state = 'active'");
    expect(source).not.toContain("metadata->>'total'");
    expect(source).not.toContain("public.order_item");
  });

  it("reads payment mix only from exact posted canonical charge events", () => {
    expect(source).toContain("FROM app.payment_events events");
    expect(source).toContain("events.kind = 'charge'");
    expect(source).toContain("events.status = 'posted'");
    expect(source).toContain("FROM app.payment_event_evidence evidence");
    expect(source).toContain("FROM app.payment_event_allocations allocations");
    expect(source).not.toContain("metadata->>'paymentMethod'");
  });

  it("keeps all dashboard factors in one repeatable-read database snapshot", () => {
    expect(source).toContain("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(source).toContain('await client.query("COMMIT")');
    expect(source).toContain('await client.query("ROLLBACK")');
  });

  it("uses exact per-store local-day windows instead of UTC date casts", () => {
    expect(source).toContain("resolveDashboardHistoryStoreWindows");
    expect(source).toContain("o.created_at >= windows.start_inclusive");
    expect(source).toContain("o.created_at < windows.end_exclusive");
    expect(source).toContain("events.source_occurred_at >= windows.start_inclusive");
    expect(source).toContain("events.source_occurred_at < windows.end_exclusive");
    expect(source).not.toContain("created_at::date");
    expect(source).not.toContain("source_occurred_at::date");
  });

  it("does not fabricate a merchant customer count without a business-date contract", () => {
    expect(source).toContain("customersToday: null");
    expect(source).toContain("newCustomers: null");
  });
});
