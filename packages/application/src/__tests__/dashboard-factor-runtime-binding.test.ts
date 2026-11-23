import { describe, expect, it } from "vitest";
import { DASHBOARD_VISIBLE_FACTOR_IDS_V1 } from "@medusa-snus/contracts";
import {
  DASHBOARD_METRIC_RUNTIME_REGISTRY_V2,
  createDashboardMetricRuntimeBindingV1,
} from "../services/dashboard-factor-runtime-binding";

const context = {
  reportAsOf: "2026-08-17T06:00:00.000Z",
};

const model = {
  schemaVersion: 1 as const,
  completeness: "complete_payment_payable_v1" as const,
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
      commercialMetrics: {
        cancelledOrderCohortCount: 1,
        activeOrdersWithShippingCount: 1,
        currentMerchandiseGrossValueMinor: 400_000,
        currentDiscountMinor: 10_000,
        currentMerchandiseRevenueExVatMinor: 360_000,
        currentShippingRevenueExVatMinor: 18_000,
        currentShippingGrossValueMinor: 20_000,
        currentShippingSharePercent: 4.8,
        effectiveItemQuantity: 3,
        averageCurrentOrderValueMinor: 210_000,
        currentCogsMinor: null,
        currentMerchandiseGrossProfitMinor: null,
        currentContributionBeforeShippingCostMinor: null,
        topProducts: [],
      },
    },
    recordedCollection: {
      status: "none_in_selected_window" as const,
      postedChargeEventCount: 0 as const,
      recordedGrossCollectionsMinor: 0 as const,
      components: null,
    },
    paymentFlow: {
      postedRefundEventCount: 0,
      postedReversalEventCount: 0,
      postedChargebackEventCount: 0,
      refundsMinor: 0,
      reversalsMinor: 0,
      chargebacksMinor: 0,
      negativeCollectionsMinor: 0,
      netCollectionsMinor: 0,
      customerRefundPayableAsOfMinor: 0,
      methods: [],
    },
    recordedCollectionMinusCurrentOrderValueMinor: -420_000,
    unavailableMetrics: [
      "commercialOutstandingAsOfMinor",
      "revenueExcludingVatMinor",
      "vatLiabilityMinor",
      "cogsRecognizedMinor",
      "providerFeesMinor",
      "netProviderPayoutMinor",
    ] as const,
  }],
};

