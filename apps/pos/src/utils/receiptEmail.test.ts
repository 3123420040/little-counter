import { describe, expect, it } from "vitest";
import { validateReceiptEmail } from "./receiptEmail";

describe("receipt email validation", () => {
  it("normalizes a valid recipient", () => {
    expect(validateReceiptEmail("  customer@example.com  ")).toEqual({
      valid: true,
      normalized: "customer@example.com",
      error: null,
    });
  });

  it("rejects empty, malformed, and oversized recipients", () => {
    expect(validateReceiptEmail("")).toMatchObject({ valid: false, normalized: null });
    expect(validateReceiptEmail("not-an-email")).toMatchObject({ valid: false, normalized: null });
    expect(validateReceiptEmail(`${"a".repeat(310)}@example.com`)).toMatchObject({ valid: false, normalized: null });
  });
});
