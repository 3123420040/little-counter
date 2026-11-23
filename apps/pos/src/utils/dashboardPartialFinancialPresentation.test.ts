import { describe, expect, it } from "vitest";
import {
  DASHBOARD_PARTIAL_FINANCIAL_PRESENTATION_DEFAULT_CONFIG_V1,
  presentDashboardPartialFinancialV1,
} from "./dashboardPartialFinancialPresentation";
import type {
  DashboardMetricRuntimeBindingV1,
  DashboardPartialFinancialModelV1,
} from "@medusa-snus/contracts";
import { createDashboardMetricRuntimeBindingV1 } from "../../../../packages/application/src/services/dashboard-factor-runtime-binding";

const model: DashboardPartialFinancialModelV1 = {
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
      status: "available" as const,
      postedChargeEventCount: 2,
      recordedGrossCollectionsMinor: 253_000,
      components: {
        taxModes: ["exclusive", "inclusive"],
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
    unavailableMetrics: ["refundsMinor", "netCollectionsMinor", "revenueExcludingVatMinor"],
  }],
};

const factorBinding = createDashboardMetricRuntimeBindingV1({
  reportAsOf: "2026-08-05T12:00:00.000Z",
}, model) as DashboardMetricRuntimeBindingV1;

describe("DASH-04 runtime-bound partial financial presentation", () => {
  it("is frozen default-on and retains an explicit disabled seam", () => {
    expect(DASHBOARD_PARTIAL_FINANCIAL_PRESENTATION_DEFAULT_CONFIG_V1)
      .toEqual({ enabled: true });
    expect(Object.isFrozen(DASHBOARD_PARTIAL_FINANCIAL_PRESENTATION_DEFAULT_CONFIG_V1)).toBe(true);
    expect(presentDashboardPartialFinancialV1(
      {} as never,
      {} as never,
      { enabled: false },
    )).toEqual({
      enabled: false,
      status: "disabled",
    });
  });

  it("uses distinct Vietnamese headlines and never calls gross collection accounting revenue", () => {
    const result = presentDashboardPartialFinancialV1(model, factorBinding, { enabled: true });
    if (!result.enabled) throw new Error("expected enabled presentation");
    expect(result.currencies[0]!.headlines).toEqual([
      {
        key: "current_order_value",
        label: "Giá trị đơn hàng hiện tại",
        valueMinor: 420_000,
        help: "Giá trị thương mại mới nhất của các đơn trong kỳ, không phải số tiền đã thu.",
      },
      {
        key: "recorded_gross_collection",
        label: "Tổng tiền đã ghi nhận thu (gồm VAT và các khoản tính thêm)",
        valueMinor: 253_000,
        help: "Tổng các khoản thu đã được ghi nhận hoàn tất theo thời điểm thanh toán; không cộng lại VAT, phí hoặc bản ghi tương thích cũ.",
      },
    ]);
    expect(result.currencies[0]!.headlines[1]!.label.toLowerCase()).not.toContain("doanh thu");
  });

  it("shows included VAT, added VAT and other charged money separately", () => {
    const result = presentDashboardPartialFinancialV1(model, factorBinding, { enabled: true });
    if (!result.enabled) throw new Error("expected enabled presentation");
    expect(result.currencies[0]!.collectionBreakdown).toEqual([
      { key: "vat_total", label: "VAT trong khoản đã thu", valueMinor: 23_000 },
      { key: "vat_included", label: "VAT đã nằm trong giá", valueMinor: 11_000 },
      { key: "vat_added", label: "VAT được cộng thêm", valueMinor: 12_000 },
      { key: "shipping", label: "Phí giao hàng đã tính", valueMinor: 31_000 },
      { key: "other", label: "Khoản thu khác chưa phân loại", valueMinor: 0 },
    ]);
  });

  it("presents exact current shipping count, gross value and denominator-safe share", () => {
    const result = presentDashboardPartialFinancialV1(model, factorBinding, { enabled: true });
    if (!result.enabled) throw new Error("expected enabled presentation");
    expect(result.currencies[0]!.commercial).toMatchObject({
      status: "available",
      activeOrdersWithShippingCount: 1,
      currentShippingGrossValueMinor: 20_000,
      currentShippingSharePercent: 4.8,
    });
    expect(result.factorStates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        factorId: "orders_with_shipping_count",
        status: "available",
      }),
      expect.objectContaining({
        factorId: "shipping_share_percent",
        status: "available",
      }),
    ]));
  });

  it("presents exact merchant-catalog and selected-report-store inventory counts", () => {
    const operationalModel: DashboardPartialFinancialModelV1 = {
      ...structuredClone(model),
      operationalSnapshot: {
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
      },
    };
    const operationalBinding = createDashboardMetricRuntimeBindingV1({
      reportAsOf: "2026-08-05T12:00:00.000Z",
    }, operationalModel);
    const result = presentDashboardPartialFinancialV1(
      operationalModel,
      operationalBinding,
      { enabled: true },
    );
    if (!result.enabled) throw new Error("expected enabled presentation");

    expect(result.operational).toEqual(operationalModel.operationalSnapshot);
    expect(result.factorStates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        factorId: "ai_pending_count",
        status: "available",
      }),
      expect.objectContaining({
        factorId: "published_sku_count",
        status: "available",
      }),
      expect.objectContaining({
        factorId: "low_stock_count",
        status: "available",
      }),
      expect.objectContaining({
        factorId: "out_of_stock_count",
        status: "available",
      }),
      expect.objectContaining({
        factorId: "new_customer_count",
        status: "available",
      }),
    ]));
  });

  it("presents accounting-backed profit and margin separately from commercial cost snapshots", () => {
    const accountingModel = structuredClone(model);
    Object.assign(accountingModel.currencies[0]!, {
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
      unavailableMetrics: ["refundsMinor", "netCollectionsMinor"],
    });
    const accountingBinding = createDashboardMetricRuntimeBindingV1({
      reportAsOf: "2026-08-05T12:00:00.000Z",
    }, accountingModel);

    const result = presentDashboardPartialFinancialV1(
      accountingModel,
      accountingBinding,
      { enabled: true },
    );
    if (!result.enabled) throw new Error("expected enabled presentation");

    expect(result.currencies[0]!.accounting).toEqual({
      status: "available",
      postedJournalCount: 2,
      revenueExcludingVatMinor: 360_000,
      cogsRecognizedMinor: 220_000,
      grossProfitMinor: 140_000,
      grossMarginPercent: 38.9,
    });
    expect(result.factorStates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        factorId: "current_gross_profit",
        status: "available",
      }),
      expect.objectContaining({
        factorId: "gross_margin_percent",
        status: "available",
      }),
    ]));
  });

  it("presents separate per-currency daily order value and recorded collection series", () => {
    const dailyModel = structuredClone(model) as unknown as Record<string, unknown>;
    Object.assign(dailyModel, {
      dailyActiveOrderCountSeries: [
        { localDate: "2026-08-04", activeOrderCount: 0 },
        { localDate: "2026-08-05", activeOrderCount: 2 },
      ],
    });
    Object.assign((dailyModel.currencies as Array<Record<string, unknown>>)[0]!, {
      dailyCurrentOrderGrossValueSeries: [
        { localDate: "2026-08-04", currentOrderGrossValueMinor: 0 },
        { localDate: "2026-08-05", currentOrderGrossValueMinor: 420_000 },
      ],
      dailyRecordedGrossCollectionsSeries: [
        { localDate: "2026-08-04", recordedGrossCollectionsMinor: 100_000 },
        { localDate: "2026-08-05", recordedGrossCollectionsMinor: 153_000 },
      ],
    });
    const dailyBinding = createDashboardMetricRuntimeBindingV1({
      reportAsOf: "2026-08-05T12:00:00.000Z",
    }, dailyModel as never);

    const result = presentDashboardPartialFinancialV1(
      dailyModel as never,
      dailyBinding,
      { enabled: true },
    );
    if (!result.enabled) throw new Error("expected enabled presentation");

    expect(result.dailyActiveOrderCountSeries).toEqual([
      { localDate: "2026-08-04", activeOrderCount: 0 },
      { localDate: "2026-08-05", activeOrderCount: 2 },
    ]);
    expect(result.currencies[0]!.dailySeries).toEqual([
      {
        localDate: "2026-08-04",
        activeOrderCount: 0,
        currentOrderGrossValueMinor: 0,
        recordedGrossCollectionsMinor: 100_000,
      },
      {
        localDate: "2026-08-05",
        activeOrderCount: 2,
        currentOrderGrossValueMinor: 420_000,
        recordedGrossCollectionsMinor: 153_000,
      },
    ]);
  });

  it("renders an explicit no-collection state without a fabricated breakdown", () => {
    const empty = structuredClone(model);
    empty.currencies[0]!.recordedCollection = {
      status: "none_in_selected_window",
      postedChargeEventCount: 0,
      recordedGrossCollectionsMinor: 0,
      components: null,
    };
    const result = presentDashboardPartialFinancialV1(empty, factorBinding, { enabled: true });
    if (!result.enabled) throw new Error("expected enabled presentation");
    expect(result.currencies[0]!.collectionStateLabel)
      .toBe("Chưa có khoản thu đã ghi nhận trong kỳ đã chọn");
    expect(result.currencies[0]!.collectionBreakdown).toBeNull();
  });

  it("marks accounting-blocked metrics unavailable instead of displaying zero", () => {
    const result = presentDashboardPartialFinancialV1(model, factorBinding, { enabled: true });
    if (!result.enabled) throw new Error("expected enabled presentation");
    expect(result.currencies[0]!.unavailable).toEqual({
      label: "Các chỉ số kế toán/đối soát chưa đủ bằng chứng vẫn được ẩn thay vì hiển thị 0",
      metricKeys: ["refundsMinor", "netCollectionsMinor", "revenueExcludingVatMinor"],
    });
    expect(result.currencies[0]!.unavailable).not.toHaveProperty("valueMinor");
  });

  it("consumes every server-produced factor state and its registry metadata", () => {
    const serverBinding = structuredClone(factorBinding);
    const freshness = serverBinding.factors.find(
      (factor) => factor.factorId === "dashboard_freshness_state",
    )!;
    freshness.runtimeStatus = "unavailable";
    freshness.runtimeDataQualityStatus = "unavailable";
    freshness.runtimeReason = "server-withheld-for-test";
    serverBinding.availableCount -= 1;
    serverBinding.unavailableCount += 1;

    const result = presentDashboardPartialFinancialV1(
      model,
      serverBinding,
      { enabled: true },
    );
    if (!result.enabled) throw new Error("expected enabled presentation");
    expect(result.factorStates).toHaveLength(27);
    expect(new Set(result.factorStates.map((factor) => factor.factorId)).size).toBe(27);
    expect(result.factorStates).toContainEqual(expect.objectContaining({
      factorId: "dashboard_freshness_state",
      status: "unavailable",
      reason: "server-withheld-for-test",
      targetSources: ["report_context"],
      targetScope: "selected_report_stores",
      timeBasis: ["snapshot_as_of"],
    }));
    expect(result.factorStates).toContainEqual(expect.objectContaining({
      factorId: "daily_order_value_and_collection_series",
      status: "unavailable",
    }));
    expect(result.factorStates).toContainEqual(expect.objectContaining({
      factorId: "current_gross_profit",
      status: "unavailable",
    }));
  });
});
