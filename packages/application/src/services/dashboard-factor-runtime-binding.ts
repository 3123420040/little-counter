import {
  DASHBOARD_VISIBLE_FACTOR_IDS_V1,
  DashboardMetricRuntimeBindingV1Schema,
  DashboardMetricRuntimeRegistryV2Schema,
  DashboardPartialFinancialModelV1Schema,
  type DashboardMetricRuntimeBindingV1,
  type DashboardMetricRuntimeDependencyV1,
  type DashboardMetricRuntimeRegistryV2,
  type DashboardPartialFinancialModelV1,
} from "@medusa-snus/contracts";
import { DASHBOARD_METRIC_REGISTRY_V1 } from "./dashboard-metric-registry";

type FactorId = (typeof DASHBOARD_VISIBLE_FACTOR_IDS_V1)[number];

const RUNTIME_DEPENDENCY_BY_FACTOR_ID_V1 = {
  active_effective_order_count: "commercial_snapshot",
  ai_pending_count: "merchant_ai_review_snapshot",
  average_current_order_value: "commercial_snapshot",
  cancellation_rate: "commercial_snapshot",
  cancelled_order_cohort_count: "commercial_snapshot",
  current_gross_profit: "accounting_snapshot",
  current_merchandise_value: "commercial_snapshot",
  current_order_value_and_recorded_collection: "commercial_snapshot",
  current_shipping_value: "commercial_snapshot",
  daily_active_order_count_series: "commercial_daily_series",
  daily_order_value_and_collection_series: "commercial_collection_daily_series",
  dashboard_freshness_state: "report_context",
  date_range_control: "report_context",
  effective_item_quantity: "commercial_snapshot",
  gross_margin_percent: "accounting_snapshot",
  items_per_order: "commercial_snapshot",
  low_stock_count: "selected_store_inventory_snapshot",
  new_customer_count: "merchant_customer_snapshot",
  orders_with_shipping_count: "commercial_snapshot",
  out_of_stock_count: "selected_store_inventory_snapshot",
  payment_method_amount: "payment_method_snapshot",
  payment_method_order_count: "payment_method_snapshot",
  published_sku_count: "merchant_catalog_snapshot",
  shipping_share_percent: "commercial_snapshot",
  top_product_gross_sales: "commercial_snapshot",
  top_product_narrative: "commercial_snapshot",
  top_product_quantity: "commercial_snapshot",
} as const satisfies Record<FactorId, DashboardMetricRuntimeDependencyV1>;

const runtimeRegistryCandidate = {
  schemaVersion: 2 as const,
  registryStatus: "runtime_bound_partial_v1" as const,
  factors: DASHBOARD_METRIC_REGISTRY_V1.factors.map((factor) => {
    const runtimeDependency = RUNTIME_DEPENDENCY_BY_FACTOR_ID_V1[
      factor.factorId as FactorId
    ];
    return {
      ...structuredClone(factor),
      implementationState: "runtime_bound" as const,
      activationStatus: "runtime_bound" as const,
      runtimeDependency,
    };
  }),
};

function freezeRuntimeRegistry(
  input: DashboardMetricRuntimeRegistryV2,
): DashboardMetricRuntimeRegistryV2 {
  for (const factor of input.factors) {
    Object.freeze(factor.currentLabelsVi);
    Object.freeze(factor.targetMetricIds);
    Object.freeze(factor.unavailableTargetMetricIds);
    Object.freeze(factor.targetSources);
    Object.freeze(factor.timeBasis);
    Object.freeze(factor.activationDependencies);
    Object.freeze(factor);
  }
  Object.freeze(input.factors);
  return Object.freeze(input);
}

export const DASHBOARD_METRIC_RUNTIME_REGISTRY_V2 = freezeRuntimeRegistry(
  DashboardMetricRuntimeRegistryV2Schema.parse(runtimeRegistryCandidate),
);

