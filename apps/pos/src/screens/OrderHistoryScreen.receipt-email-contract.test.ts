import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./OrderHistoryScreen.tsx", import.meta.url), "utf8");

describe("OrderHistoryScreen receipt email contract", () => {
  it("blocks malformed recipients before the request", () => {
    expect(source).toContain("const receiptEmailValidation = validateReceiptEmail(receiptEmail)");
    expect(source).toContain("!receiptEmailValidation.valid");
    expect(source).toContain("emailReceipt(selected.id, receiptEmailValidation.normalized)");
    expect(source).toContain("aria-invalid={!receiptEmailValidation.valid");
    expect(source).toContain("maxLength={320}");
  });
});
