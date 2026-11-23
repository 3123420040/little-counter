import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { requiresOfflineCheckoutReview } from "./offlineCheckoutReview";

describe("requiresOfflineCheckoutReview", () => {
  it.each(["cart_quote_changed", "validation_error", "unsupported_contract", "variant_price_unavailable"])("holds %s for explicit review instead of retrying an unrepairable body", code => {
    expect(requiresOfflineCheckoutReview(new ApiError("Cần kiểm tra lại đơn", 409, code))).toBe(true);
  });
  it("holds a stale bank-policy replay for staff review", () => {
    expect(requiresOfflineCheckoutReview(new ApiError(
      "Bank transfer policy changed",
      409,
      "checkout_policy_refresh_required",
    ))).toBe(true);
  });

  it("holds a missing bank acknowledgment for staff review", () => {
    expect(requiresOfflineCheckoutReview(new ApiError(
      "Acknowledgment required",
      409,
      "checkout_bank_acknowledgment_required",
    ))).toBe(true);
  });

  it("keeps transient failures retryable", () => {
    expect(requiresOfflineCheckoutReview(new Error("network unavailable"))).toBe(false);
  });
});
