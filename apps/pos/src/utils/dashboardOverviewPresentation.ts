import {
  DASHBOARD_VISIBLE_FACTOR_IDS_V1,
  DashboardPartialFinancialRuntimeHttpBodyV1Schema,
  type DashboardMetricRuntimeFactorV1,
  type DashboardPartialFinancialRuntimeHttpBodyV1,
} from "@medusa-snus/contracts";
import { presentDashboardPartialFinancialV1 } from "./dashboardPartialFinancialPresentation";

type FactorId = (typeof DASHBOARD_VISIBLE_FACTOR_IDS_V1)[number];
type Unavailable = { status: "unavailable"; reason: string };

export const DASHBOARD_OVERVIEW_SECTION_ORDER_V1 = Object.freeze([
  "metric_grid",
  "revenue_order_chart",
  "owner_insight",
  "top_products",
  "payment_mix",
  "operational_risk",
] as const);

export const DASHBOARD_OVERVIEW_DATE_PRESETS_V1 = Object.freeze([
  Object.freeze({ id: "today", label: "Hôm nay", inclusiveDays: 1 }),
  Object.freeze({ id: "seven_days", label: "7 ngày", inclusiveDays: 7 }),
  Object.freeze({ id: "thirty_days", label: "30 ngày", inclusiveDays: 30 }),
] as const);

export type DashboardOverviewMetricCardV1 =
  | {
      id: string;
      label: string;
      status: "available";
      valueMinor: number;
      coverage?: { covered: number; total: number; excluded: number; feeBasis?: "event" | "journal" };
    }
  | ({ id: string; label: string } & Unavailable);

export type DashboardOverviewInsightRowV1 =
  | { id: string; label: string; status: "available"; value: number; unit: "percent" | "count" | "ratio" | "item_count" }
  | ({ id: string; label: string; unit: "percent" | "count" | "ratio" | "item_count" } & Unavailable);

export interface DashboardOverviewPresentationV1 {
  navigationLabel: "Tổng quan";
  datePresets: Array<(typeof DASHBOARD_OVERVIEW_DATE_PRESETS_V1)[number]>;
  sectionOrder: Array<(typeof DASHBOARD_OVERVIEW_SECTION_ORDER_V1)[number]>;
  context: {
    merchantId: string;
    storeIds: string[];
    localDateRange: { from: string; to: string; inclusiveDays: number };
    storeTimeWindows: Array<{
      storeId: string;
      timeZone: string;
      startInclusive: string;
      endExclusive: string;
    }>;
    reportAsOf: string;
    generatedAt: string;
    freshnessStatus: "fresh";
  };
  factorCensus: Array<{
    factorId: string;
    status: "available" | "unavailable";
    reason: string;
    dataQualityStatus: "complete" | "partial" | "unavailable";
    targetScope: "report_merchant" | "selected_report_stores";
    currencyBehavior: "independent_currency_blocks" | "not_monetary" | "per_currency_ratio";
    targetSources: string[];
    timeBasis: string[];
  }>;
  sharedMetricCards: {
    publishedSkuCount: { status: "available"; value: number } | Unavailable;
    newCustomerCount: { status: "available"; value: number } | Unavailable;
  };
  sharedOwnerInsight: { rows: DashboardOverviewInsightRowV1[] };
  currencyBlocks: Array<{
    currencyCode: string;
    minorUnitExponent: number;
    metricCards: DashboardOverviewMetricCardV1[];
    dailyChart:
      | {
          status: "available";
          empty: boolean;
          points: Array<{
            localDate: string;
            activeOrderCount: number;
            currentOrderGrossValueMinor: number;
            recordedGrossCollectionsMinor?: number;
          }>;
        }
      | Unavailable;
    ownerInsight: { rows: DashboardOverviewInsightRowV1[] };
    topProducts:
      | {
          status: "available";
          empty: boolean;
          items: Array<{
            productId: string | null;
            variantId: string | null;
            skuSnapshot: string;
            titleSnapshot: string;
            archivedVariant: boolean;
            quantity: number;
            grossLineSalesBeforeDiscountMinor: number;
            basisLabel: "Doanh số gộp trước discount";
          }>;
        }
      | Unavailable;
    topProductNarrative:
      | { status: "available"; empty: boolean; text: string }
      | Unavailable;
    paymentMix:
      | {
          status: "available";
          empty: boolean;
          items: Array<{
            method: string;
            label: string;
            postedChargeOrderCount: number;
            postedNegativeEventCount: number;
            grossMinor: number;
            negativeMinor: number;
            netMinor: number;
          }>;
        }
      | Unavailable;
  }>;
  operationalRisk: {
    aiPending: { status: "available"; value: number } | Unavailable;
    lowStock: { status: "available"; value: number } | Unavailable;
    outOfStock: { status: "available"; value: number } | Unavailable;
  };
}

