import { describe, expect, it } from "vitest";
import type {
  DashboardPartialFinancialModelV1,
  DashboardPartialFinancialRuntimeHttpBodyV1,
} from "@medusa-snus/contracts";
import { createDashboardMetricRuntimeBindingV1 } from "../../../../packages/application/src/services/dashboard-factor-runtime-binding";
import { buildDashboardOverviewPresentationV1 } from "./dashboardOverviewPresentation";

const reportAsOf = "2026-09-01T10:00:00.000Z";

function modelFixture(): DashboardPartialFinancialModelV1 {
  return {
    schemaVersion: 1,
    completeness: "complete_payment_payable_v1",
    aggregateReadSource: "app.payment_events",
    dailyActiveOrderCountSeries: [
      { localDate: "2026-09-01", activeOrderCount: 2 },
    ],
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
    currencies: [{
      currencyCode: "VND",
      minorUnitExponent: 0,
      dailyCurrentOrderGrossValueSeries: [
        { localDate: "2026-09-01", currentOrderGrossValueMinor: 420_000 },
      ],
      dailyRecordedGrossCollectionsSeries: [
        { localDate: "2026-09-01", recordedGrossCollectionsMinor: 253_000 },
      ],
      currentOrder: {
        validOrderCount: 2,
        currentOrderGrossValueMinor: 420_000,
        currentVatMinor: 41_000,
        currentUnclassifiedMinor: 1_000,
        dataQualityStatus: "complete",
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
          currentCogsMinor: 220_000,
          currentMerchandiseGrossProfitMinor: 140_000,
          currentContributionBeforeShippingCostMinor: 158_000,
          topProducts: [{
            productId: "prod_mint",
            variantId: "variant_mint",
            skuSnapshot: "MINT-01",
            titleSnapshot: "Mint",
            archivedVariant: false,
            quantity: 3,
            grossLineSalesBeforeDiscountMinor: 400_000,
            currentCogsMinor: 220_000,
            costCoverage: { knownLines: 1, totalLines: 1 },
          }],
        },
      },
      recordedCollection: {
        status: "available",
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
      paymentFlow: {
        postedRefundEventCount: 1,
        postedReversalEventCount: 0,
        postedChargebackEventCount: 0,
        refundsMinor: 10_000,
        reversalsMinor: 0,
        chargebacksMinor: 0,
        negativeCollectionsMinor: 10_000,
        netCollectionsMinor: 243_000,
        customerRefundPayableAsOfMinor: 0,
        methods: [{
          method: "cash",
          postedChargeOrderCount: 2,
          postedNegativeEventCount: 1,
          recordedGrossCollectionsMinor: 253_000,
          recordedNegativeCollectionsMinor: 10_000,
          recordedNetCollectionsMinor: 243_000,
        }],
      },
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
      recordedCollectionMinusCurrentOrderValueMinor: -167_000,
      unavailableMetrics: [],
    }],
  };
}

function responseFixture(
  model: DashboardPartialFinancialModelV1 = modelFixture(),
): DashboardPartialFinancialRuntimeHttpBodyV1 {
  return {
    schemaVersion: 1,
    contract: "dashboard.partial-financial.v1",
    context: {
      schemaVersion: 1,
      normalizedScope: {
        scopeKind: "report",
        merchantId: "merchant_default",
        storeIds: ["store_default"],
      },
      localDateRange: { from: "2026-09-01", to: "2026-09-01", inclusiveDays: 1 },
      storeTimeWindows: [{
        storeId: "store_default",
        timeZone: "Asia/Ho_Chi_Minh",
        startInclusive: "2026-08-31T17:00:00.000Z",
        endExclusive: "2026-09-01T17:00:00.000Z",
      }],
      reportAsOf,
      generatedAt: "2026-09-01T10:00:01.000Z",
      metricTimeBasis: {
        recordedGrossCollectionsMinor: "payment_event_at",
        refundsMinor: "payment_event_at",
        reversalsMinor: "payment_event_at",
        chargebacksMinor: "payment_event_at",
        currentOrderGrossValueMinor: "effective_order_created_at",
        commercialOutstandingAsOfMinor: "as_of_effective_order_and_payment_events",
        customerRefundPayableAsOfMinor: "as_of_payment_events",
        revenueExcludingVatMinor: "accounting_source_occurred_at",
        vatLiabilityMinor: "accounting_source_occurred_at",
        cogsRecognizedMinor: "accounting_source_occurred_at",
      },
      freshness: { databaseSnapshot: { status: "fresh", asOf: reportAsOf } },
    },
    data: model,
    factorBinding: createDashboardMetricRuntimeBindingV1({ reportAsOf }, model),
  };
}

