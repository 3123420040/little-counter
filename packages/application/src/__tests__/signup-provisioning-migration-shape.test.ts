import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../../../../db/migrations/034_signup_provisioning_capability.sql"),
  "utf8",
);

describe("signup provisioning capability migration", () => {
  it("expands token purposes without modifying the historical migration", () => {
    expect(migration).toContain("tenant_provisioning");
    expect(migration).toContain("signup_verification_tokens_purpose_check");
    expect(migration).toContain("WHERE consumed_at IS NULL");
    expect(migration).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  });
});
