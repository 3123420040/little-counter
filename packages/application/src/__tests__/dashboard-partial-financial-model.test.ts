import { describe, expect, it, vi } from "vitest";
import type {
  DashboardAccountingSliceV1,
  DashboardCommercialSliceV1,
  DashboardOperationalSnapshotV1,
  RecordedGrossCollectionSliceV1,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import {
  DASHBOARD_PARTIAL_FINANCIAL_DEFAULT_CONFIG_V1,
  DashboardPartialFinancialModelErrorV1,
  composeDashboardPartialFinancialModelV1,
  readDashboardPartialFinancialSnapshotV1,
} from "../services/dashboard-partial-financial-model";

const commercial: DashboardCommercialSliceV1 = {
  schemaVersion: 1,
  currencies: [{
    currencyCode: "VND",
    minorUnitExponent: 0,
    validOrderCount: 2,
    cancelledOrderCohortCount: 1,
    activeOrdersWithShippingCount: 1,
    currentOrderGrossValueMinor: 420,
    currentMerchandiseGrossValueMinor: 400,
    currentDiscountMinor: 10,
    currentMerchandiseRevenueExVatMinor: 360,
    currentShippingRevenueExVatMinor: 18,
    currentShippingGrossValueMinor: 20,
    currentShippingSharePercent: 4.8,
    currentVatMinor: 41,
    currentUnclassifiedMinor: 1,
    effectiveItemQuantity: 3,
    averageCurrentOrderValueMinor: 210,
    currentCogsMinor: null,
    currentMerchandiseGrossProfitMinor: null,
    currentContributionBeforeShippingCostMinor: null,
    costCoverage: { knownLines: 2, totalLines: 3 },
    dataQuality: {
      status: "partial",
      costCoverage: { knownLines: 2, totalLines: 3 },
      warnings: ["historical_cost_incomplete"],
    },
    topProducts: [],
  }],
};

const collections: RecordedGrossCollectionSliceV1 = {
  schemaVersion: 1,
  aggregateReadSource: "app.payment_events",
  currencies: [{
    currencyCode: "VND",
    minorUnitExponent: 0,
    postedChargeEventCount: 2,
    bundleCoverage: { validEvents: 2, totalEvents: 2 },
    recordedGrossCollectionsMinor: 253,
    components: {
      taxModes: ["exclusive", "inclusive"],
      merchandiseGrossMinor: 210,
      discountMinor: 0,
      merchandiseNetMinor: 210,
      shippingMinor: 31,
      merchandiseVatMinor: 20,
      shippingVatMinor: 3,
      vatMinor: 23,
      vatIncludedInPriceMinor: 11,
      vatAddedToPriceMinor: 12,
      unclassifiedMinor: 0,
      totalMinor: 253,
    },
  }],
};

const operationalSnapshot: DashboardOperationalSnapshotV1 = {
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

const accounting: DashboardAccountingSliceV1 = {
  schemaVersion: 1,
  aggregateReadSource: "accounting.journal_entries",
  currencies: [{
    currencyCode: "VND",
    minorUnitExponent: 0,
    status: "available",
    dataQualityStatus: "complete",
    postedJournalCount: 2,
    revenueExcludingVatMinor: 1_000,
    cogsRecognizedMinor: 600,
    grossProfitMinor: 400,
    grossMarginPercent: 40,
  }],
};

describe("DASH-COMBINE-01 inactive partial financial model", () => {
  it("is frozen default-on and retains an explicit disabled seam", () => {
    expect(DASHBOARD_PARTIAL_FINANCIAL_DEFAULT_CONFIG_V1).toEqual({ enabled: true });
    expect(Object.isFrozen(DASHBOARD_PARTIAL_FINANCIAL_DEFAULT_CONFIG_V1)).toBe(true);
    expect(composeDashboardPartialFinancialModelV1(
      {} as never,
      {} as never,
      { enabled: false },
    )).toEqual({ enabled: false, status: "disabled" });
  });

  it("keeps current order value and recorded customer collection as separate headlines", () => {
    expect(composeDashboardPartialFinancialModelV1(
      commercial,
      collections,
      { enabled: true },
    )).toEqual({
      enabled: true,
      data: {
        schemaVersion: 1,
        completeness: "complete_payment_payable_v1",
        aggregateReadSource: "app.payment_events",
        currencies: [{
          currencyCode: "VND",
          minorUnitExponent: 0,
          currentOrder: {
            validOrderCount: 2,
            currentOrderGrossValueMinor: 420,
            currentVatMinor: 41,
            currentUnclassifiedMinor: 1,
            dataQualityStatus: "partial",
            commercialMetrics: {
              cancelledOrderCohortCount: 1,
              activeOrdersWithShippingCount: 1,
              currentMerchandiseGrossValueMinor: 400,
              currentDiscountMinor: 10,
              currentMerchandiseRevenueExVatMinor: 360,
              currentShippingRevenueExVatMinor: 18,
              currentShippingGrossValueMinor: 20,
              currentShippingSharePercent: 4.8,
              effectiveItemQuantity: 3,
              averageCurrentOrderValueMinor: 210,
              currentCogsMinor: null,
              currentMerchandiseGrossProfitMinor: null,
              currentContributionBeforeShippingCostMinor: null,
              topProducts: [],
            },
          },
          recordedCollection: {
            status: "available",
            postedChargeEventCount: 2,
            recordedGrossCollectionsMinor: 253,
            components: collections.currencies[0]!.components,
          },
          recordedCollectionMinusCurrentOrderValueMinor: -167,
          paymentFlow: {
            postedRefundEventCount: 0,
            refundsMinor: 0,
            postedReversalEventCount: 0,
            reversalsMinor: 0,
            postedChargebackEventCount: 0,
            chargebacksMinor: 0,
            negativeCollectionsMinor: 0,
            netCollectionsMinor: 253,
            customerRefundPayableAsOfMinor: 0,
            methods: [],
          },
          unavailableMetrics: [
            "commercialOutstandingAsOfMinor",
            "revenueExcludingVatMinor",
            "vatLiabilityMinor",
            "cogsRecognizedMinor",
            "providerFeesMinor",
            "netProviderPayoutMinor",
          ],
        }],
      },
    });
  });

  it("serializes the exact operational snapshot without moving it into a currency block", () => {
    const result = composeDashboardPartialFinancialModelV1(
      commercial,
      collections,
      { enabled: true },
      [],
      operationalSnapshot,
    );
    if (!result.enabled) throw new Error("expected enabled model");

    expect(result.data.operationalSnapshot).toEqual(operationalSnapshot);
    expect(result.data.currencies[0]).not.toHaveProperty("operationalSnapshot");
  });

  it("attaches accounting-backed profit and removes only proven accounting metrics from unavailable", () => {
    const result = composeDashboardPartialFinancialModelV1(
      commercial,
      collections,
      { enabled: true },
      [],
      operationalSnapshot,
      accounting,
    );
    if (!result.enabled) throw new Error("expected enabled model");

    expect(result.data.currencies[0]!.accounting).toEqual(
      accounting.currencies[0],
    );
    expect(result.data.currencies[0]!.unavailableMetrics).toEqual([
      "commercialOutstandingAsOfMinor",
      "vatLiabilityMinor",
      "providerFeesMinor",
      "netProviderPayoutMinor",
    ]);
    expect(result.data.currencies[0]!.unavailableMetrics)
      .not.toContain("revenueExcludingVatMinor");
    expect(result.data.currencies[0]!.unavailableMetrics)
      .not.toContain("cogsRecognizedMinor");
  });

  it("combines zero-filled active-order, current-order and collection daily series", () => {
    const dailyCommercial = structuredClone(commercial) as unknown as Record<string, unknown>;
    Object.assign(dailyCommercial, {
      dailyActiveOrderCountSeries: [
        { localDate: "2026-08-04", activeOrderCount: 0 },
        { localDate: "2026-08-05", activeOrderCount: 2 },
      ],
    });
    Object.assign((dailyCommercial.currencies as Array<Record<string, unknown>>)[0]!, {
      dailyCurrentOrderGrossValueSeries: [
        { localDate: "2026-08-04", currentOrderGrossValueMinor: 0 },
        { localDate: "2026-08-05", currentOrderGrossValueMinor: 420 },
      ],
    });
    const dailyCollections = structuredClone(collections) as unknown as Record<string, unknown>;
    Object.assign((dailyCollections.currencies as Array<Record<string, unknown>>)[0]!, {
      dailyRecordedGrossCollectionsSeries: [
        { localDate: "2026-08-04", recordedGrossCollectionsMinor: 100 },
        { localDate: "2026-08-05", recordedGrossCollectionsMinor: 153 },
      ],
    });

    const result = composeDashboardPartialFinancialModelV1(
      dailyCommercial as unknown as DashboardCommercialSliceV1,
      dailyCollections as unknown as RecordedGrossCollectionSliceV1,
      { enabled: true },
    );
    if (!result.enabled) throw new Error("expected enabled model");

    expect(result.data.dailyActiveOrderCountSeries).toEqual([
      { localDate: "2026-08-04", activeOrderCount: 0 },
      { localDate: "2026-08-05", activeOrderCount: 2 },
    ]);
    expect(result.data.currencies[0]).toMatchObject({
      dailyCurrentOrderGrossValueSeries: [
        { localDate: "2026-08-04", currentOrderGrossValueMinor: 0 },
        { localDate: "2026-08-05", currentOrderGrossValueMinor: 420 },
      ],
      dailyRecordedGrossCollectionsSeries: [
        { localDate: "2026-08-04", recordedGrossCollectionsMinor: 100 },
        { localDate: "2026-08-05", recordedGrossCollectionsMinor: 153 },
      ],
    });
  });

  it("represents no posted collection as an explicit zero state without fabricated components", () => {
    const result = composeDashboardPartialFinancialModelV1(
      commercial,
      { ...collections, currencies: [] },
      { enabled: true },
    );
    if (!result.enabled) throw new Error("expected enabled model");
    expect(result.data.currencies[0]!.recordedCollection).toEqual({
      status: "none_in_selected_window",
      postedChargeEventCount: 0,
      recordedGrossCollectionsMinor: 0,
      components: null,
    });
    expect(result.data.currencies[0]!.recordedCollectionMinusCurrentOrderValueMinor).toBe(-420);
  });

  it("retains a collection-only currency without inventing current orders", () => {
    const usdCollection: RecordedGrossCollectionSliceV1 = {
      ...collections,
      currencies: [{ ...collections.currencies[0]!, currencyCode: "USD", minorUnitExponent: 2 }],
    };
    const result = composeDashboardPartialFinancialModelV1(
      { ...commercial, currencies: [] },
      usdCollection,
      { enabled: true },
    );
    if (!result.enabled) throw new Error("expected enabled model");
    expect(result.data.currencies[0]).toMatchObject({
      currencyCode: "USD",
      currentOrder: {
        validOrderCount: 0,
        currentOrderGrossValueMinor: 0,
        dataQualityStatus: "complete",
      },
      recordedCollectionMinusCurrentOrderValueMinor: 253,
    });
  });

  it("rejects currency exponent drift and does not expose blocked metrics as zero", () => {
    expect(() => composeDashboardPartialFinancialModelV1(
      commercial,
      {
        ...collections,
        currencies: [{ ...collections.currencies[0]!, minorUnitExponent: 2 }],
      },
      { enabled: true },
    )).toThrow(DashboardPartialFinancialModelErrorV1);

    const result = composeDashboardPartialFinancialModelV1(
      commercial,
      collections,
      { enabled: true },
    );
    if (!result.enabled) throw new Error("expected enabled model");
    for (const field of result.data.currencies[0]!.unavailableMetrics) {
      expect(result.data.currencies[0]).not.toHaveProperty(field);
    }
  });

  it("reads every canonical slice inside one snapshot without aggregating legacy payment entries", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      statements.push(sql.trim());
      if (sql.includes("transaction_timestamp")) {
        return { rows: [{ report_as_of: "2026-08-05T12:00:00.000Z" }] };
      }
      if (sql.includes("requested_stores")) {
        return { rows: [{
          requested_store_id: "store-a",
          owned_store_id: "store-a",
          time_zone: "UTC",
          start_inclusive: "2026-08-05T00:00:00.000Z",
          end_exclusive: "2026-08-06T00:00:00.000Z",
        }] };
      }
      if (sql.includes("cohort_orders")) return { rows: [] };
      if (sql.includes("FROM app.payment_events events")) return { rows: [] };
      if (sql.includes("selected_store_quality")) {
        return { rows: [{
          selected_store_count: 1,
          blank_stock_location_count: 0,
          ai_pending_count: 0,
          ambiguous_ai_pending_count: 0,
          new_customer_count: 0,
          published_sku_count: 0,
          inventory_grain_count: 0,
          low_stock_count: 0,
          out_of_stock_count: 0,
          missing_reorder_count: 0,
          negative_stock_count: 0,
        }] };
      }
      if (sql.includes("target_journals")) {
        return { rows: [{
          currency_code: "VND",
          minor_unit_exponent: "0",
          posted_journal_count: "0",
          balanced_journal_count: "0",
          mapped_source_count: "0",
          complete_cost_source_count: "0",
          fractional_line_count: "0",
          unsupported_reference_count: "0",
          unmapped_source_count: "0",
          merchandise_revenue_minor: "0",
          cogs_recognized_minor: "0",
        }] };
      }
      if (sql.includes("clock_timestamp")) {
        return { rows: [{ generated_at: "2026-08-05T12:00:00.250Z" }] };
      }
      return { rows: [] };
    });

    await expect(readDashboardPartialFinancialSnapshotV1(
      { query } as unknown as PoolClient,
      {
        scope: { scopeKind: "report", merchantId: "merchant-a", storeIds: ["store-a"] },
        range: { date: "2026-08-05" },
        statementTimeoutMs: 5_000,
      },
      { enabled: true },
    )).resolves.toMatchObject({
      enabled: true,
      snapshot: {
        data: {
          completeness: "complete_payment_payable_v1",
          currencies: [{
            currencyCode: "VND",
            currentOrder: { validOrderCount: 0, currentOrderGrossValueMinor: 0 },
            recordedCollection: { status: "none_in_selected_window" },
          }],
        },
      },
    });
    expect(statements.filter((sql) => sql.includes("BEGIN TRANSACTION"))).toHaveLength(1);
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    const accountingSql = statements.find((sql) => sql.includes("target_journals")) || "";
    expect(accountingSql).toContain("LEFT JOIN app.payment_entries refund_entry");
    expect(accountingSql).not.toContain("SUM(refund_entry.amount");
  });
});