describe("DASH-04 server-produced factor runtime binding", () => {
  it("binds every registry entry to one declared response dependency", () => {
    expect(DASHBOARD_METRIC_RUNTIME_REGISTRY_V2).toMatchObject({
      schemaVersion: 2,
      registryStatus: "runtime_bound_partial_v1",
    });
    expect(DASHBOARD_METRIC_RUNTIME_REGISTRY_V2.factors.map((factor) => factor.factorId))
      .toEqual(DASHBOARD_VISIBLE_FACTOR_IDS_V1);
    expect(DASHBOARD_METRIC_RUNTIME_REGISTRY_V2.factors.every(
      (factor) => factor.activationStatus === "runtime_bound",
    )).toBe(true);
    expect(DASHBOARD_METRIC_RUNTIME_REGISTRY_V2.factors.every(
      (factor) => [
        "report_context",
        "accounting_snapshot",
        "commercial_snapshot",
        "commercial_daily_series",
        "commercial_collection_daily_series",
        "merchant_ai_review_snapshot",
        "merchant_catalog_snapshot",
        "merchant_customer_snapshot",
        "payment_method_snapshot",
        "selected_store_inventory_snapshot",
        "unattached",
      ].includes(factor.runtimeDependency),
    )).toBe(true);
  });

  it("does not serialize a stale inactive implementation state for attached factors", () => {
    for (const factor of DASHBOARD_METRIC_RUNTIME_REGISTRY_V2.factors) {
      if (factor.runtimeDependency === "unattached") {
        expect(factor.implementationState).not.toBe("runtime_bound");
      } else {
        expect(factor.implementationState).toBe("runtime_bound");
      }
    }
  });

  it("promotes exactly the two daily factors when their canonical series are attached", () => {
    const withDaily = structuredClone(model) as unknown as Record<string, unknown>;
    Object.assign(withDaily, {
      dailyActiveOrderCountSeries: [{
        localDate: "2026-08-17",
        activeOrderCount: 2,
      }],
    });
    const currency = (withDaily.currencies as Array<Record<string, unknown>>)[0]!;
    Object.assign(currency, {
      dailyCurrentOrderGrossValueSeries: [{
        localDate: "2026-08-17",
        currentOrderGrossValueMinor: 420_000,
      }],
      dailyRecordedGrossCollectionsSeries: [{
        localDate: "2026-08-17",
        recordedGrossCollectionsMinor: 0,
      }],
    });

    const binding = createDashboardMetricRuntimeBindingV1(
      context,
      withDaily as never,
    );

    expect(binding).toMatchObject({
      availableCount: 20,
      unavailableCount: 7,
    });
    expect(binding.factors.find(
      (factor) => factor.factorId === "daily_active_order_count_series",
    )).toMatchObject({
      runtimeDependency: "commercial_daily_series",
      runtimeStatus: "available",
      runtimeDataQualityStatus: "complete",
    });
    expect(binding.factors.find(
      (factor) => factor.factorId === "daily_order_value_and_collection_series",
    )).toMatchObject({
      runtimeDependency: "commercial_collection_daily_series",
      runtimeStatus: "available",
      runtimeDataQualityStatus: "complete",
    });
  });

  it("produces 18 available and 9 unavailable states from actual dependencies", () => {
    const binding = createDashboardMetricRuntimeBindingV1(context, model);
    expect(binding).toMatchObject({
      reportAsOf: context.reportAsOf,
      availableCount: 18,
      unavailableCount: 9,
    });
    expect(binding.factors.find(
      (factor) => factor.factorId === "current_order_value_and_recorded_collection",
    )).toMatchObject({
      runtimeDependency: "commercial_snapshot",
      runtimeStatus: "available",
      targetSources: ["app.payment_events", "effective_order_v1"],
    });
    expect(binding.factors.find(
      (factor) => factor.factorId === "current_gross_profit",
    )).toMatchObject({
      runtimeDependency: "accounting_snapshot",
      runtimeStatus: "unavailable",
      targetSources: ["accounting_journal"],
    });
    expect(binding.factors.find(
      (factor) => factor.factorId === "orders_with_shipping_count",
    )).toMatchObject({
      runtimeDependency: "commercial_snapshot",
      runtimeStatus: "available",
    });
    expect(binding.factors.find(
      (factor) => factor.factorId === "shipping_share_percent",
    )).toMatchObject({
      runtimeDependency: "commercial_snapshot",
      runtimeStatus: "available",
    });
  });

  it("withdraws only factors whose serialized dependency is absent", () => {
    const missingCommercial = structuredClone(model);
    delete missingCommercial.currencies[0]!.currentOrder.commercialMetrics;
    const commercialBinding = createDashboardMetricRuntimeBindingV1(
      context,
      missingCommercial,
    );
    expect(commercialBinding.factors.find(
      (factor) => factor.factorId === "active_effective_order_count",
    )?.runtimeStatus).toBe("unavailable");
    expect(commercialBinding.factors.find(
      (factor) => factor.factorId === "dashboard_freshness_state",
    )?.runtimeStatus).toBe("available");

    const missingMethods = structuredClone(model);
    delete missingMethods.currencies[0]!.paymentFlow.methods;
    const paymentBinding = createDashboardMetricRuntimeBindingV1(context, missingMethods);
    expect(paymentBinding.factors.find(
      (factor) => factor.factorId === "payment_method_amount",
    )?.runtimeStatus).toBe("unavailable");
    expect(paymentBinding.factors.find(
      (factor) => factor.factorId === "current_shipping_value",
    )?.runtimeStatus).toBe("available");
  });

  it("withholds every denominator-derived factor when the canonical cohort is empty", () => {
    const zeroDenominator = structuredClone(model);
    zeroDenominator.currencies[0]!.currentOrder.validOrderCount = 0;
    zeroDenominator.currencies[0]!.currentOrder.currentOrderGrossValueMinor = 0;
    zeroDenominator.currencies[0]!.currentOrder.currentVatMinor = 0;
    zeroDenominator.currencies[0]!.currentOrder.currentUnclassifiedMinor = 0;
    Object.assign(zeroDenominator.currencies[0]!.currentOrder.commercialMetrics!, {
      cancelledOrderCohortCount: 0,
      activeOrdersWithShippingCount: 0,
      currentMerchandiseGrossValueMinor: 0,
      currentDiscountMinor: 0,
      currentMerchandiseRevenueExVatMinor: 0,
      currentShippingRevenueExVatMinor: 0,
      currentShippingGrossValueMinor: 0,
      currentShippingSharePercent: null,
      effectiveItemQuantity: 0,
      averageCurrentOrderValueMinor: null,
      currentCogsMinor: 0,
      currentMerchandiseGrossProfitMinor: 0,
      currentContributionBeforeShippingCostMinor: 0,
      topProducts: [],
    });
    zeroDenominator.currencies[0]!.recordedCollectionMinusCurrentOrderValueMinor = 0;

    const binding = createDashboardMetricRuntimeBindingV1(context, zeroDenominator);
    expect(binding.factors.find(
      (factor) => factor.factorId === "orders_with_shipping_count",
    )?.runtimeStatus).toBe("available");
    expect(binding.factors.find(
      (factor) => factor.factorId === "shipping_share_percent",
    )).toMatchObject({
      runtimeStatus: "unavailable",
      runtimeDataQualityStatus: "unavailable",
    });
    for (const factorId of [
      "average_current_order_value",
      "cancellation_rate",
      "items_per_order",
    ] as const) {
      expect(binding.factors.find(
        (factor) => factor.factorId === factorId,
      )).toMatchObject({
        runtimeStatus: "unavailable",
        runtimeDataQualityStatus: "unavailable",
        runtimeReason: expect.stringContaining("unavailable"),
      });
    }
  });

  it("promotes only catalog and inventory factors when the operational snapshot is exact", () => {
    const withOperational = {
      ...structuredClone(model),
      operationalSnapshot: {
        schemaVersion: 1 as const,
        reportMerchantAiReviewQueue: {
          status: "available" as const,
          dataQualityStatus: "complete" as const,
          pendingOrReviewRequiredCount: 4,
        },
        reportMerchantCatalog: {
          status: "available" as const,
          dataQualityStatus: "complete" as const,
          publishedSkuCount: 17,
        },
        selectedReportStoresInventory: {
          status: "available" as const,
          dataQualityStatus: "complete" as const,
          inventoryVariantLocationCount: 24,
          lowStockVariantLocationCount: 3,
          outOfStockVariantLocationCount: 5,
        },
      },
    };

    const binding = createDashboardMetricRuntimeBindingV1(context, withOperational);
    expect(binding).toMatchObject({
      availableCount: 22,
      unavailableCount: 5,
    });
    expect(binding.factors.find(
      (factor) => factor.factorId === "ai_pending_count",
    )).toMatchObject({
      runtimeDependency: "merchant_ai_review_snapshot",
      runtimeStatus: "available",
    });
    expect(binding.factors.find(
      (factor) => factor.factorId === "published_sku_count",
    )).toMatchObject({
      runtimeDependency: "merchant_catalog_snapshot",
      runtimeStatus: "available",
    });
    for (const factorId of ["low_stock_count", "out_of_stock_count"] as const) {
      expect(binding.factors.find(
        (factor) => factor.factorId === factorId,
      )).toMatchObject({
        runtimeDependency: "selected_store_inventory_snapshot",
        runtimeStatus: "available",
      });
    }
  });

  it("keeps inventory unavailable without withdrawing exact merchant factors", () => {
    const withPartialOperational = {
      ...structuredClone(model),
      operationalSnapshot: {
        schemaVersion: 1 as const,
        reportMerchantAiReviewQueue: {
          status: "available" as const,
          dataQualityStatus: "complete" as const,
          pendingOrReviewRequiredCount: 4,
        },
        reportMerchantCatalog: {
          status: "available" as const,
          dataQualityStatus: "complete" as const,
          publishedSkuCount: 17,
        },
        selectedReportStoresInventory: {
          status: "unavailable" as const,
          dataQualityStatus: "unavailable" as const,
          issues: ["missing_reorder_level" as const],
        },
      },
    };

    const binding = createDashboardMetricRuntimeBindingV1(
      context,
      withPartialOperational,
    );
    expect(binding).toMatchObject({
      availableCount: 20,
      unavailableCount: 7,
    });
    expect(binding.factors.find(
      (factor) => factor.factorId === "ai_pending_count",
    )?.runtimeStatus).toBe("available");
    expect(binding.factors.find(
      (factor) => factor.factorId === "published_sku_count",
    )?.runtimeStatus).toBe("available");
    expect(binding.factors.find(
      (factor) => factor.factorId === "low_stock_count",
    )).toMatchObject({
      runtimeStatus: "unavailable",
      runtimeReason: expect.stringContaining("missing_reorder_level"),
    });
  });

  it("withholds an ownership-ambiguous AI count without withdrawing catalog", () => {
    const withAmbiguousAi = {
      ...structuredClone(model),
      operationalSnapshot: {
        schemaVersion: 1 as const,
        reportMerchantAiReviewQueue: {
          status: "unavailable" as const,
          dataQualityStatus: "unavailable" as const,
          issues: ["ambiguous_merchant_ai_ownership" as const],
        },
        reportMerchantCatalog: {
          status: "available" as const,
          dataQualityStatus: "complete" as const,
          publishedSkuCount: 17,
        },
        selectedReportStoresInventory: {
          status: "available" as const,
          dataQualityStatus: "complete" as const,
          inventoryVariantLocationCount: 24,
          lowStockVariantLocationCount: 3,
          outOfStockVariantLocationCount: 5,
        },
      },
    };

    const binding = createDashboardMetricRuntimeBindingV1(context, withAmbiguousAi);
    expect(binding.factors.find(
      (factor) => factor.factorId === "ai_pending_count",
    )).toMatchObject({
      runtimeStatus: "unavailable",
      runtimeDataQualityStatus: "unavailable",
      runtimeReason: expect.stringContaining("ambiguous_merchant_ai_ownership"),
    });
    expect(binding.factors.find(
      (factor) => factor.factorId === "published_sku_count",
    )?.runtimeStatus).toBe("available");
  });

  it("reaches 27/27 only with exact accounting, customer and daily dependencies", () => {
    const complete = structuredClone(model);
    complete.dailyActiveOrderCountSeries = [{
      localDate: "2026-08-17",
      activeOrderCount: 2,
    }];
    Object.assign(complete.currencies[0]!, {
      dailyCurrentOrderGrossValueSeries: [{
        localDate: "2026-08-17",
        currentOrderGrossValueMinor: 420_000,
      }],
      dailyRecordedGrossCollectionsSeries: [{
        localDate: "2026-08-17",
        recordedGrossCollectionsMinor: 0,
      }],
      accounting: {
        currencyCode: "VND",
        minorUnitExponent: 0,
        status: "available",
        dataQualityStatus: "complete",
        postedJournalCount: 2,
        revenueExcludingVatMinor: 360_000,
        cogsRecognizedMinor: 220_000,
        grossProfitMinor: 140_000,
        grossMarginPercent: 38.9,
      },
      unavailableMetrics: [
        "commercialOutstandingAsOfMinor",
        "vatLiabilityMinor",
        "providerFeesMinor",
        "netProviderPayoutMinor",
      ],
    });
    complete.operationalSnapshot = {
      schemaVersion: 1,
      reportMerchantAiReviewQueue: {
        status: "available",
        dataQualityStatus: "complete",
        pendingOrReviewRequiredCount: 4,
      },
      reportMerchantCatalog: {
        status: "available",
        dataQualityStatus: "complete",
        publishedSkuCount: 17,
      },
      reportMerchantCustomerAcquisition: {
        status: "available",
        dataQualityStatus: "complete",
        attributionScope: "report_merchant",
        businessTimeZone: "Asia/Ho_Chi_Minh",
        newCustomerCount: 6,
      },
      selectedReportStoresInventory: {
        status: "available",
        dataQualityStatus: "complete",
        inventoryVariantLocationCount: 24,
        lowStockVariantLocationCount: 3,
        outOfStockVariantLocationCount: 5,
      },
    };

    const binding = createDashboardMetricRuntimeBindingV1(context, complete);
    expect(binding).toMatchObject({
      availableCount: 27,
      unavailableCount: 0,
    });
    for (const factorId of [
      "current_gross_profit",
      "gross_margin_percent",
      "new_customer_count",
    ] as const) {
      expect(binding.factors.find((factor) => factor.factorId === factorId))
        .toMatchObject({ runtimeStatus: "available" });
    }
  });

  it("keeps profit available but withholds margin when accounting revenue is zero", () => {
    const zeroRevenue = structuredClone(model);
    Object.assign(zeroRevenue.currencies[0]!, {
      accounting: {
        currencyCode: "VND",
        minorUnitExponent: 0,
        status: "available",
        dataQualityStatus: "complete",
        postedJournalCount: 0,
        revenueExcludingVatMinor: 0,
        cogsRecognizedMinor: 0,
        grossProfitMinor: 0,
        grossMarginPercent: null,
      },
    });
    const binding = createDashboardMetricRuntimeBindingV1(context, zeroRevenue);
    expect(binding.factors.find(
      (factor) => factor.factorId === "current_gross_profit",
    )?.runtimeStatus).toBe("available");
    expect(binding.factors.find(
      (factor) => factor.factorId === "gross_margin_percent",
    )).toMatchObject({
      runtimeStatus: "unavailable",
      runtimeReason: expect.stringContaining("positive revenue denominator"),
    });
  });
});
