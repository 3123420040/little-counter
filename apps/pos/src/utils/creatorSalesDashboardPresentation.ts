import { CreatorSalesDashboardV2Schema, CreatorSalesDashboardV3Schema, type CreatorSalesDashboardV2, type CreatorSalesDashboardV3 } from "@medusa-snus/contracts";
import {
  DASHBOARD_OVERVIEW_DATE_PRESETS_V1,
  DASHBOARD_OVERVIEW_SECTION_ORDER_V1,
  densePaymentMethods,
  type DashboardOverviewInsightRowV1,
  type DashboardOverviewMetricCardV1,
  type DashboardOverviewPresentationV1,
} from "./dashboardOverviewPresentation";

const unavailable = { status: "unavailable" as const, reason: "Chưa đủ bằng chứng cho chỉ số này." };
const count = (value: number) => ({ status: "available" as const, value });
function insight(id: string, label: string, value: number | null, unit: "percent" | "count" | "ratio"): DashboardOverviewInsightRowV1 {
  return { id, label, unit, ...(value === null ? unavailable : count(Math.round(value * 10) / 10)) };
}
function moneyCard(id: string, label: string, valueMinor: number | null): DashboardOverviewMetricCardV1 {
  return { id, label, ...(valueMinor === null ? unavailable : { status: "available" as const, valueMinor }) };
}

export function buildCreatorSalesDashboardPresentation(input: CreatorSalesDashboardV2 | CreatorSalesDashboardV3): DashboardOverviewPresentationV1 {
  const dashboard = input.schemaVersion === 3 ? CreatorSalesDashboardV3Schema.parse(input) : CreatorSalesDashboardV2Schema.parse(input);
  const operational = dashboard.operationalSnapshot;
  const inventory = operational.selectedReportStoresInventory;
  const ai = operational.reportMerchantAiReviewQueue;
  return {
    navigationLabel: "Tổng quan",
    datePresets: [...DASHBOARD_OVERVIEW_DATE_PRESETS_V1],
    sectionOrder: [...DASHBOARD_OVERVIEW_SECTION_ORDER_V1],
    context: {
      merchantId: dashboard.context.normalizedScope.merchantId,
      storeIds: dashboard.context.normalizedScope.storeIds,
      localDateRange: dashboard.context.localDateRange,
      storeTimeWindows: dashboard.context.storeTimeWindows,
      reportAsOf: dashboard.asOf,
      generatedAt: dashboard.context.generatedAt,
      freshnessStatus: dashboard.context.freshness.databaseSnapshot.status,
    },
    factorCensus: [],
    sharedMetricCards: {
      publishedSkuCount: count(operational.reportMerchantCatalog.publishedSkuCount),
      newCustomerCount: operational.reportMerchantCustomerAcquisition
        ? count(operational.reportMerchantCustomerAcquisition.newCustomerCount) : unavailable,
    },
    sharedOwnerInsight: { rows: [{
      id: "sold_item_quantity", label: "Số sản phẩm đã bán", unit: "item_count",
      ...count(dashboard.currencies.reduce((sum, currency) => sum + currency.effectiveItemQuantity, 0)),
    }] },
    currencyBlocks: dashboard.currencies.map((currency) => {
      const accounting = dashboard.financial?.currencies.find((row) => row.currencyCode === currency.currencyCode);
      const coverage = dashboard.financial?.profitCoverage?.find((row) => row.currencyCode === currency.currencyCode)?.coverage;
      const profit: DashboardOverviewMetricCardV1 = coverage?.status === "partial"
        ? { id: "accounting_gross_profit", label: "Lợi nhuận xác minh được", status: "available",
            valueMinor: coverage.verifiedSubsetGrossProfitMinor,
            coverage: { covered: coverage.coveredJournalCount, total: coverage.totalJournalCount, excluded: coverage.excludedJournalCount } }
        : moneyCard("accounting_gross_profit", "Lợi nhuận gộp kế toán", accounting?.status === "available" ? accounting.grossProfitMinor : null);
      const margin = accounting?.status === "available" ? accounting.grossMarginPercent : null;
      const topProducts = currency.topProducts.map((product) => ({ ...product, basisLabel: "Doanh số gộp trước discount" as const }));
      return {
        currencyCode: currency.currencyCode, minorUnitExponent: currency.minorUnitExponent,
        metricCards: [
          moneyCard("current_order_value", "Giá trị đơn hàng hiện tại", currency.currentOrderGrossValueMinor),
          moneyCard("current_shipping_value", "Giá trị vận chuyển hiện tại chưa VAT", currency.currentShippingRevenueExVatMinor),
          moneyCard("average_current_order_value", "Giá trị đơn trung bình hiện tại", currency.averageCurrentOrderValueMinor),
          ...(dashboard.audience === "full" ? [profit] : []),
          ...(dashboard.schemaVersion === 3 && "currentPaymentFeeCustomerTotalMinor" in currency ? [
            moneyCard("current_customer_payment_fee", "Phụ phí theo đơn (ngày tạo đơn)", currency.currentPaymentFeeCustomerTotalMinor),
            moneyCard("recorded_customer_payment_fee", "Phân bổ phí trong khoản thu (ngày thu)", currency.recordedPaymentFeeCustomerTotalMinor),
            ...ownerFeeCards(dashboard, currency.currencyCode),
          ] : []),
        ],
        dailyChart: {
          status: "available" as const,
          empty: currency.dailySeries.every((point) => point.activeOrderCount === 0 && point.currentOrderGrossValueMinor === 0),
          points: currency.dailySeries,
        },
        ownerInsight: { rows: [
          ...(dashboard.audience === "full" ? [insight("gross_margin_percent", "Biên lợi nhuận gộp kế toán", margin, "percent")] : []),
          insight("cancellation_rate", "Tỷ lệ hủy đơn", currency.orderCount ? (currency.orderCount - currency.activeOrderCount) * 100 / currency.orderCount : null, "percent"),
          insight("items_per_order", "Sản phẩm / đơn", currency.activeOrderCount ? currency.effectiveItemQuantity / currency.activeOrderCount : null, "ratio"),
          insight("orders_with_shipping_count", "Đơn có phí vận chuyển", currency.activeOrdersWithShippingCount, "count"),
          insight("shipping_share_percent", "Tỷ trọng phí vận chuyển", currency.currentShippingSharePercent, "percent"),
        ] },
        topProducts: { status: "available" as const, empty: !topProducts.length, items: topProducts },
        topProductNarrative: { status: "available" as const, empty: !topProducts.length, text: topProducts[0]?.titleSnapshot || "Chưa có sản phẩm bán ra." },
        paymentMix: { status: "available" as const, empty: !currency.paymentMethods.length, items: densePaymentMethods(currency.paymentMethods) },
      };
    }),
    operationalRisk: {
      aiPending: ai?.status === "available" ? count(ai.pendingOrReviewRequiredCount) : unavailable,
      lowStock: inventory?.status === "available" ? count(inventory.lowStockVariantLocationCount) : unavailable,
      outOfStock: inventory?.status === "available" ? count(inventory.outOfStockVariantLocationCount) : unavailable,
    },
  };
}

