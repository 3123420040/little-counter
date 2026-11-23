import type { DashboardPartialFinancialRuntimeHttpBodyV1 } from "@medusa-snus/contracts";
import type { ClientScopeSnapshot } from "../api/client";
import {
  ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1,
  type OrderFinancialFeatureUiConfigV1,
} from "../config/orderFinancialFeature";
import {
  createDashboardPartialFinancialQueryTaskV1,
  type DashboardPartialFinancialQueryTaskDependenciesV1,
  type DashboardPartialFinancialQueryTaskV1,
} from "./dashboardPartialFinancialQueryTask";

export interface PartialFinancialDashboardUiInputV1 {
  from: string;
  to: string;
  nowEpochSeconds: number;
  requestId: string;
  scope: ClientScopeSnapshot;
}

function inclusiveDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
}

export function createPartialFinancialDashboardUiTaskV1(
  transport: DashboardPartialFinancialQueryTaskDependenciesV1["transport"],
  input: PartialFinancialDashboardUiInputV1,
  config: OrderFinancialFeatureUiConfigV1 = ORDER_FINANCIAL_FEATURE_UI_DEFAULT_CONFIG_V1,
): DashboardPartialFinancialQueryTaskV1 {
  if (!config.partialFinancialDashboardEnabled) {
    return createDashboardPartialFinancialQueryTaskV1({ transport }, {
      requestId: "disabled",
      scope: { scopeKind: "report", merchantId: "disabled", storeIds: ["disabled"] },
      range: { from: "1970-01-01", to: "1970-01-01", inclusiveDays: 1 },
      nowEpochSeconds: 0,
    });
  }
  const days = inclusiveDays(input.from, input.to);
  if (
    !input.scope.reportMerchantId
    || input.scope.reportStoreIds.length === 0
    || days < 1
  ) {
    throw new Error("Partial financial dashboard requires an active report scope and valid range");
  }
  return createDashboardPartialFinancialQueryTaskV1({
    transport,
    config: { enabled: true },
  }, {
    requestId: input.requestId,
    scope: {
      scopeKind: "report",
      merchantId: input.scope.reportMerchantId,
      storeIds: [...input.scope.reportStoreIds],
    },
    range: { from: input.from, to: input.to, inclusiveDays: days },
    nowEpochSeconds: input.nowEpochSeconds,
  });
}

export function partialFinancialDashboardPathV1(
  request: Parameters<DashboardPartialFinancialQueryTaskDependenciesV1["transport"]>[0],
): string {
  const params = new URLSearchParams({
    from: request.range.from,
    to: request.range.to,
  });
  return `/api/platform/admin/dashboard/partial-financial?${params.toString()}`;
}

export type PartialFinancialDashboardFeatureBodyV1 =
  DashboardPartialFinancialRuntimeHttpBodyV1;
