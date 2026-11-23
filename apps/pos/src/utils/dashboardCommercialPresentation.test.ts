import { describe, expect, it } from "vitest";
import type { DashboardCommercialCurrencyV1 } from "@medusa-snus/contracts";
import { buildDashboardCommercialPresentation } from "./dashboardCommercialPresentation";

function currencyFixture(): DashboardCommercialCurrencyV1 {
  return {
    currencyCode: "VND",
    minorUnitExponent: 0,
    validOrderCount: 2,
    cancelledOrderCohortCount: 1,
    activeOrdersWithShippingCount: 1,
    currentOrderGrossValueMinor: 430,
    currentMerchandiseGrossValueMinor: 400,
    currentDiscountMinor: 30,
    currentMerchandiseRevenueExVatMinor: 370,
    currentShippingRevenueExVatMinor: 20,
    currentShippingGrossValueMinor: 20,
    currentShippingSharePercent: 4.7,
    currentVatMinor: 39,
    currentUnclassifiedMinor: 1,
    effectiveItemQuantity: 4,
    averageCurrentOrderValueMinor: 215,
    currentCogsMinor: null,
    currentMerchandiseGrossProfitMinor: null,
    currentContributionBeforeShippingCostMinor: null,
    costCoverage: { knownLines: 2, totalLines: 3 },
    dataQuality: {
      status: "partial",
      costCoverage: { knownLines: 2, totalLines: 3 },
      warnings: ["historical_cost_evidence_incomplete"],
    },
    topProducts: [{
      productId: "product-a",
      variantId: "variant-a",
      skuSnapshot: "SKU-A",
      titleSnapshot: "Product A",
      archivedVariant: false,
      quantity: 3,
      grossLineSalesBeforeDiscountMinor: 300,
      currentCogsMinor: null,
      costCoverage: { knownLines: 1, totalLines: 2 },
    }],
  };
}

describe("DASH-01 commercial dashboard presentation", () => {
  it("labels current order value as commercial, shows VAT/fees and never calls it actual collection", () => {
    const view = buildDashboardCommercialPresentation(currencyFixture());

    expect(view.heading).toContain("không phải tiền thực thu");
    expect(view.cards.find((card) => card.id === "current_order_gross_value")).toMatchObject({
      label: "Tổng giá trị đơn hiện hành (gồm VAT/phí)",
      valueMinor: 430,
      availability: "available",
    });
    expect(view.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "current_vat", valueMinor: 39 }),
      expect.objectContaining({ id: "current_shipping_ex_vat", valueMinor: 20 }),
      expect.objectContaining({ id: "current_unclassified", valueMinor: 1 }),
    ]));
    expect(view.componentEquation).toEqual({
      merchandiseRevenueExVatMinor: 370,
      shippingRevenueExVatMinor: 20,
      vatMinor: 39,
      unclassifiedMinor: 1,
      totalMinor: 430,
      reconciled: true,
    });
    expect(view.cards.map((card) => card.label).join(" ")).not.toMatch(/thực thu|tổng tiền vào/i);
  });

  it("renders missing cost/profit as unavailable instead of a false zero", () => {
    const view = buildDashboardCommercialPresentation(currencyFixture());

    expect(view.cards.find((card) => card.id === "current_cogs")).toMatchObject({
      valueMinor: null,
      availability: "unavailable",
    });
    expect(view.cards.find((card) => card.id === "current_merchandise_gross_profit"))
      .toMatchObject({ valueMinor: null, availability: "unavailable" });
    expect(view.topProducts[0]).toMatchObject({
      basisLabel: "Doanh số gộp trước discount",
      grossLineSalesBeforeDiscountMinor: 300,
      currentCogsMinor: null,
      costAvailability: "unavailable",
    });
  });
});
