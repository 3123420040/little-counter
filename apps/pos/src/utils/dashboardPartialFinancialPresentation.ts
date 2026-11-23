import {
  DashboardMetricRuntimeBindingV1Schema,
  type DashboardMetricRuntimeBindingV1,
  type DashboardOperationalSnapshotV1,
  type DashboardPartialFinancialModelV1,
} from "@medusa-snus/contracts";

export const DASHBOARD_PARTIAL_FINANCIAL_PRESENTATION_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: true,
});

type BreakdownItemV1 = {
  key: "vat_total" | "vat_included" | "vat_added" | "shipping" | "other";
  label: string;
  valueMinor: number;
};

export type DashboardPartialFinancialPresentationResultV1 =
  | { enabled: false; status: "disabled" }
  | {
      enabled: true;
      factorStates: Array<{
        factorId: string;
        status: "available" | "unavailable";
        reason: string;
        targetSources: string[];
        formula: string;
        targetScope: "report_merchant" | "selected_report_stores";
        timeBasis: string[];
        currencyBehavior:
          | "independent_currency_blocks"
          | "not_monetary"
          | "per_currency_ratio";
        freshnessBehavior: string;
        dataQualityBehavior: string;
        runtimeDataQualityStatus: "complete" | "partial" | "unavailable";
      }>;
      operational?: DashboardOperationalSnapshotV1;
      dailyActiveOrderCountSeries?: Array<{
        localDate: string;
        activeOrderCount: number;
      }>;
      currencies: Array<{
        currencyCode: string;
        minorUnitExponent: number;
        validOrderCount: number;
        dailySeries?: Array<{
          localDate: string;
          activeOrderCount: number;
          currentOrderGrossValueMinor: number;
          recordedGrossCollectionsMinor: number;
        }>;
        commercial: {
          status: "available" | "unavailable";
          cancelledOrderCohortCount?: number;
          activeOrdersWithShippingCount?: number;
          currentMerchandiseGrossValueMinor?: number;
          currentDiscountMinor?: number;
          currentMerchandiseRevenueExVatMinor?: number;
          currentShippingRevenueExVatMinor?: number;
          currentShippingGrossValueMinor?: number;
          currentShippingSharePercent?: number | null;
          currentVatMinor?: number;
          currentUnclassifiedMinor?: number;
          effectiveItemQuantity?: number;
          averageCurrentOrderValueMinor?: number | null;
          currentCogsMinor?: number | null;
          currentMerchandiseGrossProfitMinor?: number | null;
          currentContributionBeforeShippingCostMinor?: number | null;
          topProducts?: Array<{
            productId: string | null;
            variantId: string | null;
            skuSnapshot: string;
            titleSnapshot: string;
            archivedVariant: boolean;
            quantity: number;
            grossLineSalesBeforeDiscountMinor: number;
            currentCogsMinor: number | null;
          }>;
        };
        accounting?: {
          status: "available" | "unavailable";
          postedJournalCount?: number;
          revenueExcludingVatMinor?: number;
          cogsRecognizedMinor?: number;
          grossProfitMinor?: number;
          grossMarginPercent?: number | null;
          issues?: string[];
        };
        headlines: Array<{
          key: "current_order_value" | "recorded_gross_collection" | "actual_refunds"
            | "net_collection" | "customer_refund_payable";
          label: string;
          valueMinor: number;
          help: string;
        }>;
        collectionStateLabel: string | null;
        collectionBreakdown: BreakdownItemV1[] | null;
        paymentMethods: Array<{
          method: string;
          postedChargeOrderCount: number;
          postedNegativeEventCount: number;
          grossMinor: number;
          negativeMinor: number;
          netMinor: number;
        }>;
        unavailable: {
          label: string;
          metricKeys: string[];
        };
      }>;
    };

function safeMinor(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} is invalid`);
  }
  return Number(value);
}

function signedMinor(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} is invalid`);
  return Number(value);
}

