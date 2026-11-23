import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  __dirname,
  "../../../../db/migrations/031_manual_bank_correction_confirmation_lineage.sql",
);

describe("DB-031 manual-bank correction confirmation lineage", () => {
  it("is data-mutation-free and preserves the immutable append model", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const topLevel = sql.replace(/--.*$/gm, "").replace(/\$function\$[\s\S]*?\$function\$/g, "");
    expect(topLevel).not.toMatch(/^\s*(insert|update|delete|merge|truncate)\b/gim);
    expect(topLevel).not.toMatch(/\b(drop\s+(table|column|schema)|alter\s+table)\b/i);
    expect(sql).toContain("manual_bank_correction_confirmation");
    expect(sql).toContain("priorPendingPaymentEventId");
    expect(sql).toContain("prior_pending.status = 'pending'");
    expect(sql).toContain("prior_pending.method = 'manual_bank'");
    expect(sql).toContain("event_scope.status = 'posted'");
    expect(sql).toContain("event_scope.evidence_type = 'manual_verified'");
    expect(sql).toContain("event_scope.metadata->>'contractFingerprint' = NEW.contract_fingerprint");
    expect(sql).toContain("SET search_path = pg_catalog, app");
  });
});
