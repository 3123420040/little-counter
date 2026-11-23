/**
 * Canonical order-financial product selection. This is not an environment or
 * merchant flag: every UI surface uses the effective-order implementation.
 */
export interface OrderFinancialFeatureUiConfigV1 {
  effectiveOrderPageEnabled: boolean;
  effectiveOrderDetailEnabled: boolean;
  effectiveReceiptEnabled: boolean;
  effectiveRecreateEnabled: boolean;
  effectiveCsvEnabled: boolean;
  partialFinancialDashboardEnabled: boolean;
}

export const ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1: Readonly<OrderFinancialFeatureUiConfigV1> = Object.freeze({
  effectiveOrderPageEnabled: true,
  effectiveOrderDetailEnabled: true,
  effectiveReceiptEnabled: true,
  effectiveRecreateEnabled: true,
  effectiveCsvEnabled: true,
  partialFinancialDashboardEnabled: true,
});