function factorMap(
  factors: DashboardMetricRuntimeFactorV1[],
): Map<FactorId, DashboardMetricRuntimeFactorV1> {
  return new Map(factors.map((factor) => [factor.factorId as FactorId, factor]));
}

function factor(
  factors: Map<FactorId, DashboardMetricRuntimeFactorV1>,
  factorId: FactorId,
): DashboardMetricRuntimeFactorV1 {
  const result = factors.get(factorId);
  if (!result) throw new Error(`dashboard factor is missing: ${factorId}`);
  return result;
}

function unavailableFor(
  factors: Map<FactorId, DashboardMetricRuntimeFactorV1>,
  factorId: FactorId,
  override?: string,
): Unavailable {
  return {
    status: "unavailable",
    reason: override || factor(factors, factorId).runtimeReason,
  };
}

function countValue(
  factors: Map<FactorId, DashboardMetricRuntimeFactorV1>,
  factorId: FactorId,
  value: number | null | undefined,
  missingReason?: string,
): { status: "available"; value: number } | Unavailable {
  const state = factor(factors, factorId);
  if (state.runtimeStatus !== "available" || value === null || value === undefined) {
    return unavailableFor(factors, factorId, value == null ? missingReason : undefined);
  }
  return { status: "available", value };
}

function moneyCard(
  factors: Map<FactorId, DashboardMetricRuntimeFactorV1>,
  factorId: FactorId,
  id: string,
  label: string,
  valueMinor: number | null | undefined,
  missingReason?: string,
): DashboardOverviewMetricCardV1 {
  const state = factor(factors, factorId);
  if (state.runtimeStatus !== "available" || valueMinor === null || valueMinor === undefined) {
    return {
      id,
      label,
      ...unavailableFor(factors, factorId, valueMinor == null ? missingReason : undefined),
    };
  }
  return { id, label, status: "available", valueMinor };
}

function insight(
  factors: Map<FactorId, DashboardMetricRuntimeFactorV1>,
  factorId: FactorId,
  label: string,
  value: number | null | undefined,
  unit: "percent" | "count" | "ratio" | "item_count",
  missingReason?: string,
): DashboardOverviewInsightRowV1 {
  const state = factor(factors, factorId);
  if (state.runtimeStatus !== "available" || value === null || value === undefined) {
    return {
      id: factorId,
      label,
      unit,
      ...unavailableFor(factors, factorId, value == null ? missingReason : undefined),
    };
  }
  return { id: factorId, label, status: "available", value, unit };
}

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

// Canonical writer + migration 026 restrict ledger methods. Distinct order counts
// cannot be folded across aliases without order identity; reject ambiguous input.
export function densePaymentMethods(methods: Array<{
  method: string; postedChargeOrderCount: number; postedNegativeEventCount: number;
  grossMinor: number; negativeMinor: number; netMinor: number;
}>) {
  const seen = new Set<string>();
  for (const method of methods) {
    if (seen.has(method.method) || !["cash", "cod", "manual_bank", "provider", "unknown"].includes(method.method)) {
      throw new Error("Ambiguous canonical payment method identity");
    }
    seen.add(method.method);
  }
  const required = [["cash", "Cash"], ["cod", "COD"], ["manual_bank", "Bank"]] as const;
  return [
    ...required.map(([method, label]) => ({
      method, label, postedChargeOrderCount: 0, postedNegativeEventCount: 0,
      grossMinor: 0, negativeMinor: 0, netMinor: 0,
      ...methods.find(row => row.method === method),
    })),
    ...methods.filter(row => (row.method === "provider" || row.method === "unknown")
      && [row.postedChargeOrderCount, row.postedNegativeEventCount, row.grossMinor, row.negativeMinor, row.netMinor].some(value => value !== 0))
      .map(row => ({ ...row, label: "Khác — cần đối soát" })),
  ];
}