function ownerFeeCards(dashboard: CreatorSalesDashboardV3, currencyCode: string): DashboardOverviewMetricCardV1[] {
  if (dashboard.audience !== "full" || !dashboard.feeFinancial) return [];
  const source = dashboard.feeFinancial.currencies.find(row => row.currencyCode === currencyCode);
  const negative = dashboard.feeFinancial.negatives.currencies.find(row => row.currencyCode === currencyCode);
  const journal = dashboard.feeFinancial.journals.currencies.find(row => row.currencyCode === currencyCode);
  const covered = (id: string, label: string, exact: number | null, subset: number, partial: boolean, counts: { covered: number; total: number; excluded: number; feeBasis: "event" | "journal" }): DashboardOverviewMetricCardV1 =>
    exact !== null ? moneyCard(id, label, exact) : partial ? { id, label: `${label} — phần xác minh được`, status: "available", valueMinor: subset, coverage: counts }
      : moneyCard(id, label, null);
  return [
    moneyCard("commercial_payment_fee_revenue", "Doanh thu phí theo đơn chưa VAT", source?.currentPaymentFeeRevenueExVatMinor ?? null),
    moneyCard("recorded_payment_fee_revenue", "Phí phân bổ trong khoản thu chưa VAT", source?.recordedPaymentFeeRevenueExVatMinor ?? null),
    negative ? covered("negative_payment_fee_revenue", "Phí đảo doanh thu khi hoàn chưa VAT", negative.feeRevenueReversedExVatMinor,
      negative.verifiedSubsetFeeRevenueReversedExVatMinor, negative.coverage.status === "partial", { covered: negative.coverage.coveredEventCount,
        total: negative.coverage.totalEventCount, excluded: negative.coverage.excludedEventCount, feeBasis: "event" }) : moneyCard("negative_payment_fee_revenue", "Phí đảo doanh thu khi hoàn chưa VAT", 0),
    journal ? covered("posted_payment_fee_revenue", "Doanh thu phí đã ghi sổ (kỳ nguồn)", journal.revenueExcludingVatMinor, journal.verifiedSubsetRevenueExcludingVatMinor,
      journal.coverage.status === "partial", { covered: journal.coverage.coveredJournalCount, total: journal.coverage.totalJournalCount, excluded: journal.coverage.excludedJournalCount, feeBasis: "journal" })
      : moneyCard("posted_payment_fee_revenue", "Doanh thu phí đã ghi sổ (kỳ nguồn)", null),
  ];
}
