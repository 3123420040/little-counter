import {
  DashboardPartialFinancialRuntimeHttpBodyV1Schema,
  DashboardPartialFinancialModelV1Schema,
  DashboardReportContextV1Schema,
  ReportScopeSchema,
  permissions,
  type DashboardPartialFinancialRuntimeHttpBodyV1,
  type ReportScope,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import {
  DASHBOARD_SNAPSHOT_TIMEOUT_HARD_CAP_MS,
  normalizeDashboardLocalDateRange,
  type DashboardLocalDateRangeInput,
  type DashboardSnapshotRequest,
} from "./dashboard-report-foundation";
import {
  readDashboardPartialFinancialSnapshotV1,
  type DashboardPartialFinancialSnapshotResultV1,
} from "./dashboard-partial-financial-model";
import { createDashboardMetricRuntimeBindingV1 } from "./dashboard-factor-runtime-binding";

export const DASHBOARD_PARTIAL_FINANCIAL_HTTP_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: false,
  statementTimeoutMs: 5_000,
});

type ReadPartialFinancialSnapshotV1 = (
  client: PoolClient,
  request: DashboardSnapshotRequest,
  config: { enabled: boolean },
) => Promise<DashboardPartialFinancialSnapshotResultV1>;

export interface DashboardPartialFinancialHttpHandlerDependenciesV1 {
  client: PoolClient;
  readSnapshot?: ReadPartialFinancialSnapshotV1;
  config?: {
    enabled: boolean;
    statementTimeoutMs: number;
  };
}

export interface DashboardPartialFinancialHttpRequestV1 {
  authorization: {
    permission: typeof permissions.reportsRead;
    scope: ReportScope;
  };
  range: DashboardLocalDateRangeInput;
}

export interface DashboardPartialFinancialHttpResponseV1 {
  statusCode: 200;
  headers: Record<string, string>;
  body: DashboardPartialFinancialRuntimeHttpBodyV1;
}

function normalizeAuthorizedScope(input: unknown): ReportScope {
  const parsed = ReportScopeSchema.safeParse(input);
  if (!parsed.success || new Set(parsed.data.storeIds).size !== parsed.data.storeIds.length) {
    throw new PlatformError(
      "scope_required",
      "Partial financial dashboard requires one merchant and a unique authorized store set",
      409,
    );
  }
  return {
    scopeKind: "report",
    merchantId: parsed.data.merchantId,
    storeIds: [...parsed.data.storeIds].sort(),
  };
}

function boundedTimeout(value: unknown): number {
  if (
    !Number.isInteger(value)
    || Number(value) < 1
    || Number(value) > DASHBOARD_SNAPSHOT_TIMEOUT_HARD_CAP_MS
  ) {
    throw new PlatformError(
      "feature_unavailable",
      "Partial financial dashboard timeout configuration is unavailable",
      503,
    );
  }
  return Number(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function invalidResponse(): never {
  throw new PlatformError(
    "dashboard_response_invalid",
    "Partial financial dashboard response failed its contract",
    502,
  );
}

export async function handleDashboardPartialFinancialHttpV1(
  dependencies: DashboardPartialFinancialHttpHandlerDependenciesV1,
  request: DashboardPartialFinancialHttpRequestV1,
): Promise<DashboardPartialFinancialHttpResponseV1> {
  if (request.authorization?.permission !== permissions.reportsRead) {
    throw new PlatformError(
      "forbidden",
      "The reports:read permission is required",
      403,
    );
  }
  const scope = normalizeAuthorizedScope(request.authorization.scope);
  const config = dependencies.config ?? DASHBOARD_PARTIAL_FINANCIAL_HTTP_DEFAULT_CONFIG_V1;
  if (config.enabled !== true) {
    throw new PlatformError(
      "feature_disabled",
      "Partial financial dashboard v1 is disabled",
      403,
    );
  }
  const statementTimeoutMs = boundedTimeout(config.statementTimeoutMs);
  const range = normalizeDashboardLocalDateRange(request.range);
  const readSnapshot = dependencies.readSnapshot ?? readDashboardPartialFinancialSnapshotV1;
  const result = await readSnapshot(dependencies.client, {
    scope,
    range: { from: range.from, to: range.to },
    statementTimeoutMs,
    storeStatusPolicy: "active_or_suspended",
  }, { enabled: true });
  if (!result.enabled) {
    throw new PlatformError(
      "feature_unavailable",
      "Partial financial dashboard reader is unavailable",
      503,
    );
  }

  const parsedContext = DashboardReportContextV1Schema.safeParse(result.snapshot.context);
  const parsedData = DashboardPartialFinancialModelV1Schema.safeParse(result.snapshot.data);
  if (!parsedContext.success || !parsedData.success) return invalidResponse();
  const responseScope = parsedContext.data.normalizedScope;
  const responseRange = parsedContext.data.localDateRange;
  if (
    responseScope.merchantId !== scope.merchantId
    || !sameStrings(responseScope.storeIds, scope.storeIds)
    || responseRange.from !== range.from
    || responseRange.to !== range.to
    || responseRange.inclusiveDays !== range.inclusiveDays
  ) {
    return invalidResponse();
  }

  const factorBinding = createDashboardMetricRuntimeBindingV1(
    parsedContext.data,
    parsedData.data,
  );
  const body = DashboardPartialFinancialRuntimeHttpBodyV1Schema.parse({
    schemaVersion: 1,
    contract: "dashboard.partial-financial.v1",
    context: parsedContext.data,
    data: parsedData.data,
    factorBinding,
  });
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Dashboard-Contract": body.contract,
      "X-Dashboard-Completeness": body.data.completeness,
      "X-Dashboard-Aggregate-Source": body.data.aggregateReadSource,
      "X-Dashboard-Report-As-Of": body.context.reportAsOf,
      "X-Dashboard-Generated-At": body.context.generatedAt,
      "X-Dashboard-Currency-Count": String(body.data.currencies.length),
      "X-Dashboard-Factor-Count": String(body.factorBinding.factors.length),
      "X-Dashboard-Factor-Available": String(body.factorBinding.availableCount),
      "X-Dashboard-Factor-Registry": body.factorBinding.registryStatus,
    },
    body,
  };
}
