import { describe, expect, it } from "vitest";
import { isPaymentIntentCartLocked } from "./paymentIntentState";

describe("isPaymentIntentCartLocked", () => {
  it("locks the quoted cart while provider payment is pending or paid", () => {
    expect(isPaymentIntentCartLocked("pending")).toBe(true);
    expect(isPaymentIntentCartLocked("paid")).toBe(true);
  });

  it("unlocks after cancellation, expiry, failure, or completion", () => {
    for (const status of ["cancelled", "expired", "failed", "manual_review", "completed", null]) {
      expect(isPaymentIntentCartLocked(status)).toBe(false);
    }
  });
});