function availability(
  factor: DashboardMetricRuntimeRegistryV2["factors"][number],
  model: DashboardPartialFinancialModelV1,
): boolean {
  const dependency = factor.runtimeDependency;
  switch (dependency) {
    case "accounting_snapshot":
      if (!(model.currencies.length > 0 && model.currencies.every(
        (currency) => currency.accounting?.status === "available",
      ))) {
        return false;
      }
      if (factor.factorId === "gross_margin_percent") {
        return model.currencies.every(
          (currency) => (
            currency.accounting?.status === "available"
            && currency.accounting.grossMarginPercent !== null
          ),
        );
      }
      return true;
    case "report_context":
      return true;
    case "commercial_snapshot":
      if (!(model.currencies.length > 0 && model.currencies.every(
        (currency) => currency.currentOrder.commercialMetrics !== undefined,
      ))) {
        return false;
      }
      if (factor.factorId === "average_current_order_value") {
        return model.currencies.every(
          (currency) => (
            currency.currentOrder.commercialMetrics?.averageCurrentOrderValueMinor
            !== null
          ),
        );
      }
      if (factor.factorId === "cancellation_rate") {
        return model.currencies.some((currency) => (
          currency.currentOrder.validOrderCount
          + (currency.currentOrder.commercialMetrics?.cancelledOrderCohortCount ?? 0)
          > 0
        ));
      }
      if (factor.factorId === "items_per_order") {
        return model.currencies.some(
          (currency) => currency.currentOrder.validOrderCount > 0,
        );
      }
      if (factor.factorId === "shipping_share_percent") {
        return model.currencies.every(
          (currency) => (
            currency.currentOrder.commercialMetrics?.currentShippingSharePercent
            !== null
          ),
        );
      }
      return true;
    case "commercial_daily_series":
      return model.dailyActiveOrderCountSeries !== undefined;
    case "commercial_collection_daily_series":
      return model.dailyActiveOrderCountSeries !== undefined
        && model.currencies.length > 0
        && model.currencies.every((currency) => (
          currency.dailyCurrentOrderGrossValueSeries !== undefined
          && currency.dailyRecordedGrossCollectionsSeries !== undefined
        ));
    case "merchant_ai_review_snapshot":
      return model.operationalSnapshot?.reportMerchantAiReviewQueue?.status
        === "available";
    case "merchant_catalog_snapshot":
      return model.operationalSnapshot?.reportMerchantCatalog.status === "available";
    case "merchant_customer_snapshot":
      return model.operationalSnapshot?.reportMerchantCustomerAcquisition?.status
        === "available";
    case "payment_method_snapshot":
      return model.currencies.length > 0 && model.currencies.every(
        (currency) => (
          currency.paymentFlow !== undefined
          && Array.isArray(currency.paymentFlow.methods)
        ),
      );
    case "selected_store_inventory_snapshot":
      return model.operationalSnapshot?.selectedReportStoresInventory.status
        === "available";
    case "unattached":
      return false;
  }
}

function dataQuality(
  dependency: DashboardMetricRuntimeDependencyV1,
  available: boolean,
  model: DashboardPartialFinancialModelV1,
): "complete" | "partial" | "unavailable" {
  if (!available) return "unavailable";
  if (
    dependency === "commercial_snapshot"
    && model.currencies.some(
      (currency) => currency.currentOrder.dataQualityStatus === "partial",
    )
  ) {
    return "partial";
  }
  return "complete";
}