describe("O1 canonical old-Overview presentation adapter", () => {
  it("freezes the old semantic inventory without inventing internal tabs", () => {
    const result = buildDashboardOverviewPresentationV1(responseFixture());

    expect(result.navigationLabel).toBe("Tổng quan");
    expect(result.datePresets.map((preset) => preset.label)).toEqual([
      "Hôm nay",
      "7 ngày",
      "30 ngày",
    ]);
    expect(result.sectionOrder).toEqual([
      "metric_grid",
      "revenue_order_chart",
      "owner_insight",
      "top_products",
      "payment_mix",
      "operational_risk",
    ]);
    expect(result).not.toHaveProperty("tabs");
    expect(result.factorCensus).toHaveLength(27);
    expect(new Set(result.factorCensus.map((factor) => factor.factorId)).size).toBe(27);
  });

  it("maps canonical values into explicit commercial, collection and accounting semantics", () => {
    const result = buildDashboardOverviewPresentationV1(responseFixture());
    const vnd = result.currencyBlocks[0]!;

    expect(vnd.currencyCode).toBe("VND");
    expect(vnd.metricCards).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "current_order_value", label: "Giá trị đơn hàng hiện tại", status: "available", valueMinor: 420_000 }),

      expect.objectContaining({ id: "accounting_gross_profit", label: "Lợi nhuận gộp kế toán", status: "available", valueMinor: 140_000 }),
    ]));
    expect(vnd.dailyChart).toMatchObject({ status: "available", points: [{ localDate: "2026-09-01" }] });
    expect(vnd.topProducts).toMatchObject({ status: "available", empty: false });
    expect(vnd.paymentMix).toMatchObject({ status: "available", empty: false });
    expect(vnd.ownerInsight.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gross_margin_percent", status: "available", value: 38.9 }),
      expect.objectContaining({ id: "cancellation_rate", status: "available", value: 33.3 }),
    ]));
  });

  it("keeps multiple currencies in independent blocks without implicit FX aggregation", () => {
    const model = modelFixture();
    delete model.dailyActiveOrderCountSeries;
    delete model.currencies[0]!.dailyCurrentOrderGrossValueSeries;
    delete model.currencies[0]!.dailyRecordedGrossCollectionsSeries;
    const usd = structuredClone(model.currencies[0]!);
    usd.currencyCode = "USD";
    usd.minorUnitExponent = 2;
    if (usd.accounting) {
      usd.accounting.currencyCode = "USD";
      usd.accounting.minorUnitExponent = 2;
    }
    model.currencies = [usd, model.currencies[0]!];

    const result = buildDashboardOverviewPresentationV1(responseFixture(model));

    expect(result.currencyBlocks.map((block) => block.currencyCode)).toEqual(["USD", "VND"]);
    expect(result.currencyBlocks).toHaveLength(2);
    expect(result.currencyBlocks.every((block) => (
      block.metricCards.find((card) => card.id === "current_order_value")?.status
      === "available"
    ))).toBe(true);
  });

  it("distinguishes an available empty range from unavailable derived values", () => {
    const model = modelFixture();
    const currency = model.currencies[0]!;
    model.dailyActiveOrderCountSeries = [{ localDate: "2026-09-01", activeOrderCount: 0 }];
    currency.dailyCurrentOrderGrossValueSeries = [{ localDate: "2026-09-01", currentOrderGrossValueMinor: 0 }];
    currency.dailyRecordedGrossCollectionsSeries = [{ localDate: "2026-09-01", recordedGrossCollectionsMinor: 0 }];
    currency.currentOrder = {
      validOrderCount: 0,
      currentOrderGrossValueMinor: 0,
      currentVatMinor: 0,
      currentUnclassifiedMinor: 0,
      dataQualityStatus: "complete",
      commercialMetrics: {
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
      },
    };
    currency.recordedCollection = {
      status: "none_in_selected_window",
      postedChargeEventCount: 0,
      recordedGrossCollectionsMinor: 0,
      components: null,
    };
    currency.paymentFlow = {
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
    };
    currency.accounting = {
      currencyCode: "VND",
      minorUnitExponent: 0,
      status: "available",
      dataQualityStatus: "complete",
      postedJournalCount: 0,
      revenueExcludingVatMinor: 0,
      cogsRecognizedMinor: 0,
      grossProfitMinor: 0,
      grossMarginPercent: null,
    };
    currency.recordedCollectionMinusCurrentOrderValueMinor = 0;

    const result = buildDashboardOverviewPresentationV1(responseFixture(model));
    const vnd = result.currencyBlocks[0]!;
    expect(vnd.metricCards.find((card) => card.id === "current_order_value"))
      .toMatchObject({ status: "available", valueMinor: 0 });
    expect(vnd.topProducts).toMatchObject({ status: "available", empty: true, items: [] });
    expect(vnd.paymentMix).toMatchObject({ status: "available", empty: true, items: [
      { method: "cash", netMinor: 0 }, { method: "cod", netMinor: 0 }, { method: "manual_bank", netMinor: 0 },
    ] });
    expect(result.sharedOwnerInsight.rows).toMatchObject([{ id: "sold_item_quantity", status: "available", value: 0, unit: "item_count" }]);
    expect(vnd.ownerInsight.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gross_margin_percent", status: "unavailable" }),
      expect.objectContaining({ id: "cancellation_rate", status: "unavailable" }),
      expect.objectContaining({ id: "items_per_order", status: "unavailable" }),
    ]));
    expect(result.factorCensus).toEqual(expect.arrayContaining([
      expect.objectContaining({ factorId: "average_current_order_value", status: "unavailable" }),
      expect.objectContaining({ factorId: "cancellation_rate", status: "unavailable" }),
      expect.objectContaining({ factorId: "items_per_order", status: "unavailable" }),
    ]));
  });

  it("preserves scope/timezone/freshness and explicit operational failure reasons without mutating input", () => {
    const input = responseFixture();
    input.data.operationalSnapshot!.reportMerchantAiReviewQueue = {
      status: "unavailable",
      dataQualityStatus: "unavailable",
      issues: ["ambiguous_merchant_ai_ownership"],
    };
    input.data.operationalSnapshot!.selectedReportStoresInventory = {
      status: "unavailable",
      dataQualityStatus: "unavailable",
      issues: ["missing_reorder_level"],
    };
    input.factorBinding = createDashboardMetricRuntimeBindingV1(
      { reportAsOf },
      input.data,
    );
    const before = structuredClone(input);

    const result = buildDashboardOverviewPresentationV1(input);

    expect(result.context.storeTimeWindows).toEqual([{ storeId: "store_default", timeZone: "Asia/Ho_Chi_Minh", startInclusive: "2026-08-31T17:00:00.000Z", endExclusive: "2026-09-01T17:00:00.000Z" }]);
    expect(result.context.reportAsOf).toBe(reportAsOf);
    expect(result.operationalRisk.aiPending).toMatchObject({ status: "unavailable", reason: expect.stringContaining("ambiguous_merchant_ai_ownership") });
    expect(result.operationalRisk.lowStock).toMatchObject({ status: "unavailable", reason: expect.stringContaining("missing_reorder_level") });
    expect(result.operationalRisk.outOfStock).toMatchObject({ status: "unavailable", reason: expect.stringContaining("missing_reorder_level") });
    expect(input).toEqual(before);
  });
});


