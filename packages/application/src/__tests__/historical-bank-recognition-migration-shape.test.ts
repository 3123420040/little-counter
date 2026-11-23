import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../../db/migrations/035_historical_bank_recognition.sql", import.meta.url),
  "utf8",
);
const runtimeTriggerGuard = readFileSync(
  new URL("../../../../db/migrations/036_historical_bank_recognition_runtime_trigger_guard.sql", import.meta.url),
  "utf8",
);

describe("historical bank-recognition migration", () => {
  it("is additive, append-only, and admits only the narrow historical proof", () => {
    expect(migration).toContain("owner_historical_recognition");
    expect(migration).toContain("historical_bank_initial_recognition");
    expect(migration).toContain("historical_bank_correction_recognition");
    expect(migration).toContain("app.historical_bank_recognition_runs");
    expect(migration).toContain("app.historical_bank_recognition_items");
    expect(migration).toContain("historical_bank_recognition_runs_append_only");
    expect(migration).toContain("historical_bank_recognition_items_append_only");
    expect(migration).toContain("assert_historical_bank_recognition_evidence");
    expect(migration).toContain("REVOKE ALL ON app.historical_bank_recognition_runs FROM PUBLIC");
    expect(migration).toContain("REVOKE ALL ON app.historical_bank_recognition_items FROM PUBLIC");
    expect(migration).not.toMatch(/UPDATE\s+app\.payment_events/i);
    expect(migration).not.toMatch(/DISABLE\s+TRIGGER/i);
    expect(migration).not.toMatch(/GRANT\s+ALL/i);
  });

  it("keeps normal runtime writes outside the registry while historical writes still fail closed", () => {
    expect(runtimeTriggerGuard).toContain("event_evidence_type IS DISTINCT FROM 'owner_historical_recognition'");
    expect(runtimeTriggerGuard).toContain("JOIN app.historical_bank_recognition_items items");
    expect(runtimeTriggerGuard).toContain("REVOKE EXECUTE ON FUNCTION app.assert_historical_bank_recognition_components() FROM PUBLIC");
    expect(runtimeTriggerGuard).toContain("REVOKE EXECUTE ON FUNCTION app.assert_historical_bank_recognition_correction_delta() FROM PUBLIC");
    expect(runtimeTriggerGuard).not.toContain("SECURITY DEFINER");
    expect(runtimeTriggerGuard).not.toMatch(/GRANT\s+/i);
  });
});
