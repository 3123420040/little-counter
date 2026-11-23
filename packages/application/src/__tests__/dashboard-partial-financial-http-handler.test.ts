import { describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_METRIC_TIME_BASIS_V2,
  permissions,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import {
  DASHBOARD_PARTIAL_FINANCIAL_HTTP_DEFAULT_CONFIG_V1,
  handleDashboardPartialFinancialHttpV1,
  type DashboardPartialFinancialHttpHandlerDependenciesV1,
} from "../services/dashboard-partial-financial-http-handler";

const scope = {
  scopeKind: "report" as const,
  merchantId: "merchant-a",
  storeIds: ["store-b", "store-a"],
};

const context = {
  schemaVersion: 1 as const,
  normalizedScope: {
    scopeKind: "report" as const,
    merchantId: "merchant-a",
    storeIds: ["store-a", "store-b"],
  },
  localDateRange: {
    from: "2026-08-05",
    to: "2026-08-05",
    inclusiveDays: 1,
  },
  storeTimeWindows: [{
    storeId: "store-a",
    timeZone: "Asia/Ho_Chi_Minh",
    startInclusive: "2026-08-04T17:00:00.000Z",
    endExclusive: "2026-08-05T17:00:00.000Z",
  }, {
    storeId: "store-b",
    timeZone: "UTC",
    startInclusive: "2026-08-05T00:00:00.000Z",
    endExclusive: "2026-08-06T00:00:00.000Z",
  }],
  reportAsOf: "2026-08-05T12:00:00.000Z",
  generatedAt: "2026-08-05T12:00:00.250Z",
  metricTimeBasis: DASHBOARD_METRIC_TIME_BASIS_V2,
  freshness: {
    databaseSnapshot: {
      status: "fresh" as const,
      asOf: "2026-08-05T12:00:00.000Z",
    },
  },
};

const unavailableMetrics = [
  "refundsMinor",
  "reversalsMinor",
  "chargebacksMinor",
  "negativeCollectionsMinor",
  "netCollectionsMinor",
  "commercialOutstandingAsOfMinor",
  "customerRefundPayableAsOfMinor",
  "revenueExcludingVatMinor",
  "vatLiabilityMinor",
  "cogsRecognizedMinor",
  "providerFeesMinor",
  "netProviderPayoutMinor",
] as const;

const data = {
  schemaVersion: 1 as const,
  completeness: "partial_dec_01_029_blocked" as const,
  aggregateReadSource: "app.payment_events" as const,
  currencies: [{
    currencyCode: "VND",
    minorUnitExponent: 0,
    currentOrder: {
      validOrderCount: 2,
      currentOrderGrossValueMinor: 420_000,
      currentVatMinor: 41_000,
      currentUnclassifiedMinor: 1_000,
      dataQualityStatus: "complete" as const,
    },
    recordedCollection: {
      status: "available" as const,
      postedChargeEventCount: 2,
      recordedGrossCollectionsMinor: 253_000,
      components: {
        taxModes: ["exclusive", "inclusive"] as const,
        merchandiseGrossMinor: 210_000,
        discountMinor: 0,
        merchandiseNetMinor: 210_000,
        shippingMinor: 31_000,
        merchandiseVatMinor: 20_000,
        shippingVatMinor: 3_000,
        vatMinor: 23_000,
        vatIncludedInPriceMinor: 11_000,
        vatAddedToPriceMinor: 12_000,
        unclassifiedMinor: 0,
        totalMinor: 253_000,
      },
    },
    recordedCollectionMinusCurrentOrderValueMinor: -167_000,
    unavailableMetrics: [...unavailableMetrics],
  }],
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    authorization: {
      permission: permissions.reportsRead,
      scope,
    },
    range: { date: "2026-08-05" },
    ...overrides,
  };
}

function dependencies(enabled = true) {
  const client = { query: vi.fn() } as unknown as PoolClient;
  const readSnapshot = vi.fn(async () => ({
    enabled: true as const,
    snapshot: { context, data },
  }));
  const value: DashboardPartialFinancialHttpHandlerDependenciesV1 = {
    client,
    readSnapshot,
    config: { enabled, statementTimeoutMs: 5_000 },
  };
  return { client, readSnapshot, value };
}

