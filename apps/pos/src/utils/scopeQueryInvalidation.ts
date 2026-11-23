export function shouldInvalidateOnScopeChange(queryKey: readonly unknown[]): boolean {
  return queryKey[0] !== "me";
}

/**
 * Every read model whose answer can change after an order/commercial mutation.
 *
 * Keep this list centralized so legacy and effective-order surfaces never drift
 * simply because one writer forgot to refresh the canonical projection.
 */
export function orderFinancialMutationQueryKeys(orderId?: string): ReadonlyArray<readonly unknown[]> {
  const keys: Array<readonly unknown[]> = [
    ["orders"],
    ["paymentIntents"],
    ["ordersEffectivePageV2"],
    ["ordersEffectivePageV3"],
    ["ordersEffectivePageV4"],
    ["ordersEffectivePageV5"],
    ["dashboard"],
    ["dashboardPartialFinancialV1"],
    ["dashboardCreatorSalesV2"],
    ["dashboardCreatorSalesV3"],
    ["orderEffectiveDetailV2"],
    ["orderEffectiveDetailV3"],
    ["orderRecreatePrefillV2"],
    ["orderRecreatePrefillV3"],
    ["orderCorrectionContextV1"],
    ["incomeStatement"],
    ["balanceSheet"],
    ["cashFlow"],
  ];

  if (orderId) {
    keys.push(
      ["order", orderId],
      ["orderEffectiveDetailV2", orderId],
      ["order", orderId, "recreate-prefill"],
      ["order", orderId, "recreate-prefill-v2"],
      ["order", orderId, "cancellation-quote"],
    );
  }

  return keys;
}