export function buildDashboardOverviewPresentationV1(
  input: DashboardPartialFinancialRuntimeHttpBodyV1,
): DashboardOverviewPresentationV1 {
  const response = DashboardPartialFinancialRuntimeHttpBodyV1Schema.parse(input);
  const partial = presentDashboardPartialFinancialV1(
    response.data,
    response.factorBinding,
    { enabled: true },
  );
  if (!partial.enabled) throw new Error("canonical Overview presentation is disabled");

  const factors = factorMap(response.factorBinding.factors);
  const operational = partial.operational;
  const aiPending = operational?.reportMerchantAiReviewQueue;
  const inventory = operational?.selectedReportStoresInventory;
  const catalog = operational?.reportMerchantCatalog;
  const customers = operational?.reportMerchantCustomerAcquisition;

  return {
    navigationLabel: "Tổng quan",
    datePresets: [...DASHBOARD_OVERVIEW_DATE_PRESETS_V1],
    sectionOrder: [...DASHBOARD_OVERVIEW_SECTION_ORDER_V1],
    context: {
      merchantId: response.context.normalizedScope.merchantId,
      storeIds: [...response.context.normalizedScope.storeIds],
      localDateRange: { ...response.context.localDateRange },
      storeTimeWindows: response.context.storeTimeWindows.map((window) => ({ ...window })),
      reportAsOf: response.context.reportAsOf,
      generatedAt: response.context.generatedAt,
      freshnessStatus: response.context.freshness.databaseSnapshot.status,
    },
    factorCensus: response.factorBinding.factors.map((entry) => ({
      factorId: entry.factorId,
      status: entry.runtimeStatus,
      reason: entry.runtimeReason,
      dataQualityStatus: entry.runtimeDataQualityStatus,
      targetScope: entry.targetScope,
      currencyBehavior: entry.currencyBehavior,
      targetSources: [...entry.targetSources],
      timeBasis: [...entry.timeBasis],
    })),
    sharedMetricCards: {
      publishedSkuCount: countValue(
        factors,
        "published_sku_count",
        catalog?.status === "available" ? catalog.publishedSkuCount : undefined,
      ),
      newCustomerCount: countValue(
        factors,
        "new_customer_count",
        customers?.status === "available" ? customers.newCustomerCount : undefined,
      ),
    },
    sharedOwnerInsight: {
      rows: [((): DashboardOverviewInsightRowV1 => {
        const base = { id: "sold_item_quantity", label: "Số sản phẩm đã bán", unit: "item_count" as const };
        let total = 0;
        for (const currency of partial.currencies) {
          if (currency.commercial.status !== "available" || currency.commercial.effectiveItemQuantity === undefined) {
            return { ...base, status: "unavailable", reason: "Chưa có dữ liệu số lượng sản phẩm hiệu lực." };
          }
          total += currency.commercial.effectiveItemQuantity;
          if (!Number.isSafeInteger(total)) {
            return { ...base, status: "unavailable", reason: "Tổng số lượng vượt giới hạn số nguyên an toàn." };
          }
        }
        return { ...base, ...countValue(factors, "effective_item_quantity", total) };
      })()],
    },
    currencyBlocks: partial.currencies.map((currency) => {
      const coverage = response.data.currencies.find(entry => entry.currencyCode === currency.currencyCode)?.accountingProfitCoverage;
      const commercial = currency.commercial.status === "available"
        ? currency.commercial
        : undefined;
      const accounting = currency.accounting?.status === "available"
        ? currency.accounting
        : undefined;
      const currentHeadline = currency.headlines.find(
        (headline) => headline.key === "current_order_value",
      );
      const activeAndCancelled = currency.validOrderCount
        + (commercial?.cancelledOrderCohortCount ?? 0);
      const cancellationRate = activeAndCancelled > 0
        ? oneDecimal(((commercial?.cancelledOrderCohortCount ?? 0) / activeAndCancelled) * 100)
        : null;
      const itemsPerOrder = currency.validOrderCount > 0
        ? oneDecimal((commercial?.effectiveItemQuantity ?? 0) / currency.validOrderCount)
        : null;

      const dailyValueFactor = factor(factors, "daily_order_value_and_collection_series");
      const dailyCountFactor = factor(factors, "daily_active_order_count_series");
      const dailyChart = (
        dailyValueFactor.runtimeStatus === "available"
        && dailyCountFactor.runtimeStatus === "available"
        && currency.dailySeries
      )
        ? {
            status: "available" as const,
            empty: currency.dailySeries.every((point) => (
              point.activeOrderCount === 0
              && point.currentOrderGrossValueMinor === 0
              && point.recordedGrossCollectionsMinor === 0
            )),
            points: currency.dailySeries.map((point) => ({ ...point })),
          }
        : unavailableFor(
            factors,
            dailyValueFactor.runtimeStatus === "unavailable"
              ? "daily_order_value_and_collection_series"
              : "daily_active_order_count_series",
          );

      const topProductFactor = factor(factors, "top_product_gross_sales");
      const topProducts = topProductFactor.runtimeStatus === "available" && commercial
        ? {
            status: "available" as const,
            empty: (commercial.topProducts?.length ?? 0) === 0,
            items: (commercial.topProducts ?? []).map((product) => ({
              productId: product.productId,
              variantId: product.variantId,
              skuSnapshot: product.skuSnapshot,
              titleSnapshot: product.titleSnapshot,
              archivedVariant: product.archivedVariant,
              quantity: product.quantity,
              grossLineSalesBeforeDiscountMinor: product.grossLineSalesBeforeDiscountMinor,
              basisLabel: "Doanh số gộp trước discount" as const,
            })),
          }
        : unavailableFor(factors, "top_product_gross_sales");
      const bestProduct = topProducts.status === "available" ? topProducts.items[0] : undefined;
      const narrativeFactor = factor(factors, "top_product_narrative");
      const topProductNarrative = narrativeFactor.runtimeStatus === "available"
        ? {
            status: "available" as const,
            empty: !bestProduct,
            text: bestProduct
              ? `${bestProduct.titleSnapshot} dẫn đầu theo doanh số gộp trước discount trong khối ${currency.currencyCode}.`
              : "Chưa có sản phẩm bán ra trong khoảng thời gian này.",
          }
        : unavailableFor(factors, "top_product_narrative");

      const paymentAmountFactor = factor(factors, "payment_method_amount");
      const paymentCountFactor = factor(factors, "payment_method_order_count");
      const paymentMix = (
        paymentAmountFactor.runtimeStatus === "available"
        && paymentCountFactor.runtimeStatus === "available"
      )
        ? {
            status: "available" as const,
            empty: currency.paymentMethods.length === 0,
            items: densePaymentMethods(currency.paymentMethods),
          }
        : unavailableFor(
            factors,
            paymentAmountFactor.runtimeStatus === "unavailable"
              ? "payment_method_amount"
              : "payment_method_order_count",
          );

      return {
        currencyCode: currency.currencyCode,
        minorUnitExponent: currency.minorUnitExponent,
        metricCards: [
          moneyCard(
            factors,
            "current_order_value_and_recorded_collection",
            "current_order_value",
            "Giá trị đơn hàng hiện tại",
            currentHeadline?.valueMinor,
          ),
          moneyCard(
            factors,
            "current_shipping_value",
            "current_shipping_value",
            "Giá trị vận chuyển hiện tại chưa VAT",
            commercial?.currentShippingRevenueExVatMinor,
          ),
          moneyCard(
            factors,
            "average_current_order_value",
            "average_current_order_value",
            "Giá trị đơn trung bình hiện tại",
            commercial?.averageCurrentOrderValueMinor,
            "Giá trị đơn trung bình không khả dụng vì kỳ đã chọn không có đơn hiệu lực.",
          ),
          coverage?.status === "partial"
            ? { id: "accounting_gross_profit", label: "Lợi nhuận xác minh được", status: "available" as const,
                valueMinor: coverage.verifiedSubsetGrossProfitMinor,
                coverage: { covered: coverage.coveredJournalCount, total: coverage.totalJournalCount, excluded: coverage.excludedJournalCount } }
            : coverage?.status === "exact"
              ? { id: "accounting_gross_profit", label: "Lợi nhuận gộp kế toán", status: "available" as const,
                  valueMinor: coverage.exactGrossProfitMinor }
              : moneyCard(factors, "current_gross_profit", "accounting_gross_profit", "Lợi nhuận gộp kế toán", accounting?.grossProfitMinor),
        ],
        dailyChart,
        ownerInsight: {
          rows: [
            insight(
              factors,
              "gross_margin_percent",
              "Biên lợi nhuận gộp kế toán",
              accounting?.grossMarginPercent,
              "percent",
              "Biên lợi nhuận gộp không khả dụng vì doanh thu kế toán không dương.",
            ),
            insight(
              factors,
              "cancellation_rate",
              "Tỷ lệ hủy đơn",
              cancellationRate,
              "percent",
              "Tỷ lệ hủy đơn không khả dụng vì kỳ đã chọn không có cohort đơn.",
            ),
            insight(
              factors,
              "items_per_order",
              "Sản phẩm / đơn",
              itemsPerOrder,
              "ratio",
              "Sản phẩm trên đơn không khả dụng vì kỳ đã chọn không có đơn hiệu lực.",
            ),
            insight(
              factors,
              "orders_with_shipping_count",
              "Đơn có phí vận chuyển",
              commercial?.activeOrdersWithShippingCount,
              "count",
            ),
            insight(
              factors,
              "shipping_share_percent",
              "Tỷ trọng phí vận chuyển",
              commercial?.currentShippingSharePercent,
              "percent",
              "Tỷ trọng vận chuyển không khả dụng vì tổng giá trị đơn bằng 0.",
            ),
          ],
        },
        topProducts,
        topProductNarrative,
        paymentMix,
      };
    }),
    operationalRisk: {
      aiPending: countValue(
        factors,
        "ai_pending_count",
        aiPending?.status === "available"
          ? aiPending.pendingOrReviewRequiredCount
          : undefined,
      ),
      lowStock: countValue(
        factors,
        "low_stock_count",
        inventory?.status === "available"
          ? inventory.lowStockVariantLocationCount
          : undefined,
      ),
      outOfStock: countValue(
        factors,
        "out_of_stock_count",
        inventory?.status === "available"
          ? inventory.outOfStockVariantLocationCount
          : undefined,
      ),
    },
  };
}
