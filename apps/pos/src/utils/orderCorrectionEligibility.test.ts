import { describe, expect, it } from "vitest";
import type { OrderListItem } from "../api/endpoints";
import { getOrderCorrectionEligibility } from "./orderCorrectionEligibility";

function order(overrides: Partial<OrderListItem> = {}): OrderListItem {
  return {
    id: "order_test",
    display_id: "ORD-TEST",
    status: "completed",
    total: 100_000,
    created_at: "2026-06-24T00:00:00.000Z",
    paymentMethod: "cash",
    paymentStatus: "posted",
    ...overrides,
  };
}

describe("getOrderCorrectionEligibility", () => {
  it("allows a completed cash order", () => {
    expect(getOrderCorrectionEligibility(order())).toEqual({ allowed: true });
  });

  it("blocks canceled and refunded orders with an operator-facing reason", () => {
    expect(getOrderCorrectionEligibility(order({ status: "canceled" }))).toEqual({
      allowed: false,
      reason: "Đơn đã hủy không thể điều chỉnh.",
    });
    expect(getOrderCorrectionEligibility(order({
      paymentEntries: [{
        id: "refund_test",
        direction: "refund",
        method: "cash",
        amount: 100_000,
        currencyCode: "VND",
        status: "posted",
      }],
    })).allowed).toBe(false);
  });

  it("blocks unresolved settlement and manual-review states", () => {
    expect(getOrderCorrectionEligibility(order({
      correctionSummary: { latestRevision: 1, effectiveTotal: 100_000, hasPendingSettlement: true },
    })).allowed).toBe(false);
    expect(getOrderCorrectionEligibility(order({ paymentStatus: "manual_review" })).allowed).toBe(false);
  });

  it.each(["sepay_va", "nowpayments", "crypto_usdc", "crypto_usdt"])(
    "blocks external payment method %s",
    (paymentMethod) => {
      expect(getOrderCorrectionEligibility(order({ paymentMethod })).allowed).toBe(false);
    },
  );
});
