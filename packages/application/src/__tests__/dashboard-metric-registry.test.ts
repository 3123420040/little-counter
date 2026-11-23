import { describe, expect, it } from "vitest";
import {
  DASHBOARD_VISIBLE_FACTOR_IDS_V1,
  DashboardMetricRegistryV1Schema,
} from "@medusa-snus/contracts";
import { DASHBOARD_METRIC_REGISTRY_V1 } from "../services/dashboard-metric-registry";

describe("DASH-REGISTRY-01 inactive complete dashboard factor registry", () => {
  it("covers every one of the 27 source-audited visible factors exactly once", () => {
    const parsed = DashboardMetricRegistryV1Schema.parse(DASHBOARD_METRIC_REGISTRY_V1);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.factors.map((factor) => factor.factorId)).toEqual(
      DASHBOARD_VISIBLE_FACTOR_IDS_V1,
    );
    expect(new Set(parsed.factors.map((factor) => factor.factorId)).size).toBe(27);
  });

  it("keeps every registry factor inactive and forbids a silent legacy or zero fallback", () => {
    const parsed = DashboardMetricRegistryV1Schema.parse(DASHBOARD_METRIC_REGISTRY_V1);
    for (const factor of parsed.factors) {
      expect(factor.activationStatus).toBe("inactive");
      expect(factor.legacyFallback).toBe("forbidden");
      expect(factor.formula.length).toBeGreaterThan(20);
      expect(factor.dataQualityBehavior.length).toBeGreaterThan(20);
      if (factor.implementationState === "blocked_dependency") {
        expect(factor.activationDependencies.length).toBeGreaterThan(0);
      }
    }
  });

  it("splits the ambiguous revenue card into current order value and actual recorded inflow", () => {
    const factor = DASHBOARD_METRIC_REGISTRY_V1.factors.find(
      (entry) => entry.factorId === "current_order_value_and_recorded_collection",
    );
    expect(factor).toMatchObject({
      currentLabelsVi: ["Tổng doanh thu"],
      targetMetricIds: ["current_order_gross_value", "recorded_gross_collections"],
      currencyBehavior: "independent_currency_blocks",
      implementationState: "local_partial_model_unwired",
      activationStatus: "inactive",
    });
    expect(factor?.unavailableTargetMetricIds).toEqual([
      "chargebacks",
      "cogs_recognized",
      "commercial_outstanding_as_of",
      "customer_refund_payable_as_of",
      "negative_collections",
      "net_collections",
      "net_provider_payout",
      "provider_fees",
      "refunds",
      "revenue_excluding_vat",
      "reversals",
      "vat_liability",
    ]);
    expect(factor?.formula).toContain("app.payment_events");
    expect(factor?.formula).toContain("VAT");
    expect(factor?.formula).toContain("unclassified");
    expect(factor?.formula).not.toContain("payment_entries");
  });

  it("does not present accounting, refunds, payable, or provider payout as numeric zero", () => {
    const profit = DASHBOARD_METRIC_REGISTRY_V1.factors.find(
      (entry) => entry.factorId === "current_gross_profit",
    );
    expect(profit).toMatchObject({
      implementationState: "blocked_dependency",
      targetMetricIds: ["cogs_recognized", "gross_profit", "revenue_excluding_vat"],
    });
    expect(profit?.activationDependencies).toEqual(expect.arrayContaining([
      "ACCT-02",
      "DB-029",
      "DEC-01-independent-accounting-approval",
    ]));

    const financial = DASHBOARD_METRIC_REGISTRY_V1.factors.find(
      (entry) => entry.factorId === "current_order_value_and_recorded_collection",
    );
    expect(financial?.dataQualityBehavior).toContain("unavailable");
    expect(financial?.dataQualityBehavior).not.toContain("default zero");
  });

  it("declares target scope and clock for operational and event-based factors", () => {
    const paymentAmount = DASHBOARD_METRIC_REGISTRY_V1.factors.find(
      (entry) => entry.factorId === "payment_method_amount",
    );
    expect(paymentAmount).toMatchObject({
      targetScope: "selected_report_stores",
      timeBasis: ["payment_event_at"],
      currencyBehavior: "independent_currency_blocks",
      implementationState: "not_implemented",
    });

    for (const factorId of ["low_stock_count", "out_of_stock_count"] as const) {
      expect(DASHBOARD_METRIC_REGISTRY_V1.factors.find(
        (entry) => entry.factorId === factorId,
      )).toMatchObject({
        targetScope: "selected_report_stores",
        timeBasis: ["snapshot_as_of"],
        implementationState: "not_implemented",
      });
    }
  });

  it("is runtime-validated, deeply frozen, and rejects malformed registry mutations", () => {
    expect(Object.isFrozen(DASHBOARD_METRIC_REGISTRY_V1)).toBe(true);
    expect(Object.isFrozen(DASHBOARD_METRIC_REGISTRY_V1.factors)).toBe(true);
    expect(Object.isFrozen(DASHBOARD_METRIC_REGISTRY_V1.factors[0])).toBe(true);
    expect(Object.isFrozen(DASHBOARD_METRIC_REGISTRY_V1.factors[0]?.targetMetricIds)).toBe(true);

    const malformed = structuredClone(DASHBOARD_METRIC_REGISTRY_V1);
    const first = malformed.factors[0]!;
    first.targetMetricIds = [first.targetMetricIds[0]!, first.targetMetricIds[0]!];
    expect(DashboardMetricRegistryV1Schema.safeParse(malformed).success).toBe(false);

    const unguardedBlock = structuredClone(DASHBOARD_METRIC_REGISTRY_V1);
    const blocked = unguardedBlock.factors.find(
      (entry) => entry.implementationState === "blocked_dependency",
    )!;
    blocked.activationDependencies = [];
    expect(DashboardMetricRegistryV1Schema.safeParse(unguardedBlock).success).toBe(false);

    const overlap = structuredClone(DASHBOARD_METRIC_REGISTRY_V1);
    overlap.factors[0]!.unavailableTargetMetricIds = [
      overlap.factors[0]!.targetMetricIds[0]!,
    ];
    expect(DashboardMetricRegistryV1Schema.safeParse(overlap).success).toBe(false);
  });
});
