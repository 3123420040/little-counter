import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../../../db/migrations/030_historical_reconciliation_foundation.sql", import.meta.url),
  "utf8",
);

describe("migration 030 historical reconciliation foundation", () => {
  it("creates only additive run/item provenance and no business-fact backfill", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS app.historical_reconciliation_runs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS app.historical_reconciliation_items");
    expect(sql).toContain("snus-historical-foundation-manifest/v1");
    expect(sql).toContain("accepted_count + quarantine_count + no_op_count = candidate_count");
    expect(sql).toContain("decision IN ('accept', 'quarantine', 'no_op')");
    expect(sql).toContain("append-only");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:order_commercial|payment_events|customer_refund)/i);
    expect(sql).not.toMatch(/UPDATE\s+(?:public\."order"|app\.payment_entries|accounting\.)/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });
});