describe("DASH-PARTIAL-HTTP-01 default-off application handler", () => {
  it("is frozen default-off and never invokes its reader", async () => {
    expect(DASHBOARD_PARTIAL_FINANCIAL_HTTP_DEFAULT_CONFIG_V1).toEqual({
      enabled: false,
      statementTimeoutMs: 5_000,
    });
    expect(Object.isFrozen(DASHBOARD_PARTIAL_FINANCIAL_HTTP_DEFAULT_CONFIG_V1)).toBe(true);
    const { client, readSnapshot } = dependencies();
    const value: DashboardPartialFinancialHttpHandlerDependenciesV1 = { client, readSnapshot };

    await expect(handleDashboardPartialFinancialHttpV1(value, request()))
      .rejects.toMatchObject({ code: "feature_disabled", statusCode: 403 });
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it("requires exact reports:read permission before reader access", async () => {
    const { readSnapshot, value } = dependencies();
    const invalid = request();
    invalid.authorization.permission = permissions.ordersRead as never;

    await expect(handleDashboardPartialFinancialHttpV1(value, invalid))
      .rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it("rejects duplicate scope, malformed range and unsafe timeout before reading", async () => {
    const duplicate = dependencies();
    await expect(handleDashboardPartialFinancialHttpV1(duplicate.value, request({
      authorization: {
        permission: permissions.reportsRead,
        scope: { ...scope, storeIds: ["store-a", "store-a"] },
      },
    }))).rejects.toMatchObject({ code: "scope_required", statusCode: 409 });
    expect(duplicate.readSnapshot).not.toHaveBeenCalled();

    const malformed = dependencies();
    await expect(handleDashboardPartialFinancialHttpV1(malformed.value, request({
      range: { date: "2026-02-30" },
    }))).rejects.toMatchObject({ code: "dashboard_range_invalid", statusCode: 400 });
    expect(malformed.readSnapshot).not.toHaveBeenCalled();

    const unsafeTimeout = dependencies();
    unsafeTimeout.value.config = { enabled: true, statementTimeoutMs: 30_001 };
    await expect(handleDashboardPartialFinancialHttpV1(unsafeTimeout.value, request()))
      .rejects.toMatchObject({ code: "feature_unavailable", statusCode: 503 });
    expect(unsafeTimeout.readSnapshot).not.toHaveBeenCalled();
  });

  it("passes normalized authorized scope, date range and bounded timeout to one reader", async () => {
    const { readSnapshot, value } = dependencies();
    await handleDashboardPartialFinancialHttpV1(value, request());

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(readSnapshot.mock.calls[0]![1]).toEqual({
      scope: {
        scopeKind: "report",
        merchantId: "merchant-a",
        storeIds: ["store-a", "store-b"],
      },
      range: { from: "2026-08-05", to: "2026-08-05" },
      statementTimeoutMs: 5_000,
      storeStatusPolicy: "active_or_suspended",
    });
    expect(readSnapshot.mock.calls[0]![2]).toEqual({ enabled: true });
  });

  it("returns only a no-store partial contract with exact collection semantics", async () => {
    const { value } = dependencies();
    const response = await handleDashboardPartialFinancialHttpV1(value, request());

    expect(response).toMatchObject({
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Dashboard-Contract": "dashboard.partial-financial.v1",
        "X-Dashboard-Completeness": "partial_dec_01_029_blocked",
        "X-Dashboard-Aggregate-Source": "app.payment_events",
        "X-Dashboard-Report-As-Of": "2026-08-05T12:00:00.000Z",
        "X-Dashboard-Generated-At": "2026-08-05T12:00:00.250Z",
        "X-Dashboard-Currency-Count": "1",
        "X-Dashboard-Factor-Count": "27",
        "X-Dashboard-Factor-Available": "2",
        "X-Dashboard-Factor-Registry": "runtime_bound_partial_v1",
      },
      body: {
        schemaVersion: 1,
        contract: "dashboard.partial-financial.v1",
        context,
        data: {
          completeness: "partial_dec_01_029_blocked",
          aggregateReadSource: "app.payment_events",
          currencies: [{
            currentOrder: { currentOrderGrossValueMinor: 420_000 },
            recordedCollection: { recordedGrossCollectionsMinor: 253_000 },
          }],
        },
        factorBinding: {
          schemaVersion: 1,
          contract: "dashboard.metric-runtime-binding.v1",
          registrySchemaVersion: 2,
          registryStatus: "runtime_bound_partial_v1",
          reportAsOf: context.reportAsOf,
          availableCount: 2,
          unavailableCount: 25,
          factors: expect.arrayContaining([
            expect.objectContaining({
              factorId: "dashboard_freshness_state",
              runtimeStatus: "available",
              targetSources: ["report_context"],
            }),
            expect.objectContaining({
              factorId: "payment_method_amount",
              runtimeStatus: "unavailable",
              runtimeDependency: "payment_method_snapshot",
            }),
          ]),
        },
      },
    });
  });

  it("fails closed when the reader is disabled or returns scope/range/model drift", async () => {
    const disabled = dependencies();
    disabled.value.readSnapshot = vi.fn(async () => ({
      enabled: false as const,
      status: "disabled" as const,
    }));
    await expect(handleDashboardPartialFinancialHttpV1(disabled.value, request()))
      .rejects.toMatchObject({ code: "feature_unavailable", statusCode: 503 });

    for (const snapshot of [
      { context: { ...context, normalizedScope: { ...context.normalizedScope, merchantId: "merchant-b" } }, data },
      { context: { ...context, localDateRange: { ...context.localDateRange, from: "2026-08-04" } }, data },
      { context, data: { ...data, aggregateReadSource: "app.payment_entries" } },
      { context, data: { ...data, completeness: "complete_payment_payable_v1" } },
      {
        context,
        data: {
          ...data,
          currencies: [{
            ...data.currencies[0]!,
            currentOrder: {
              ...data.currencies[0]!.currentOrder,
              currentVatMinor: 420_000,
              currentUnclassifiedMinor: 1,
            },
          }],
        },
      },
      {
        context,
        data: {
          ...data,
          currencies: [{
            ...data.currencies[0]!,
            currentOrder: {
              ...data.currencies[0]!.currentOrder,
              validOrderCount: 0,
            },
          }],
        },
      },
    ]) {
      const drift = dependencies();
      drift.value.readSnapshot = vi.fn(async () => ({
        enabled: true as const,
        snapshot: snapshot as never,
      }));
      await expect(handleDashboardPartialFinancialHttpV1(drift.value, request()))
        .rejects.toMatchObject({
          code: "dashboard_response_invalid",
          statusCode: 502,
        });
    }
  });
});
