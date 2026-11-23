import { describe, expect, it } from "vitest";
import {
  orderFinancialMutationQueryKeys,
  shouldInvalidateOnScopeChange,
} from "./scopeQueryInvalidation";

describe("report-scope query invalidation", () => {
  it("invalidates account balances when merchant/store report scope changes", () => {
    expect(shouldInvalidateOnScopeChange(["accounts"])).toBe(true);
  });

  it("preserves only the actor bootstrap query", () => {
    expect(shouldInvalidateOnScopeChange(["me", "operator-a"])).toBe(false);
    expect(shouldInvalidateOnScopeChange(["journalEntries"])).toBe(true);
    expect(shouldInvalidateOnScopeChange(["dashboard"])).toBe(true);
  });

  it("invalidates every canonical and legacy financial surface after an order mutation", () => {
    expect(orderFinancialMutationQueryKeys("order-1")).toEqual(expect.arrayContaining([
      ["orders"],
      ["paymentIntents"],
      ["ordersEffectivePageV2"],
      ["ordersEffectivePageV3"],
      ["ordersEffectivePageV4"],
      ["ordersEffectivePageV5"],
      ["dashboardCreatorSalesV2"],
      ["dashboardCreatorSalesV3"],
      ["orderEffectiveDetailV2"],
      ["orderEffectiveDetailV3"],
      ["orderRecreatePrefillV2"],
      ["orderRecreatePrefillV3"],
      ["orderCorrectionContextV1"],
      ["dashboard"],
      ["dashboardPartialFinancialV1"],
      ["order", "order-1"],
      ["orderEffectiveDetailV2", "order-1"],
      ["order", "order-1", "recreate-prefill"],
      ["order", "order-1", "recreate-prefill-v2"],
      ["order", "order-1", "cancellation-quote"],
    ]));
  });

  it("uses root invalidation for newly-created orders without inventing an order id", () => {
    const keys = orderFinancialMutationQueryKeys();
    expect(keys).toContainEqual(["ordersEffectivePageV2"]);
    expect(keys).toContainEqual(["ordersEffectivePageV3"]);
    expect(keys).toContainEqual(["dashboardPartialFinancialV1"]);
    expect(keys.some((key) => key[0] === "order")).toBe(false);
  });
});