describe("OV2 quantity, payment density and removed headline", () => {
  it("shows one sold unit total and preserves chart gross versus payment net", () => {
    const result = buildDashboardOverviewPresentationV1(responseFixture());
    expect(result.sharedOwnerInsight.rows).toMatchObject([{ id: "sold_item_quantity", label: "Số sản phẩm đã bán", value: 3, unit: "item_count" }]);
    const block = result.currencyBlocks[0]!;
    expect(block.metricCards.some(card => card.id === "recorded_gross_collection")).toBe(false);
    expect(block.dailyChart).toMatchObject({ points: [{ recordedGrossCollectionsMinor: 253000 }] });
    expect(block.paymentMix).toMatchObject({ items: [
      { method: "cash", label: "Cash", netMinor: 243000, postedChargeOrderCount: 2 },
      { method: "cod", label: "COD", netMinor: 0, postedChargeOrderCount: 0 },
      { method: "manual_bank", label: "Bank", netMinor: 0, postedChargeOrderCount: 0 },
    ] });
  });
  it("sums non-monetary quantities once across currencies", () => {
    const model = modelFixture();
    const usd = structuredClone(model.currencies[0]!);
    usd.currencyCode = "USD"; usd.minorUnitExponent = 2;
    delete usd.accounting;
    model.currencies.unshift(usd);
    model.dailyActiveOrderCountSeries![0]!.activeOrderCount = 4;
    const result = buildDashboardOverviewPresentationV1(responseFixture(model));
    expect(result.sharedOwnerInsight.rows).toMatchObject([{ value: 6 }]);
    expect(result.currencyBlocks.every(b => b.ownerInsight.rows.every(r => r.id !== "sold_item_quantity"))).toBe(true);
  });
  it("does not invent sold quantity when commercial data is absent", () => {
    const model = modelFixture();
    delete model.currencies[0]!.currentOrder.commercialMetrics;
    expect(buildDashboardOverviewPresentationV1(responseFixture(model)).sharedOwnerInsight.rows)
      .toMatchObject([{ status: "unavailable" }]);
  });
  it("rejects unsafe cross-currency unit totals", () => {
    const model = modelFixture();
    model.currencies[0]!.currentOrder.commercialMetrics!.effectiveItemQuantity = Number.MAX_SAFE_INTEGER;
    const usd = structuredClone(model.currencies[0]!);
    usd.currencyCode = "USD"; usd.minorUnitExponent = 2; delete usd.accounting;
    model.currencies.unshift(usd);
    model.dailyActiveOrderCountSeries![0]!.activeOrderCount = 4;
    expect(buildDashboardOverviewPresentationV1(responseFixture(model)).sharedOwnerInsight.rows)
      .toMatchObject([{ status: "unavailable" }]);
  });
  it("keeps Bank net negative and unknown offsetting activity visible", () => {
    const model = modelFixture();
    model.currencies[0]!.paymentFlow!.methods = [
      { method: "manual_bank", postedChargeOrderCount: 1, postedNegativeEventCount: 2, recordedGrossCollectionsMinor: 10, recordedNegativeCollectionsMinor: 30, recordedNetCollectionsMinor: -20 },
      { method: "provider", postedChargeOrderCount: 1, postedNegativeEventCount: 1, recordedGrossCollectionsMinor: 10, recordedNegativeCollectionsMinor: 10, recordedNetCollectionsMinor: 0 },
    ];
    expect(buildDashboardOverviewPresentationV1(responseFixture(model)).currencyBlocks[0]!.paymentMix).toMatchObject({ items: [
      { method: "cash", netMinor: 0 }, { method: "cod", netMinor: 0 },
      { method: "manual_bank", label: "Bank", netMinor: -20, postedChargeOrderCount: 1 },
      { method: "provider", label: "Khác — cần đối soát", netMinor: 0 },
    ] });
  });
  it("fails closed on legacy alias collision instead of adding distinct counts", () => {
    const response = responseFixture();
    const methods = response.data.currencies[0]!.paymentFlow!.methods!;
    const bank = { ...methods[0]!, method: "manual_bank" as const };
    methods.push(bank, { ...bank, method: "bank_transfer" } as unknown as typeof bank);
    expect(() => buildDashboardOverviewPresentationV1(response)).toThrow();
  });
});