function reason(
  factor: DashboardMetricRuntimeRegistryV2["factors"][number],
  available: boolean,
  model: DashboardPartialFinancialModelV1,
): string {
  if (available) {
    switch (factor.runtimeDependency) {
      case "report_context":
        return "exact canonical report context and reportAsOf are present";
      case "accounting_snapshot":
        return factor.factorId === "gross_margin_percent"
          ? "balanced posted accounting revenue/COGS and a positive denominator are complete for every currency"
          : "balanced posted accounting revenue/COGS with immutable source-time and cost provenance are complete for every currency";
      case "commercial_snapshot":
        return "exact canonical commercial snapshot dependency is present for every currency";
      case "commercial_daily_series":
        return "exact zero-filled canonical active-order daily series is present";
      case "commercial_collection_daily_series":
        return "exact zero-filled canonical order-value and collection daily series are present for every currency";
      case "merchant_ai_review_snapshot":
        return "exact merchant-wide AI review snapshot dependency is present";
      case "merchant_catalog_snapshot":
        return "exact merchant-wide published SKU identity snapshot is present";
      case "merchant_customer_snapshot":
        return "exact merchant-wide customer acquisition count is present under the approved Asia/Ho_Chi_Minh business-date rule";
      case "payment_method_snapshot":
        return "exact posted-event payment-method dependency is present for every currency";
      case "selected_store_inventory_snapshot":
        return "exact selected-report-store variant/location inventory snapshot is present";
      case "unattached":
        break;
    }
  }
  if (
    factor.runtimeDependency === "accounting_snapshot"
    && model.currencies.some((currency) => currency.accounting?.status === "unavailable")
  ) {
    const issues = model.currencies.flatMap((currency) => (
      currency.accounting?.status === "unavailable"
        ? currency.accounting.issues
        : []
    ));
    return `accounting snapshot is unavailable: ${[...new Set(issues)].sort().join(", ")}`;
  }
  if (
    factor.runtimeDependency === "accounting_snapshot"
    && factor.factorId === "gross_margin_percent"
    && model.currencies.some((currency) => (
      currency.accounting?.status === "available"
      && currency.accounting.grossMarginPercent === null
    ))
  ) {
    return "accounting gross margin is unavailable because at least one currency lacks a positive revenue denominator";
  }
  if (
    factor.runtimeDependency === "commercial_snapshot"
    && factor.factorId === "average_current_order_value"
  ) {
    return "average current order value is unavailable because at least one currency has no active order denominator";
  }
  if (
    factor.runtimeDependency === "commercial_snapshot"
    && factor.factorId === "cancellation_rate"
  ) {
    return "cancellation rate is unavailable because the selected cohort has no active or cancelled orders";
  }
  if (
    factor.runtimeDependency === "commercial_snapshot"
    && factor.factorId === "items_per_order"
  ) {
    return "items per order is unavailable because the selected cohort has no active orders";
  }
  if (
    factor.runtimeDependency === "merchant_ai_review_snapshot"
    && model.operationalSnapshot?.reportMerchantAiReviewQueue?.status
      === "unavailable"
  ) {
    return "merchant AI review snapshot is unavailable: "
      + model.operationalSnapshot.reportMerchantAiReviewQueue.issues.join(", ");
  }
  if (
    factor.runtimeDependency === "selected_store_inventory_snapshot"
    && model.operationalSnapshot?.selectedReportStoresInventory.status
      === "unavailable"
  ) {
    return "selected-report-store inventory snapshot is unavailable: "
      + model.operationalSnapshot.selectedReportStoresInventory.issues.join(", ");
  }
  if (factor.runtimeDependency === "unattached") {
    return factor.targetSources.includes("accounting_journal")
      ? "balanced accounting revenue/COGS coverage is not attached to this snapshot"
      : "same-scope same-reportAsOf canonical dependency is not attached; legacy fallback is forbidden";
  }
  return `${factor.runtimeDependency} dependency is not attached for every currency; legacy fallback is forbidden`;
}

export function createDashboardMetricRuntimeBindingV1(
  context: { reportAsOf: string },
  modelInput: DashboardPartialFinancialModelV1,
): DashboardMetricRuntimeBindingV1 {
  const model = DashboardPartialFinancialModelV1Schema.parse(modelInput);
  const factors = DASHBOARD_METRIC_RUNTIME_REGISTRY_V2.factors.map((factor) => {
    const available = availability(factor, model);
    return {
      ...structuredClone(factor),
      runtimeStatus: available ? "available" as const : "unavailable" as const,
      runtimeDataQualityStatus: dataQuality(
        factor.runtimeDependency,
        available,
        model,
      ),
      runtimeReason: reason(factor, available, model),
    };
  });
  const availableCount = factors.filter(
    (factor) => factor.runtimeStatus === "available",
  ).length;
  return DashboardMetricRuntimeBindingV1Schema.parse({
    schemaVersion: 1,
    contract: "dashboard.metric-runtime-binding.v1",
    registrySchemaVersion: 2,
    registryStatus: "runtime_bound_partial_v1",
    reportAsOf: context.reportAsOf,
    availableCount,
    unavailableCount: factors.length - availableCount,
    factors,
  });
}