export function presentDashboardPartialFinancialV1(
  model: DashboardPartialFinancialModelV1,
  factorBinding: DashboardMetricRuntimeBindingV1,
  config: { enabled: boolean } = DASHBOARD_PARTIAL_FINANCIAL_PRESENTATION_DEFAULT_CONFIG_V1,
): DashboardPartialFinancialPresentationResultV1 {
  if (config.enabled !== true) return { enabled: false, status: "disabled" };
  if (
    model.schemaVersion !== 1
    || !["partial_dec_01_029_blocked", "complete_payment_payable_v1"].includes(model.completeness)
    || model.aggregateReadSource !== "app.payment_events"
    || !Array.isArray(model.currencies)
  ) {
    throw new Error("partial financial presentation model is invalid");
  }
  const parsedBinding = DashboardMetricRuntimeBindingV1Schema.safeParse(factorBinding);
  if (!parsedBinding.success) {
    throw new Error("dashboard factor runtime binding is invalid");
  }
  return {
    enabled: true,
    factorStates: parsedBinding.data.factors.map((factor) => ({
      factorId: factor.factorId,
      status: factor.runtimeStatus,
      reason: factor.runtimeReason,
      targetSources: [...factor.targetSources],
      formula: factor.formula,
      targetScope: factor.targetScope,
      timeBasis: [...factor.timeBasis],
      currencyBehavior: factor.currencyBehavior,
      freshnessBehavior: factor.freshnessBehavior,
      dataQualityBehavior: factor.dataQualityBehavior,
      runtimeDataQualityStatus: factor.runtimeDataQualityStatus,
    })),
    ...(model.operationalSnapshot
      ? { operational: structuredClone(model.operationalSnapshot) }
      : {}),
    ...(model.dailyActiveOrderCountSeries
      ? {
          dailyActiveOrderCountSeries: model.dailyActiveOrderCountSeries.map((point) => ({
            localDate: point.localDate,
            activeOrderCount: safeMinor(point.activeOrderCount, "activeOrderCount"),
          })),
        }
      : {}),
    currencies: model.currencies.map((currency) => {
      const currentOrderValue = safeMinor(
        currency.currentOrder.currentOrderGrossValueMinor,
        "currentOrderGrossValueMinor",
      );
      const recordedGross = safeMinor(
        currency.recordedCollection.recordedGrossCollectionsMinor,
        "recordedGrossCollectionsMinor",
      );
      const components = currency.recordedCollection.components;
      const paymentFlow = currency.paymentFlow;
      const commercial = currency.currentOrder.commercialMetrics;
      const accounting = currency.accounting;
      const dailySeries = model.dailyActiveOrderCountSeries
        ? model.dailyActiveOrderCountSeries.map((activePoint, index) => {
            const currentPoint = currency.dailyCurrentOrderGrossValueSeries?.[index];
            const collectionPoint = currency.dailyRecordedGrossCollectionsSeries?.[index];
            if (
              !currentPoint
              || !collectionPoint
              || currentPoint.localDate !== activePoint.localDate
              || collectionPoint.localDate !== activePoint.localDate
            ) {
              throw new Error("partial financial daily presentation labels are invalid");
            }
            return {
              localDate: activePoint.localDate,
              activeOrderCount: safeMinor(
                activePoint.activeOrderCount,
                "activeOrderCount",
              ),
              currentOrderGrossValueMinor: safeMinor(
                currentPoint.currentOrderGrossValueMinor,
                "dailyCurrentOrderGrossValueMinor",
              ),
              recordedGrossCollectionsMinor: safeMinor(
                collectionPoint.recordedGrossCollectionsMinor,
                "dailyRecordedGrossCollectionsMinor",
              ),
            };
          })
        : undefined;
      const collectionBreakdown: BreakdownItemV1[] | null = components
        ? [
            {
              key: "vat_total",
              label: "VAT trong khoản đã thu",
              valueMinor: signedMinor(components.vatMinor, "vatMinor"),
            },
            {
              key: "vat_included",
              label: "VAT đã nằm trong giá",
              valueMinor: signedMinor(components.vatIncludedInPriceMinor, "vatIncludedInPriceMinor"),
            },
            {
              key: "vat_added",
              label: "VAT được cộng thêm",
              valueMinor: signedMinor(components.vatAddedToPriceMinor, "vatAddedToPriceMinor"),
            },
            {
              key: "shipping",
              label: "Phí giao hàng đã tính",
              valueMinor: signedMinor(components.shippingMinor, "shippingMinor"),
            },
            {
              key: "other",
              label: "Khoản thu khác chưa phân loại",
              valueMinor: signedMinor(components.unclassifiedMinor, "unclassifiedMinor"),
            },
          ]
        : null;
      return {
        currencyCode: currency.currencyCode,
        minorUnitExponent: currency.minorUnitExponent,
        validOrderCount: currency.currentOrder.validOrderCount,
        ...(dailySeries ? { dailySeries } : {}),
        commercial: commercial ? {
          status: "available" as const,
          cancelledOrderCohortCount: commercial.cancelledOrderCohortCount,
          activeOrdersWithShippingCount: commercial.activeOrdersWithShippingCount,
          currentMerchandiseGrossValueMinor: commercial.currentMerchandiseGrossValueMinor,
          currentDiscountMinor: commercial.currentDiscountMinor,
          currentMerchandiseRevenueExVatMinor: commercial.currentMerchandiseRevenueExVatMinor,
          currentShippingRevenueExVatMinor: commercial.currentShippingRevenueExVatMinor,
          currentShippingGrossValueMinor: commercial.currentShippingGrossValueMinor,
          currentShippingSharePercent: commercial.currentShippingSharePercent,
          currentVatMinor: currency.currentOrder.currentVatMinor,
          currentUnclassifiedMinor: currency.currentOrder.currentUnclassifiedMinor,
          effectiveItemQuantity: commercial.effectiveItemQuantity,
          averageCurrentOrderValueMinor: commercial.averageCurrentOrderValueMinor,
          currentCogsMinor: commercial.currentCogsMinor,
          currentMerchandiseGrossProfitMinor: commercial.currentMerchandiseGrossProfitMinor,
          currentContributionBeforeShippingCostMinor: commercial.currentContributionBeforeShippingCostMinor,
          topProducts: commercial.topProducts.map((product) => ({
            productId: product.productId,
            variantId: product.variantId,
            skuSnapshot: product.skuSnapshot,
            titleSnapshot: product.titleSnapshot,
            archivedVariant: product.archivedVariant,
            quantity: product.quantity,
            grossLineSalesBeforeDiscountMinor: product.grossLineSalesBeforeDiscountMinor,
            currentCogsMinor: product.currentCogsMinor,
          })),
        } : { status: "unavailable" as const },
        ...(accounting
          ? {
              accounting: accounting.status === "available"
                ? {
                    status: "available" as const,
                    postedJournalCount: safeMinor(
                      accounting.postedJournalCount,
                      "accountingPostedJournalCount",
                    ),
                    revenueExcludingVatMinor: signedMinor(
                      accounting.revenueExcludingVatMinor,
                      "accountingRevenueExcludingVatMinor",
                    ),
                    cogsRecognizedMinor: signedMinor(
                      accounting.cogsRecognizedMinor,
                      "accountingCogsRecognizedMinor",
                    ),
                    grossProfitMinor: signedMinor(
                      accounting.grossProfitMinor,
                      "accountingGrossProfitMinor",
                    ),
                    grossMarginPercent: accounting.grossMarginPercent,
                  }
                : {
                    status: "unavailable" as const,
                    issues: [...accounting.issues],
                  },
            }
          : {}),
        headlines: [
          {
            key: "current_order_value" as const,
            label: "Giá trị đơn hàng hiện tại",
            valueMinor: currentOrderValue,
            help: "Giá trị thương mại mới nhất của các đơn trong kỳ, không phải số tiền đã thu.",
          },
          {
            key: "recorded_gross_collection" as const,
            label: "Tổng tiền đã ghi nhận thu (gồm VAT và các khoản tính thêm)",
            valueMinor: recordedGross,
            help: "Tổng các khoản thu đã được ghi nhận hoàn tất theo thời điểm thanh toán; không cộng lại VAT, phí hoặc bản ghi tương thích cũ.",
          },
          ...(paymentFlow ? [
            {
              key: "actual_refunds" as const,
              label: "Tiền đã hoàn thực tế",
              valueMinor: safeMinor(paymentFlow.refundsMinor, "refundsMinor"),
              help: "Chỉ gồm payout hoàn tiền đã có bằng chứng và đã phân bổ vào khoản thu gốc.",
            },
            {
              key: "net_collection" as const,
              label: "Tiền thu ròng thực tế",
              valueMinor: signedMinor(paymentFlow.netCollectionsMinor, "netCollectionsMinor"),
              help: "Tổng tiền đã thu trừ refund, reversal và chargeback đã ghi nhận trong kỳ.",
            },
            {
              key: "customer_refund_payable" as const,
              label: "Còn phải hoàn khách tại thời điểm báo cáo",
              valueMinor: safeMinor(
                paymentFlow.customerRefundPayableAsOfMinor,
                "customerRefundPayableAsOfMinor",
              ),
              help: "Số dư nghĩa vụ hoàn khách append-only tại reportAsOf; chưa coi là đã chi tiền.",
            },
          ] : []),
        ],
        collectionStateLabel: currency.recordedCollection.status === "none_in_selected_window"
          ? "Chưa có khoản thu đã ghi nhận trong kỳ đã chọn"
          : null,
        collectionBreakdown,
        paymentMethods: (paymentFlow?.methods || []).map((method) => ({
          method: method.method,
          postedChargeOrderCount: method.postedChargeOrderCount,
          postedNegativeEventCount: method.postedNegativeEventCount,
          grossMinor: method.recordedGrossCollectionsMinor,
          negativeMinor: method.recordedNegativeCollectionsMinor,
          netMinor: method.recordedNetCollectionsMinor,
        })),
        unavailable: {
          label: currency.unavailableMetrics.length > 0
            ? "Các chỉ số kế toán/đối soát chưa đủ bằng chứng vẫn được ẩn thay vì hiển thị 0"
            : "Toàn bộ chỉ số trong khối này đã có bằng chứng",
          metricKeys: [...currency.unavailableMetrics],
        },
      };
    }),
  };
}
