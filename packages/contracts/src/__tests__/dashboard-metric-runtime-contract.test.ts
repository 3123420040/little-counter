import { describe, expect, it } from "vitest";
import {
  DASHBOARD_VISIBLE_FACTOR_IDS_V1,
  DASHBOARD_METRIC_TIME_BASIS_V2,
} from "../order-financial-correctness";
import {
  DashboardMetricRuntimeBindingV1Schema,
  DashboardPartialFinancialRuntimeHttpBodyV1Schema,
} from "../dashboard-metric-runtime";

function factor(factorId: (typeof DASHBOARD_VISIBLE_FACTOR_IDS_V1)[number]) {
  return {
    factorId,
    currentVisible: true as const,
    currentLabelsVi: [factorId],
    targetMetricIds: [factorId],
    unavailableTargetMetricIds: [],
    factorKind: "card" as const,
    targetSources: ["report_context"] as const,
    formula: "Use the exact canonical runtime response dependency for this factor.",
    targetScope: "selected_report_stores" as const,
    timeBasis: ["snapshot_as_of"] as const,
    currencyBehavior: "not_monetary" as const,
    reportAsOfRequired: true as const,
    freshnessBehavior: "Use the serialized reportAsOf and database snapshot freshness.",
    dataQualityBehavior: "Remain explicitly unavailable until the exact dependency is attached.",
    implementationState: "not_implemented" as const,
    activationStatus: "runtime_bound" as const,
    activationDependencies: [],
    legacyFallback: "forbidden" as const,
    runtimeDependency: "unattached" as const,
    runtimeStatus: "unavailable" as const,
    runtimeDataQualityStatus: "unavailable" as const,
    runtimeReason: "The same-scope canonical dependency is not attached.",
  };
}

function binding() {
  return {
    schemaVersion: 1 as const,
    contract: "dashboard.metric-runtime-binding.v1" as const,
    registrySchemaVersion: 2 as const,
    registryStatus: "runtime_bound_partial_v1" as const,
    reportAsOf: "2026-08-17T06:00:00.000Z",
    availableCount: 0,
    unavailableCount: 27,
    factors: DASHBOARD_VISIBLE_FACTOR_IDS_V1.map(factor),
  };
}

function body() {
  return {
    schemaVersion: 1 as const,
    contract: "dashboard.partial-financial.v1" as const,
    context: {
      schemaVersion: 1 as const,
      normalizedScope: {
        scopeKind: "report" as const,
        merchantId: "merchant-a",
        storeIds: ["store-a"],
      },
      localDateRange: {
        from: "2026-08-17",
        to: "2026-08-17",
        inclusiveDays: 1,
      },
      storeTimeWindows: [{
        storeId: "store-a",
        timeZone: "Asia/Ho_Chi_Minh",
        startInclusive: "2026-08-16T17:00:00.000Z",
        endExclusive: "2026-08-17T17:00:00.000Z",
      }],
      reportAsOf: "2026-08-17T06:00:00.000Z",
      generatedAt: "2026-08-17T06:00:00.250Z",
      metricTimeBasis: DASHBOARD_METRIC_TIME_BASIS_V2,
      freshness: {
        databaseSnapshot: {
          status: "fresh" as const,
          asOf: "2026-08-17T06:00:00.000Z",
        },
      },
    },
    data: {
      schemaVersion: 1 as const,
      completeness: "complete_payment_payable_v1" as const,
      aggregateReadSource: "app.payment_events" as const,
      currencies: [],
    },
    factorBinding: binding(),
  };
}

describe("DASH-04 versioned runtime registry contract", () => {
  it("requires exactly the 27 sorted factors with full metadata and explicit states", () => {
    const parsed = DashboardMetricRuntimeBindingV1Schema.parse(binding());
    expect(parsed.factors.map((entry) => entry.factorId))
      .toEqual(DASHBOARD_VISIBLE_FACTOR_IDS_V1);
    expect(parsed.availableCount + parsed.unavailableCount).toBe(27);
    expect(parsed.factors[0]).toMatchObject({
      activationStatus: "runtime_bound",
      legacyFallback: "forbidden",
      runtimeDependency: "unattached",
      runtimeStatus: "unavailable",
      targetSources: ["report_context"],
      targetScope: "selected_report_stores",
      timeBasis: ["snapshot_as_of"],
      currencyBehavior: "not_monetary",
    });
    expect(parsed.factors[0]!.formula.length).toBeGreaterThan(20);
    expect(parsed.factors[0]!.freshnessBehavior.length).toBeGreaterThan(20);
    expect(parsed.factors[0]!.dataQualityBehavior.length).toBeGreaterThan(20);
  });

  it("rejects missing, duplicate, count-drifted and internally inconsistent states", () => {
    const missing = binding();
    missing.factors = missing.factors.slice(1);
    missing.unavailableCount = 26;
    expect(DashboardMetricRuntimeBindingV1Schema.safeParse(missing).success).toBe(false);

    const duplicate = binding();
    duplicate.factors[1] = structuredClone(duplicate.factors[0]!);
    expect(DashboardMetricRuntimeBindingV1Schema.safeParse(duplicate).success).toBe(false);

    const countDrift = binding();
    countDrift.availableCount = 1;
    expect(DashboardMetricRuntimeBindingV1Schema.safeParse(countDrift).success).toBe(false);

    const falseAvailable = binding();
    falseAvailable.factors[0]!.runtimeStatus = "available" as never;
    expect(DashboardMetricRuntimeBindingV1Schema.safeParse(falseAvailable).success).toBe(false);

    const attachedWithStaleImplementation = binding();
    Object.assign(attachedWithStaleImplementation.factors[0]!, {
      runtimeDependency: "report_context",
      runtimeStatus: "available",
      runtimeDataQualityStatus: "complete",
      runtimeReason: "Exact canonical report context is attached.",
    });
    attachedWithStaleImplementation.availableCount = 1;
    attachedWithStaleImplementation.unavailableCount = 26;
    expect(
      DashboardMetricRuntimeBindingV1Schema.safeParse(
        attachedWithStaleImplementation,
      ).success,
    ).toBe(false);

    attachedWithStaleImplementation.factors[0]!.implementationState =
      "runtime_bound";
    expect(
      DashboardMetricRuntimeBindingV1Schema.safeParse(
        attachedWithStaleImplementation,
      ).success,
    ).toBe(true);

    const unattachedWithRuntimeImplementation = binding();
    unattachedWithRuntimeImplementation.factors[0]!.implementationState =
      "runtime_bound";
    expect(
      DashboardMetricRuntimeBindingV1Schema.safeParse(
        unattachedWithRuntimeImplementation,
      ).success,
    ).toBe(false);
  });

  it("binds the nested registry clock to the canonical report clock", () => {
    expect(DashboardPartialFinancialRuntimeHttpBodyV1Schema.parse(body()).factorBinding)
      .toMatchObject({
        contract: "dashboard.metric-runtime-binding.v1",
        reportAsOf: "2026-08-17T06:00:00.000Z",
      });
    const drift = body();
    drift.factorBinding.reportAsOf = "2026-08-17T06:00:01.000Z";
    expect(DashboardPartialFinancialRuntimeHttpBodyV1Schema.safeParse(drift).success)
      .toBe(false);
  });
});
