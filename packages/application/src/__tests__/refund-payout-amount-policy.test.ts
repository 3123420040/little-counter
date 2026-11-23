import { describe, expect, it } from "vitest";
import { resolveRefundPayoutAmountV1 } from "../services/refund-payout-amount-policy";

describe("refund payout amount policy", () => {
  const cancelledWeb = {
    channelActor: false,
    orderStatus: "canceled",
    payableBalanceMinor: 230_000,
    netCollectionsMinor: 230_000,
  } as const;

  it("uses the server-owned full payable for a web POS cancellation payout", () => {
    expect(resolveRefundPayoutAmountV1(cancelledWeb)).toBe(230_000);
    expect(resolveRefundPayoutAmountV1({
      ...cancelledWeb,
      requestedAmount: 230_000,
    })).toBe(230_000);
  });

  it("rejects partial, excessive, fractional and stale web POS payout amounts", () => {
    for (const requestedAmount of [1, 229_999, 230_001, 1.5, "bad"]) {
      expect(() => resolveRefundPayoutAmountV1({
        ...cancelledWeb,
        requestedAmount,
      })).toThrow(expect.objectContaining({
        code: "refund_amount_must_equal_payable",
        statusCode: 409,
      }));
    }
  });

  it("preserves bounded partial refunds only for channel actors and exact-clears active web payables", () => {
    expect(resolveRefundPayoutAmountV1({
      ...cancelledWeb,
      channelActor: true,
      requestedAmount: 1,
    })).toBe(1);
    expect(resolveRefundPayoutAmountV1({
      ...cancelledWeb,
      orderStatus: "completed",
      requestedAmount: 230_000,
    })).toBe(230_000);
    expect(() => resolveRefundPayoutAmountV1({
      ...cancelledWeb,
      orderStatus: "completed",
      requestedAmount: 10_000,
    })).toThrow(expect.objectContaining({ code: "refund_amount_must_equal_payable" }));
  });

  it("rejects empty payable and amounts beyond net recorded collection", () => {
    expect(() => resolveRefundPayoutAmountV1({
      ...cancelledWeb,
      payableBalanceMinor: 0,
      netCollectionsMinor: 0,
    })).toThrow(expect.objectContaining({
      code: "invalid_state_transition",
      statusCode: 409,
    }));
    expect(() => resolveRefundPayoutAmountV1({
      ...cancelledWeb,
      channelActor: true,
      requestedAmount: 240_000,
    })).toThrow(expect.objectContaining({
      code: "refund_amount_exceeds_balance",
      statusCode: 409,
    }));
  });
});
