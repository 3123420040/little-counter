import {
  DashboardCommercialCurrencyV1Schema,
  type DashboardCommercialCurrencyV1,
} from "@medusa-snus/contracts";

export type CommercialCardAvailability = "available" | "unavailable";

export interface CommercialMoneyCard {
  id:
    | "current_order_gross_value"
    | "current_merchandise_gross"
    | "current_discount"
    | "current_merchandise_ex_vat"
    | "current_shipping_ex_vat"
    | "current_vat"
    | "current_unclassified"
    | "current_cogs"
    | "current_merchandise_gross_profit"
    | "current_contribution_before_shipping_cost";
  label: string;
  valueMinor: number | null;
  availability: CommercialCardAvailability;
}

export interface DashboardCommercialPresentation {
  currencyCode: string;
  minorUnitExponent: number;
  heading: string;
  orderSummary: {
    validOrderCount: number;
    cancelledOrderCohortCount: number;
    effectiveItemQuantity: number;
    averageCurrentOrderValueMinor: number | null;
  };
  componentEquation: {
    merchandiseRevenueExVatMinor: number;
    shippingRevenueExVatMinor: number;
    vatMinor: number;
    unclassifiedMinor: number;
    totalMinor: number;
    reconciled: boolean;
  };
  cards: CommercialMoneyCard[];
  topProducts: Array<{
    productId: string | null;
    variantId: string | null;
    skuSnapshot: string;
    titleSnapshot: string;
    archivedVariant: boolean;
    quantity: number;
    basisLabel: "Doanh số gộp trước discount";
    grossLineSalesBeforeDiscountMinor: number;
    currentCogsMinor: number | null;
    costAvailability: CommercialCardAvailability;
  }>;
  dataQuality: DashboardCommercialCurrencyV1["dataQuality"];
}

function moneyCard(
  id: CommercialMoneyCard["id"],
  label: string,
  valueMinor: number | null,
): CommercialMoneyCard {
  return {
    id,
    label,
    valueMinor,
    availability: valueMinor === null ? "unavailable" : "available",
  };
}

export function buildDashboardCommercialPresentation(
  input: DashboardCommercialCurrencyV1,
): DashboardCommercialPresentation {
  const currency = DashboardCommercialCurrencyV1Schema.parse(input);
  const componentTotal = currency.currentMerchandiseRevenueExVatMinor
    + currency.currentShippingRevenueExVatMinor
    + currency.currentVatMinor
    + currency.currentUnclassifiedMinor;

  return {
    currencyCode: currency.currencyCode,
    minorUnitExponent: currency.minorUnitExponent,
    heading: "Giá trị đơn hiện hành — không phải tiền thực thu",
    orderSummary: {
      validOrderCount: currency.validOrderCount,
      cancelledOrderCohortCount: currency.cancelledOrderCohortCount,
      effectiveItemQuantity: currency.effectiveItemQuantity,
      averageCurrentOrderValueMinor: currency.averageCurrentOrderValueMinor,
    },
    componentEquation: {
      merchandiseRevenueExVatMinor: currency.currentMerchandiseRevenueExVatMinor,
      shippingRevenueExVatMinor: currency.currentShippingRevenueExVatMinor,
      vatMinor: currency.currentVatMinor,
      unclassifiedMinor: currency.currentUnclassifiedMinor,
      totalMinor: currency.currentOrderGrossValueMinor,
      reconciled: componentTotal === currency.currentOrderGrossValueMinor,
    },
    cards: [
      moneyCard(
        "current_order_gross_value",
        "Tổng giá trị đơn hiện hành (gồm VAT/phí)",
        currency.currentOrderGrossValueMinor,
      ),
      moneyCard(
        "current_merchandise_gross",
        "Giá hàng trước discount",
        currency.currentMerchandiseGrossValueMinor,
      ),
      moneyCard("current_discount", "Discount hiện hành", currency.currentDiscountMinor),
      moneyCard(
        "current_merchandise_ex_vat",
        "Giá trị hàng hóa chưa VAT",
        currency.currentMerchandiseRevenueExVatMinor,
      ),
      moneyCard(
        "current_shipping_ex_vat",
        "Vận chuyển chưa VAT",
        currency.currentShippingRevenueExVatMinor,
      ),
      moneyCard("current_vat", "VAT trong giá trị đơn", currency.currentVatMinor),
      moneyCard(
        "current_unclassified",
        "Khoản khác chưa phân loại",
        currency.currentUnclassifiedMinor,
      ),
      moneyCard("current_cogs", "COGS hiện hành", currency.currentCogsMinor),
      moneyCard(
        "current_merchandise_gross_profit",
        "Lợi nhuận gộp hàng hóa hiện hành",
        currency.currentMerchandiseGrossProfitMinor,
      ),
      moneyCard(
        "current_contribution_before_shipping_cost",
        "Đóng góp trước chi phí vận chuyển",
        currency.currentContributionBeforeShippingCostMinor,
      ),
    ],
    topProducts: currency.topProducts.map((product) => ({
      productId: product.productId,
      variantId: product.variantId,
      skuSnapshot: product.skuSnapshot,
      titleSnapshot: product.titleSnapshot,
      archivedVariant: product.archivedVariant,
      quantity: product.quantity,
      basisLabel: "Doanh số gộp trước discount",
      grossLineSalesBeforeDiscountMinor: product.grossLineSalesBeforeDiscountMinor,
      currentCogsMinor: product.currentCogsMinor,
      costAvailability: product.currentCogsMinor === null ? "unavailable" : "available",
    })),
    dataQuality: currency.dataQuality,
  };
}
