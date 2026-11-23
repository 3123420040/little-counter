import {
  DashboardLocalDateRangeV1Schema,
  DashboardPartialFinancialRuntimeHttpBodyV1Schema,
  ReportScopeSchema,
  type DashboardLocalDateRangeV1,
  type DashboardPartialFinancialRuntimeHttpBodyV1,
  type ReportScope,
} from "@medusa-snus/contracts";
import {
  presentDashboardPartialFinancialV1,
  type DashboardPartialFinancialPresentationResultV1,
} from "./dashboardPartialFinancialPresentation";

export const DASHBOARD_PARTIAL_FINANCIAL_QUERY_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: false,
});

// A response is produced after the client captures its request clock. Permit a
// bounded network/server round trip while still rejecting materially future
// snapshots and clock-forgery drift.
export const DASHBOARD_RESPONSE_CLOCK_SKEW_SECONDS_V1 = 30;

export interface DashboardPartialFinancialQueryTransportRequestV1 {
  scope: ReportScope;
  range: DashboardLocalDateRangeV1;
}

type PresentPartialFinancialV1 = typeof presentDashboardPartialFinancialV1;

export interface DashboardPartialFinancialQueryTaskDependenciesV1 {
  transport: (request: DashboardPartialFinancialQueryTransportRequestV1) => Promise<unknown>;
  present?: PresentPartialFinancialV1;
  config?: {
    enabled: boolean;
  };
}

export interface DashboardPartialFinancialQueryTaskInputV1 {
  requestId: string;
  scope: ReportScope;
  range: DashboardLocalDateRangeV1;
  nowEpochSeconds: number;
}

export type DashboardPartialFinancialQueryResultV1 =
  | {
      kind: "ready";
      requestId: string;
      context: DashboardPartialFinancialRuntimeHttpBodyV1["context"];
      response: DashboardPartialFinancialRuntimeHttpBodyV1;
      presentation: Extract<
        DashboardPartialFinancialPresentationResultV1,
        { enabled: true }
      >;
    }
  | {
      kind: "failed";
      requestId: string;
      message: "Không thể tải tổng quan tài chính";
    };

export type DashboardPartialFinancialQueryTaskV1 =
  | { enabled: false; status: "disabled" }
  | {
      enabled: true;
      requestKey: string;
      request: DashboardPartialFinancialQueryTransportRequestV1;
      execute: () => Promise<DashboardPartialFinancialQueryResultV1>;
    };

export class DashboardPartialFinancialQueryTaskErrorV1 extends Error {
  readonly code = "dashboard_partial_financial_query_invalid";

  constructor(message: string) {
    super(message);
    this.name = "DashboardPartialFinancialQueryTaskErrorV1";
  }
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new DashboardPartialFinancialQueryTaskErrorV1(`${field} is invalid`);
  }
  return value;
}

function normalizedScope(input: unknown): ReportScope {
  const parsed = ReportScopeSchema.safeParse(input);
  if (!parsed.success || new Set(parsed.data.storeIds).size !== parsed.data.storeIds.length) {
    throw new DashboardPartialFinancialQueryTaskErrorV1("report scope is invalid");
  }
  return {
    scopeKind: "report",
    merchantId: parsed.data.merchantId,
    storeIds: [...parsed.data.storeIds].sort(),
  };
}

function normalizedRange(input: unknown): DashboardLocalDateRangeV1 {
  const parsed = DashboardLocalDateRangeV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new DashboardPartialFinancialQueryTaskErrorV1("local-date range is invalid");
  }
  return parsed.data;
}

function normalizedClock(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new DashboardPartialFinancialQueryTaskErrorV1("query clock is invalid");
  }
  return Number(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function responseMatchesRequest(
  response: DashboardPartialFinancialRuntimeHttpBodyV1,
  request: DashboardPartialFinancialQueryTransportRequestV1,
  nowEpochSeconds: number,
): boolean {
  const responseScope = response.context.normalizedScope;
  const responseRange = response.context.localDateRange;
  return responseScope.merchantId === request.scope.merchantId
    && sameStrings(responseScope.storeIds, request.scope.storeIds)
    && responseRange.from === request.range.from
    && responseRange.to === request.range.to
    && responseRange.inclusiveDays === request.range.inclusiveDays
    && Date.parse(response.context.reportAsOf)
      <= (nowEpochSeconds + DASHBOARD_RESPONSE_CLOCK_SKEW_SECONDS_V1) * 1_000;
}

function failed(requestId: string): DashboardPartialFinancialQueryResultV1 {
  return {
    kind: "failed",
    requestId,
    message: "Không thể tải tổng quan tài chính",
  };
}

export function createDashboardPartialFinancialQueryTaskV1(
  dependencies: DashboardPartialFinancialQueryTaskDependenciesV1,
  input: DashboardPartialFinancialQueryTaskInputV1,
): DashboardPartialFinancialQueryTaskV1 {
  if (dependencies.config?.enabled !== true) {
    return { enabled: false, status: "disabled" };
  }
  if (typeof dependencies.transport !== "function") {
    throw new DashboardPartialFinancialQueryTaskErrorV1("query transport is unavailable");
  }
  const requestId = requiredToken(input.requestId, "requestId");
  const scope = normalizedScope(input.scope);
  const range = normalizedRange(input.range);
  const nowEpochSeconds = normalizedClock(input.nowEpochSeconds);
  const request = { scope, range };
  const requestKey = `dashboard.partial-financial.v1:${JSON.stringify({
    merchantId: scope.merchantId,
    storeIds: scope.storeIds,
    range,
  })}`;
  const present = dependencies.present ?? presentDashboardPartialFinancialV1;

  return {
    enabled: true,
    requestKey,
    request,
    execute: async () => {
      try {
        const raw = await dependencies.transport(request);
        const parsed = DashboardPartialFinancialRuntimeHttpBodyV1Schema.safeParse(raw);
        if (!parsed.success || !responseMatchesRequest(parsed.data, request, nowEpochSeconds)) {
          return failed(requestId);
        }
        const presentation = present(
          parsed.data.data,
          parsed.data.factorBinding,
          { enabled: true },
        );
        if (!presentation.enabled) return failed(requestId);
        return {
          kind: "ready",
          requestId,
          context: parsed.data.context,
          response: parsed.data,
          presentation,
        };
      } catch {
        return failed(requestId);
      }
    },
  };
}
