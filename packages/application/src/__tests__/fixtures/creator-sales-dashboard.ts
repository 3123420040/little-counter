import { CreatorSalesDashboardV3Schema, type CreatorSalesDashboardV3, type CreatorSalesDashboardV2 } from "@medusa-snus/contracts";

export function creatorSalesDashboardFixture(audience: "full" | "self" = "self"): CreatorSalesDashboardV2 {
  const asOf = "2026-10-18T10:00:00.000Z";
  return {
    schemaVersion: 2, audience,
    creatorSelection: { mode: "selected", creatorOperatorIds: ["staff_a"] },
    creatorOptions: [{ operatorId: "staff_a", displayName: "An", status: "active" }],
    asOf,
    context: {
      schemaVersion: 1,
      normalizedScope: { scopeKind: "report", merchantId: "merchant_a", storeIds: ["store_a"] },
      localDateRange: { from: "2026-10-18", to: "2026-10-18", inclusiveDays: 1 },
      storeTimeWindows: [{ storeId: "store_a", timeZone: "Asia/Ho_Chi_Minh", startInclusive: "2026-10-17T17:00:00.000Z", endExclusive: "2026-10-18T17:00:00.000Z" }],
      reportAsOf: asOf, generatedAt: asOf,
      freshness: { databaseSnapshot: { status: "fresh", asOf } },
    },
    operationalSnapshot: {
      schemaVersion: 1,
      reportMerchantCatalog: { status: "available", dataQualityStatus: "complete", publishedSkuCount: 245 },
      reportMerchantCustomerAcquisition: { status: "available", dataQualityStatus: "complete", attributionScope: "report_merchant", businessTimeZone: "Asia/Ho_Chi_Minh", newCustomerCount: 2 },
      reportMerchantAiReviewQueue: { status: "available", dataQualityStatus: "complete", pendingOrReviewRequiredCount: 7 },
      selectedReportStoresInventory: { status: "available", dataQualityStatus: "complete", inventoryVariantLocationCount: 291, lowStockVariantLocationCount: 19, outOfStockVariantLocationCount: 125 },
    },
    ...(audience === "full" ? { financial: {
      schemaVersion: 1, aggregateReadSource: "accounting.journal_entries" as const,
      currencies: [{ currencyCode: "VND", minorUnitExponent: 0, status: "available" as const, dataQualityStatus: "complete" as const, postedJournalCount: 1, revenueExcludingVatMinor: 1000, cogsRecognizedMinor: 600, grossProfitMinor: 400, grossMarginPercent: 40 }],
      profitCoverage: [{ currencyCode: "VND", minorUnitExponent: 0, coverage: {
        status: "exact" as const, totalJournalCount: 1, coveredJournalCount: 1, excludedJournalCount: 0,
        exactGrossProfitMinor: 400, verifiedSubsetRevenueExcludingVatMinor: 1000, verifiedSubsetCogsRecognizedMinor: 600, verifiedSubsetGrossProfitMinor: 400, issues: [],
      } }],
    } } : {}),
    currencies: [{
      currencyCode: "VND", minorUnitExponent: 0, orderCount: 3, activeOrderCount: 2,
      currentOrderGrossValueMinor: 420000, effectiveItemQuantity: 4,
      currentShippingRevenueExVatMinor: 20000, averageCurrentOrderValueMinor: 210000,
      activeOrdersWithShippingCount: 1, currentShippingSharePercent: 4.8,
      dailySeries: [{ localDate: "2026-10-18", activeOrderCount: 2, currentOrderGrossValueMinor: 420000 }],
      topProducts: [{ productId: "prod_a", variantId: "variant_a", skuSnapshot: "SKU-A", titleSnapshot: "Apple", archivedVariant: false, quantity: 4, grossLineSalesBeforeDiscountMinor: 400000 }],
      paymentMethods: [{ method: "cash", postedChargeOrderCount: 2, postedNegativeEventCount: 0, grossMinor: 420000, negativeMinor: 0, netMinor: 420000 }],
    }],
  };
}

export function creatorSalesDashboardV3Fixture(audience: "full" | "self" = "self"): CreatorSalesDashboardV3 {
  const base = creatorSalesDashboardFixture(audience);
  return CreatorSalesDashboardV3Schema.parse({ ...base, schemaVersion: 3, currencies: base.currencies.map(row => ({ ...row,
    currentPaymentFeeMinor: 100, currentPaymentFeeVatMinor: 9, currentPaymentFeeCustomerTotalMinor: 100,
    recordedGrossCollectionsMinor: 420000, recordedPaymentFeeMinor: 100, recordedPaymentFeeVatMinor: 9, recordedPaymentFeeCustomerTotalMinor: 100 })),
    ...(audience === "full" ? { feeFinancial: { currencies: [{ currencyCode: "VND", minorUnitExponent: 0,
      currentPaymentFeeRevenueExVatMinor: 91, recordedPaymentFeeRevenueExVatMinor: 91 }],
      negatives: { schemaVersion: 1, aggregateReadSource: "app.payment_events", currencies: [] },
      journals: { schemaVersion: 1, aggregateReadSource: "accounting.journal_entries", metricTimeBasis: "accounting_source_occurred_at", currencies: [{ currencyCode: "VND",
        minorUnitExponent: 0, revenueExcludingVatMinor: 91, verifiedSubsetRevenueExcludingVatMinor: 91, warnings: [],
        coverage: { status: "available", totalJournalCount: 1, coveredJournalCount: 1, excludedJournalCount: 0 } }] } } } : {}) });
}
