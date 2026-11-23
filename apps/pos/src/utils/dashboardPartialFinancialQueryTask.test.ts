import { describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_METRIC_TIME_BASIS_V2,
  DashboardPartialFinancialModelV1Schema,
} from "@medusa-snus/contracts";
import {
  DASHBOARD_PARTIAL_FINANCIAL_QUERY_DEFAULT_CONFIG_V1,
  DASHBOARD_RESPONSE_CLOCK_SKEW_SECONDS_V1,
  DashboardPartialFinancialQueryTaskErrorV1,
  createDashboardPartialFinancialQueryTaskV1,
} from "./dashboardPartialFinancialQueryTask";
import { createDashboardMetricRuntimeBindingV1 } from "../../../../packages/application/src/services/dashboard-factor-runtime-binding";

const scope = {
  scopeKind: "report" as const,
  merchantId: "merchant-a",
  storeIds: ["store-b", "store-a"],
};
const range = {
  from: "2026-08-05",
  to: "2026-08-05",
  inclusiveDays: 1,
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

function response() {
  const value = {
    schemaVersion: 1 as const,
    contract: "dashboard.partial-financial.v1" as const,
    context: {
      schemaVersion: 1 as const,
      normalizedScope: {
        scopeKind: "report" as const,
        merchantId: "merchant-a",
        storeIds: ["store-a", "store-b"],
      },
      localDateRange: range,
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
    },
    data: {
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
    },
  };
  return {
    ...value,
    factorBinding: createDashboardMetricRuntimeBindingV1(
      { reportAsOf: value.context.reportAsOf },
      DashboardPartialFinancialModelV1Schema.parse(value.data),
    ),
  };
}

const input = {
  requestId: "dashboard-request-1",
  scope,
  range,
  nowEpochSeconds: 1_786_000_000,
};

describe("DASH-04 runtime-bound query/presentation task", () => {
  it("is frozen default-off before input validation and transport", async () => {
    expect(DASHBOARD_PARTIAL_FINANCIAL_QUERY_DEFAULT_CONFIG_V1).toEqual({ enabled: false });
    expect(Object.isFrozen(DASHBOARD_PARTIAL_FINANCIAL_QUERY_DEFAULT_CONFIG_V1)).toBe(true);
    const transport = vi.fn();
    const task = createDashboardPartialFinancialQueryTaskV1({ transport }, {
      ...input,
      requestId: "",
    });

    expect(task).toEqual({ enabled: false, status: "disabled" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("normalizes selection into a deterministic task and truthful presentation", async () => {
    const transport = vi.fn().mockResolvedValue(response());
    const task = createDashboardPartialFinancialQueryTaskV1(
      { transport, config: { enabled: true } },
      input,
    );
    if (!task.enabled) throw new Error("expected enabled task");

    expect(task.requestKey).toBe(
      "dashboard.partial-financial.v1:{\"merchantId\":\"merchant-a\",\"storeIds\":[\"store-a\",\"store-b\"],\"range\":{\"from\":\"2026-08-05\",\"to\":\"2026-08-05\",\"inclusiveDays\":1}}",
    );
    expect(task.request).toEqual({
      scope: {
        scopeKind: "report",
        merchantId: "merchant-a",
        storeIds: ["store-a", "store-b"],
      },
      range,
    });
    await expect(task.execute()).resolves.toMatchObject({
      kind: "ready",
      requestId: "dashboard-request-1",
      context: { reportAsOf: "2026-08-05T12:00:00.000Z" },
      presentation: {
        enabled: true,
        currencies: [{
          headlines: [{ valueMinor: 420_000 }, { valueMinor: 253_000 }],
          collectionBreakdown: [
            { key: "vat_total", valueMinor: 23_000 },
            { key: "vat_included", valueMinor: 11_000 },
            { key: "vat_added", valueMinor: 12_000 },
            { key: "shipping", valueMinor: 31_000 },
            { key: "other", valueMinor: 0 },
          ],
        }],
      },
    });
    expect(transport).toHaveBeenCalledWith(task.request);
  });

  it("accepts a response produced just after the request clock but keeps the future bound strict", async () => {
    const requestClock = Math.floor(Date.parse(response().context.reportAsOf) / 1_000) - 1;
    const task = createDashboardPartialFinancialQueryTaskV1({
      transport: vi.fn().mockResolvedValue(response()),
      config: { enabled: true },
    }, { ...input, nowEpochSeconds: requestClock });
    if (!task.enabled) throw new Error("expected enabled task");
    await expect(task.execute()).resolves.toMatchObject({ kind: "ready" });
    expect(DASHBOARD_RESPONSE_CLOCK_SKEW_SECONDS_V1).toBe(30);
  });

  it("rejects invalid request identity, scope, range and clock before transport", () => {
    const transport = vi.fn();
    const invalidInputs = [
      { ...input, requestId: " dashboard-request-1" },
      { ...input, scope: { ...scope, storeIds: ["store-a", "store-a"] } },
      { ...input, range: { ...range, inclusiveDays: 2 } },
      { ...input, nowEpochSeconds: -1 },
    ];
    for (const invalid of invalidInputs) {
      expect(() => createDashboardPartialFinancialQueryTaskV1(
        { transport, config: { enabled: true } },
        invalid,
      )).toThrow(DashboardPartialFinancialQueryTaskErrorV1);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails closed for cross-scope, range, future-clock and model drift", async () => {
    const forgedResponses = [
      {
        ...response(),
        context: {
          ...response().context,
          normalizedScope: { ...response().context.normalizedScope, merchantId: "merchant-b" },
        },
      },
      {
        ...response(),
        context: {
          ...response().context,
          localDateRange: { ...range, from: "2026-08-04" },
        },
      },
      {
        ...response(),
        context: {
          ...response().context,
          reportAsOf: "2027-08-05T12:00:00.000Z",
          generatedAt: "2027-08-05T12:00:00.250Z",
          freshness: {
            databaseSnapshot: {
              status: "fresh" as const,
              asOf: "2027-08-05T12:00:00.000Z",
            },
          },
        },
      },
      {
        ...response(),
        data: { ...response().data, aggregateReadSource: "app.payment_entries" },
      },
      (() => {
        const missingBinding = response() as Record<string, unknown>;
        delete missingBinding.factorBinding;
        return missingBinding;
      })(),
      {
        ...response(),
        factorBinding: {
          ...response().factorBinding,
          reportAsOf: "2026-08-05T12:00:01.000Z",
        },
      },
    ];
    for (const forged of forgedResponses) {
      const task = createDashboardPartialFinancialQueryTaskV1({
        transport: vi.fn().mockResolvedValue(forged),
        config: { enabled: true },
      }, input);
      if (!task.enabled) throw new Error("expected enabled task");
      await expect(task.execute()).resolves.toEqual({
        kind: "failed",
        requestId: "dashboard-request-1",
        message: "Không thể tải tổng quan tài chính",
      });
    }
  });

  it("sanitizes transport and presentation failures", async () => {
    const transportFailure = createDashboardPartialFinancialQueryTaskV1({
      transport: vi.fn().mockRejectedValue(new Error("merchant-b secret")),
      config: { enabled: true },
    }, input);
    if (!transportFailure.enabled) throw new Error("expected enabled task");
    await expect(transportFailure.execute()).resolves.toEqual({
      kind: "failed",
      requestId: "dashboard-request-1",
      message: "Không thể tải tổng quan tài chính",
    });

    const presenterFailure = createDashboardPartialFinancialQueryTaskV1({
      transport: vi.fn().mockResolvedValue(response()),
      present: vi.fn(() => { throw new Error("presentation secret"); }),
      config: { enabled: true },
    }, input);
    if (!presenterFailure.enabled) throw new Error("expected enabled task");
    await expect(presenterFailure.execute()).resolves.toEqual({
      kind: "failed",
      requestId: "dashboard-request-1",
      message: "Không thể tải tổng quan tài chính",
    });
  });
});