describe("OV2 partial profit presentation", () => {
  it("shows verified profit and journal coverage while exact factors and margin stay unavailable", () => {
    const model = modelFixture(); const currency = model.currencies[0]!;
    currency.accounting = { currencyCode: "VND", minorUnitExponent: 0, status: "unavailable", dataQualityStatus: "unavailable", issues: ["incomplete_cost_provenance"] };
    currency.accountingProfitCoverage = { status: "partial", totalJournalCount: 5, coveredJournalCount: 3, excludedJournalCount: 2,
      exactGrossProfitMinor: null, verifiedSubsetRevenueExcludingVatMinor: 100, verifiedSubsetCogsRecognizedMinor: 60, verifiedSubsetGrossProfitMinor: 40, issues: ["incomplete_cost_provenance"] };
    const result = buildDashboardOverviewPresentationV1(responseFixture(model));
    expect(result.currencyBlocks[0]!.metricCards.find(c => c.id === "accounting_gross_profit")).toMatchObject({ label: "Lợi nhuận xác minh được", valueMinor: 40, coverage: { covered: 3, total: 5, excluded: 2 } });
    expect(result.currencyBlocks[0]!.ownerInsight.rows.find(r => r.id === "gross_margin_percent")?.status).toBe("unavailable");
    expect(result.factorCensus.find(f => f.factorId === "current_gross_profit")?.status).toBe("unavailable");
  });
});
