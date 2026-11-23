import { describe, expect, it } from "vitest";
import {
  CancellationQuoteV1Schema,
  CursorClaimsV1Schema,
  CursorRefreshErrorSchema,
  DASHBOARD_METRIC_TIME_BASIS_V2,
  DashboardAccountingSliceV1Schema,
  DashboardCommercialSliceV1Schema,
  DashboardFinancialV2Schema,
  DashboardOperationalSnapshotV1Schema,
  DashboardReportContextV1Schema,
  EffectiveOrderSurfaceV2Schema,
  EffectiveOrderV1Schema,
  LEGACY_ORDER_CSV_COMPATIBILITY,
  ORDER_API_V2_COMPATIBILITY,
  ORDER_CSV_LINE_V2_HEADERS,
  ORDER_CSV_ORDER_V2_HEADERS,
  OrderListQueryV2Schema,
  OrderCommercialComponentsV1Schema,
  PaymentCashEventV1Schema,
  RecordedGrossCollectionComponentsV1Schema,
  SUPPORTED_CURRENCY_REGISTRY_V1,
} from "../order-financial-correctness";

const completeQuality = {
  status: "complete" as const,
  costCoverage: { knownLines: 1, totalLines: 1 },
  warnings: [],
};

const dashboardMetricTimeBasis = {
  ...DASHBOARD_METRIC_TIME_BASIS_V2,
};

const dashboardReportFields = {
  generatedAt: "2026-08-04T12:00:00.000Z",
  reportAsOf: "2026-08-04T11:59:59.000Z",
  normalizedScope: {
    scopeKind: "report" as const,
    merchantId: "merchant-a",
    storeIds: ["store-a"],
  },
  localDateRange: { from: "2026-08-04", to: "2026-08-04", inclusiveDays: 1 },
  storeTimeWindows: [{
    storeId: "store-a",
    timeZone: "Asia/Ho_Chi_Minh",
    startInclusive: "2026-08-03T17:00:00.000Z",
    endExclusive: "2026-08-04T17:00:00.000Z",
  }],
  metricTimeBasis: dashboardMetricTimeBasis,
  freshness: {
    databaseSnapshot: { status: "fresh" as const, asOf: "2026-08-04T11:59:59.000Z" },
  },
};

function dashboardCurrency(currencyCode: string, minorUnitExponent: number) {
  return {
    currencyCode,
    minorUnitExponent,
    recordedGrossCollectionsMinor: 1_210,
    recordedGrossCollectionComponents: {
      taxModes: ["exclusive"] as const,
      merchandiseGrossMinor: 1_000,
      discountMinor: 0,
      merchandiseNetMinor: 1_000,
      shippingMinor: 50,
      merchandiseVatMinor: 110,
      shippingVatMinor: 0,
      vatMinor: 110,
      vatIncludedInPriceMinor: 0,
      vatAddedToPriceMinor: 110,
      unclassifiedMinor: 50,
      totalMinor: 1_210,
    },
    refundsMinor: 10,
    reversalsMinor: 20,
    chargebacksMinor: 30,
    negativeCollectionsMinor: 60,
    netCollectionsMinor: 1_150,
    currentOrderGrossValueMinor: 1_210,
    commercialOutstandingAsOfMinor: 0,
    customerRefundPayableAsOfMinor: 0,
    revenueExcludingVatMinor: 1_100,
    vatLiabilityMinor: 110,
    cogsRecognizedMinor: 600,
    dataQuality: completeQuality,
  };
}

describe("API-01 order financial correctness contracts", () => {
  it("keeps VAT attributable without double-counting VAT-inclusive collections", () => {
    const inclusive = OrderCommercialComponentsV1Schema.parse({
      taxMode: "inclusive",
      merchandiseGrossMinor: 110_000,
      discountMinor: 0,
      merchandiseNetMinor: 110_000,
      shippingMinor: 11_000,
      merchandiseVatMinor: 10_000,
      shippingVatMinor: 1_000,
      vatMinor: 11_000,
      unclassifiedMinor: 2_000,
      totalMinor: 123_000,
    });
    expect(inclusive.totalMinor).toBe(123_000);
    expect(inclusive.vatMinor).toBe(11_000);

    const exclusive = OrderCommercialComponentsV1Schema.parse({
      ...inclusive,
      taxMode: "exclusive",
      merchandiseGrossMinor: 100_000,
      merchandiseNetMinor: 100_000,
      shippingMinor: 10_000,
      totalMinor: 123_000,
    });
    expect(exclusive.totalMinor).toBe(123_000);

    expect(() => OrderCommercialComponentsV1Schema.parse({
      ...inclusive,
      totalMinor: inclusive.totalMinor + inclusive.vatMinor,
    })).toThrow();
    expect(() => OrderCommercialComponentsV1Schema.parse({
      ...inclusive,
      merchandiseVatMinor: inclusive.merchandiseVatMinor - 1,
    })).toThrow();
  });

  it("reconciles mixed inclusive/exclusive posted collections in one currency block", () => {
    expect(RecordedGrossCollectionComponentsV1Schema.parse({
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
    })).toMatchObject({
      vatMinor: 23_000,
      vatIncludedInPriceMinor: 11_000,
      vatAddedToPriceMinor: 12_000,
      totalMinor: 253_000,
    });

    for (const invalid of [
      { vatAddedToPriceMinor: 11_999 },
      { vatIncludedInPriceMinor: 10_999 },
      { totalMinor: 264_000 },
      { taxModes: ["inclusive", "exclusive"] },
    ]) {
      expect(() => RecordedGrossCollectionComponentsV1Schema.parse({
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
        ...invalid,
      })).toThrow();
    }
  });

  it("freezes the DASH-00 normalized scope, per-store clocks and snapshot freshness envelope", () => {
    const parsed = DashboardReportContextV1Schema.parse({
      schemaVersion: 1,
      normalizedScope: {
        scopeKind: "report",
        merchantId: "merchant-a",
        storeIds: ["store-ny", "store-vn"],
      },
      localDateRange: { from: "2026-03-08", to: "2026-03-08", inclusiveDays: 1 },
      storeTimeWindows: [
        {
          storeId: "store-ny",
          timeZone: "America/New_York",
          startInclusive: "2026-03-08T05:00:00.000Z",
          endExclusive: "2026-03-09T04:00:00.000Z",
        },
        {
          storeId: "store-vn",
          timeZone: "Asia/Ho_Chi_Minh",
          startInclusive: "2026-03-07T17:00:00.000Z",
          endExclusive: "2026-03-08T17:00:00.000Z",
        },
      ],
      reportAsOf: "2026-03-08T12:00:00.000Z",
      generatedAt: "2026-03-08T12:00:00.250Z",
      metricTimeBasis: dashboardMetricTimeBasis,
      freshness: {
        databaseSnapshot: { status: "fresh", asOf: "2026-03-08T12:00:00.000Z" },
      },
    });
    expect(parsed.storeTimeWindows[0].timeZone).toBe("America/New_York");
    expect(parsed.normalizedScope.storeIds).toEqual(["store-ny", "store-vn"]);

    expect(() => DashboardReportContextV1Schema.parse({
      ...parsed,
      normalizedScope: { ...parsed.normalizedScope, storeIds: ["store-vn", "store-ny"] },
    })).toThrow();
    expect(() => DashboardReportContextV1Schema.parse({
      ...parsed,
      storeTimeWindows: [parsed.storeTimeWindows[0]],
    })).toThrow();
    expect(() => DashboardReportContextV1Schema.parse({
      ...parsed,
      generatedAt: "2026-03-08T11:59:59.000Z",
    })).toThrow();
  });

  it("registers VND as the supported 1.8 write currency with zero-decimal minor units", () => {
    expect(SUPPORTED_CURRENCY_REGISTRY_V1).toEqual([
      { currencyCode: "VND", minorUnitExponent: 0, writeSupported: true },
    ]);
  });

  it("accepts an effective corrected order and rejects component ambiguity", () => {
    const effectiveOrder = {
      schemaVersion: 1,
      orderId: "ord-1",
      currencyCode: "VND",
      minorUnitExponent: 0,
      effectiveRevision: 2,
      commercialState: "active",
      lines: [{
        lineId: "line-1",
        productId: "product-1",
        variantId: "variant-1",
        skuSnapshot: "SKU-1",
        titleSnapshot: "Item",
        quantity: 1,
        unitPriceMinor: 1_000,
      }],
      components: {
        taxMode: "exclusive" as const,
        merchandiseGrossMinor: 1_000,
        discountMinor: 0,
        merchandiseNetMinor: 1_000,
        shippingMinor: 100,
        merchandiseVatMinor: 110,
        shippingVatMinor: 0,
        vatMinor: 110,
        unclassifiedMinor: 0,
        totalMinor: 1_210,
      },
      currentOrderGrossValueMinor: 1_210,
      dataQuality: completeQuality,
    };
    expect(EffectiveOrderV1Schema.parse(effectiveOrder).effectiveRevision).toBe(2);
    expect(() => EffectiveOrderV1Schema.parse({
      ...effectiveOrder,
      components: { ...effectiveOrder.components, totalMinor: 1_211 },
    })).toThrow();
    expect(() => EffectiveOrderV1Schema.parse({
      ...effectiveOrder,
      components: { ...effectiveOrder.components, vatMinor: 0.5 },
    })).toThrow();
  });

  it("freezes one canonical detail/list commercial surface without legacy aliases", () => {
    const parsed = EffectiveOrderSurfaceV2Schema.parse({
      schemaVersion: 2,
      surfaceKind: "detail",
      orderId: "order-1",
      currencyCode: "VND",
      minorUnitExponent: 0,
      effectiveRevision: 2,
      commercialState: "active",
      effectiveItems: [{
        lineId: "line-1",
        productId: "product-1",
        variantId: "variant-1",
        skuSnapshot: "SKU-1",
        titleSnapshot: "Product 1",
        archivedVariant: false,
        quantity: 2,
        unitPriceMinor: 100,
        lineTotalMinor: 200,
      }],
      components: {
        taxMode: "exclusive",
        merchandiseGrossMinor: 200,
        discountMinor: 20,
        merchandiseNetMinor: 180,
        shippingMinor: 10,
        merchandiseVatMinor: 19,
        shippingVatMinor: 0,
        vatMinor: 19,
        unclassifiedMinor: 1,
        totalMinor: 210,
      },
      effectiveCommercialTotalMinor: 210,
      currentOrderGrossValueMinor: 210,
      effectiveItemQuantity: 2,
      dataQuality: completeQuality,
    });

    expect(parsed.currentOrderGrossValueMinor).toBe(210);
    expect(parsed).not.toHaveProperty("total");
    expect(parsed).not.toHaveProperty("revenue");
    expect(() => EffectiveOrderSurfaceV2Schema.parse({
      ...parsed,
      effectiveItems: [{ ...parsed.effectiveItems[0], lineTotalMinor: 201 }],
    })).toThrow();
  });

  it("returns one dashboard block per currency and exposes no cross-currency scalar total", () => {
    const parsed = DashboardFinancialV2Schema.parse({
      schemaVersion: 2,
      ...dashboardReportFields,
      currencies: [dashboardCurrency("VND", 0), dashboardCurrency("USD", 2)],
    });
    expect(parsed.currencies.map((item) => item.currencyCode)).toEqual(["VND", "USD"]);
    expect(parsed).not.toHaveProperty("totalRevenue");
    expect(parsed).not.toHaveProperty("recordedGrossCollectionsMinor");
    expect(parsed.currencies[0].recordedGrossCollectionComponents).toMatchObject({
      vatMinor: 110,
      shippingMinor: 50,
      unclassifiedMinor: 50,
      totalMinor: 1_210,
    });
    expect(parsed.metricTimeBasis).toEqual(DASHBOARD_METRIC_TIME_BASIS_V2);
    expect(parsed.metricTimeBasis.revenueExcludingVatMinor).toBe("accounting_source_occurred_at");
    expect(parsed.metricTimeBasis.vatLiabilityMinor).toBe("accounting_source_occurred_at");
    expect(parsed.metricTimeBasis.cogsRecognizedMinor).toBe("accounting_source_occurred_at");
    expect(parsed.normalizedScope).toEqual(dashboardReportFields.normalizedScope);
    expect(parsed.storeTimeWindows).toEqual(dashboardReportFields.storeTimeWindows);
    expect(() => DashboardFinancialV2Schema.parse({
      schemaVersion: 2,
      generatedAt: dashboardReportFields.generatedAt,
      reportAsOf: dashboardReportFields.reportAsOf,
      metricTimeBasis: dashboardMetricTimeBasis,
      currencies: [dashboardCurrency("VND", 0)],
    })).toThrow();
    expect(() => DashboardFinancialV2Schema.parse({
      schemaVersion: 2,
      ...dashboardReportFields,
      metricTimeBasis: "payment_event_at",
      currencies: [dashboardCurrency("VND", 0)],
    })).toThrow();
    expect(() => DashboardFinancialV2Schema.parse({
      schemaVersion: 2,
      ...dashboardReportFields,
      reportAsOf: "2026-08-04T12:00:01.000Z",
      freshness: {
        databaseSnapshot: { status: "fresh", asOf: "2026-08-04T12:00:01.000Z" },
      },
      currencies: [dashboardCurrency("VND", 0)],
    })).toThrow();
    expect(() => DashboardFinancialV2Schema.parse({
      schemaVersion: 2,
      ...dashboardReportFields,
      currencies: [dashboardCurrency("VND", 0), dashboardCurrency("VND", 0)],
    })).toThrow();
  });

  it("freezes a commercial-only slice without inventing collection or accounting values", () => {
    const parsed = DashboardCommercialSliceV1Schema.parse({
      schemaVersion: 1,
      dailyActiveOrderCountSeries: [
        { localDate: "2026-08-03", activeOrderCount: 0 },
        { localDate: "2026-08-04", activeOrderCount: 2 },
      ],
      currencies: [{
        currencyCode: "VND",
        minorUnitExponent: 0,
        validOrderCount: 2,
        cancelledOrderCohortCount: 1,
        activeOrdersWithShippingCount: 1,
        currentOrderGrossValueMinor: 430,
        dailyCurrentOrderGrossValueSeries: [
          { localDate: "2026-08-03", currentOrderGrossValueMinor: 0 },
          { localDate: "2026-08-04", currentOrderGrossValueMinor: 430 },
        ],
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
      }],
    });

    expect(parsed.currencies[0].currentOrderGrossValueMinor).toBe(430);
    expect(parsed.dailyActiveOrderCountSeries).toEqual([
      { localDate: "2026-08-03", activeOrderCount: 0 },
      { localDate: "2026-08-04", activeOrderCount: 2 },
    ]);
    expect(parsed.currencies[0].dailyCurrentOrderGrossValueSeries).toEqual([
      { localDate: "2026-08-03", currentOrderGrossValueMinor: 0 },
      { localDate: "2026-08-04", currentOrderGrossValueMinor: 430 },
    ]);
    expect(parsed.currencies[0].activeOrdersWithShippingCount).toBe(1);
    expect(parsed.currencies[0].currentShippingSharePercent).toBe(4.7);
    expect(parsed.currencies[0].currentCogsMinor).toBeNull();
    expect(parsed).not.toHaveProperty("recordedGrossCollectionsMinor");
    expect(parsed).not.toHaveProperty("accountingRevenueExVatMinor");
    expect(() => DashboardCommercialSliceV1Schema.parse({
      ...parsed,
      currencies: [{
        ...parsed.currencies[0],
        currentOrderGrossValueMinor: 431,
      }],
    })).toThrow();
    expect(() => DashboardCommercialSliceV1Schema.parse({
      ...parsed,
      currencies: [{
        ...parsed.currencies[0],
        activeOrdersWithShippingCount: 3,
      }],
    })).toThrow();
    expect(() => DashboardCommercialSliceV1Schema.parse({
      ...parsed,
      currencies: [{
        ...parsed.currencies[0],
        currentShippingSharePercent: 4.6,
      }],
    })).toThrow();
    expect(() => DashboardCommercialSliceV1Schema.parse({
      ...parsed,
      currencies: [{
        ...parsed.currencies[0],
        currentCogsMinor: 100,
      }],
    })).toThrow();
    expect(() => DashboardCommercialSliceV1Schema.parse({
      ...parsed,
      currencies: [{
        ...parsed.currencies[0],
        dailyCurrentOrderGrossValueSeries: [
          { localDate: "2026-08-03", currentOrderGrossValueMinor: 0 },
          { localDate: "2026-08-04", currentOrderGrossValueMinor: 429 },
        ],
      }],
    })).toThrow();
    expect(() => DashboardCommercialSliceV1Schema.parse({
      ...parsed,
      dailyActiveOrderCountSeries: [
        { localDate: "2026-08-04", activeOrderCount: 2 },
        { localDate: "2026-08-03", activeOrderCount: 0 },
      ],
    })).toThrow();
  });

  it("models merchant AI review count as exact-or-unavailable operational evidence", () => {
    const base = {
      schemaVersion: 1 as const,
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
    };
    expect(DashboardOperationalSnapshotV1Schema.parse({
      ...base,
      reportMerchantAiReviewQueue: {
        status: "available",
        dataQualityStatus: "complete",
        pendingOrReviewRequiredCount: 4,
      },
    }).reportMerchantAiReviewQueue).toEqual({
      status: "available",
      dataQualityStatus: "complete",
      pendingOrReviewRequiredCount: 4,
    });
    expect(DashboardOperationalSnapshotV1Schema.parse({
      ...base,
      reportMerchantAiReviewQueue: {
        status: "unavailable",
        dataQualityStatus: "unavailable",
        issues: ["ambiguous_merchant_ai_ownership"],
      },
    }).reportMerchantAiReviewQueue).toEqual({
      status: "unavailable",
      dataQualityStatus: "unavailable",
      issues: ["ambiguous_merchant_ai_ownership"],
    });
    expect(() => DashboardOperationalSnapshotV1Schema.parse({
      ...base,
      reportMerchantAiReviewQueue: {
        status: "available",
        dataQualityStatus: "complete",
        pendingOrReviewRequiredCount: -1,
      },
    })).toThrow();
  });

  it("models merchant customer acquisition and accounting profit as exact dependencies", () => {
    expect(DashboardOperationalSnapshotV1Schema.parse({
      schemaVersion: 1,
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
    }).reportMerchantCustomerAcquisition).toEqual({
      status: "available",
      dataQualityStatus: "complete",
      attributionScope: "report_merchant",
      businessTimeZone: "Asia/Ho_Chi_Minh",
      newCustomerCount: 6,
    });

    expect(DashboardAccountingSliceV1Schema.parse({
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
    }).currencies[0]).toMatchObject({
      status: "available",
      grossProfitMinor: 400,
      grossMarginPercent: 40,
    });
    expect(() => DashboardAccountingSliceV1Schema.parse({
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
        grossMarginPercent: 39.9,
      }],
    })).toThrow();
  });

  it("makes COD posted at order creation and provider posting evidence-bound", () => {
    expect(PaymentCashEventV1Schema.parse({
      schemaVersion: 1,
      eventId: "evt-cod",
      idempotencyKey: "cod:ord-1:create",
      orderId: "ord-1",
      method: "cod",
      kind: "charge",
      status: "posted",
      evidenceType: "cod_order_created",
      currencyCode: "VND",
      amountMinor: 1_210,
      eventAt: "2026-08-04T12:00:00.000Z",
    }).status).toBe("posted");

    expect(() => PaymentCashEventV1Schema.parse({
      schemaVersion: 1,
      eventId: "evt-provider",
      idempotencyKey: "provider:1",
      orderId: "ord-1",
      method: "provider",
      kind: "charge",
      status: "posted",
      evidenceType: "manual_verified",
      currencyCode: "VND",
      amountMinor: 1_210,
      eventAt: "2026-08-04T12:00:00.000Z",
    })).toThrow();

    expect(PaymentCashEventV1Schema.parse({
      schemaVersion: 1,
      eventId: "evt-historical-bank",
      idempotencyKey: "historical-bank:ord-1:receipt",
      orderId: "ord-1",
      method: "manual_bank",
      kind: "charge",
      status: "posted",
      evidenceType: "owner_historical_recognition",
      currencyCode: "VND",
      amountMinor: 690_000,
      eventAt: "2026-08-04T12:00:00.000Z",
    }).evidenceType).toBe("owner_historical_recognition");
  });

  it("freezes cursor ordering, 15-minute TTL, page limits and public refresh errors", () => {
    expect(OrderListQueryV2Schema.parse({})).toEqual({ limit: 50 });
    expect(() => OrderListQueryV2Schema.parse({ limit: 201 })).toThrow();

    const claims = {
      schemaVersion: 1,
      audience: "order_list_v2",
      keyId: "cursor-key-current",
      issuedAtEpochSeconds: 1_800_000_000,
      expiresAtEpochSeconds: 1_800_000_900,
      sort: "created_at_desc_id_desc",
      scope: { merchantId: "merchant-1", storeIds: ["store-1", "store-2"] },
      filtersHash: "a".repeat(64),
      highWatermark: { createdAt: "2026-08-04T12:00:00.000Z", id: "ord-z" },
      position: { createdAt: "2026-08-04T11:00:00.000Z", id: "ord-a" },
      storeRevisionVectorHash: "b".repeat(64),
      asOf: "2026-08-04T12:00:01.000Z",
    };
    expect(CursorClaimsV1Schema.parse(claims).sort).toBe("created_at_desc_id_desc");
    expect(() => CursorClaimsV1Schema.parse({
      ...claims,
      expiresAtEpochSeconds: claims.issuedAtEpochSeconds + 901,
    })).toThrow();
    expect(CursorRefreshErrorSchema.parse({ code: "stale_cursor", refreshFromStart: true }))
      .toEqual({ code: "stale_cursor", refreshFromStart: true });
    expect(() => CursorRefreshErrorSchema.parse({
      code: "scope_mismatch",
      refreshFromStart: true,
      merchantId: "secret",
    })).toThrow();
  });

  it("freezes separate v2 order/line CSV grains while preserving the legacy window", () => {
    expect(ORDER_CSV_ORDER_V2_HEADERS).toMatchInlineSnapshot(`
      [
        "schema_version",
        "order_id",
        "effective_revision",
        "commercial_state",
        "currency_code",
        "minor_unit_exponent",
        "merchandise_gross_minor",
        "discount_minor",
        "merchandise_net_minor",
        "shipping_minor",
        "vat_minor",
        "unclassified_minor",
        "current_order_gross_value_minor",
        "recorded_gross_collections_minor",
        "negative_collections_minor",
        "net_collections_minor",
        "data_quality_status",
      ]
    `);
    expect(ORDER_CSV_LINE_V2_HEADERS).toContain("sku_snapshot");
    expect(ORDER_CSV_LINE_V2_HEADERS).toContain("effective_line_total_minor");
    expect([...ORDER_CSV_ORDER_V2_HEADERS, ...ORDER_CSV_LINE_V2_HEADERS])
      .not.toEqual(expect.arrayContaining(["revenue", "total"]));
    expect(LEGACY_ORDER_CSV_COMPATIBILITY).toEqual({
      unchangedThroughReleaseLine: "1.8.x",
      status: "deprecated",
    });
    expect(ORDER_API_V2_COMPATIBILITY).toEqual({
      endpointVersion: "v2",
      legacyEndpointStatus: "unchanged_deprecated",
      legacyEndpointSupportedThroughReleaseLine: "1.8.x",
      ambiguousScalarAliases: [],
    });
  });

  it("requires a revision-bound, expiring cancellation quote with evidence previews", () => {
    const quote = {
      schemaVersion: 1,
      quoteId: "cancel-quote-1",
      orderId: "ord-1",
      effectiveRevision: 2,
      idempotencyKey: "cancel:ord-1:rev-2",
      generatedAt: "2026-08-04T12:00:00.000Z",
      expiresAt: "2026-08-04T12:05:00.000Z",
      paymentBalances: [{
        method: "cod",
        currencyCode: "VND",
        collectedMinor: 1_210,
        refundableMinor: 1_210,
        disposition: "customer_payable",
        evidenceStatus: "verified",
      }],
      stockPreview: [{ lineId: "line-1", quantity: 1, action: "restock" }],
      loyaltyPreview: { pointsToReverse: 12 },
      journalPreview: [{ kind: "customer_payable_open", currencyCode: "VND", debitMinor: 1_210, creditMinor: 1_210 }],
      payablePreview: [{ currencyCode: "VND", openMinor: 1_210, clearMinor: 0, balanceMinor: 1_210 }],
    };
    expect(CancellationQuoteV1Schema.parse(quote).effectiveRevision).toBe(2);
    expect(() => CancellationQuoteV1Schema.parse({ ...quote, effectiveRevision: undefined })).toThrow();
    expect(() => CancellationQuoteV1Schema.parse({ ...quote, expiresAt: quote.generatedAt })).toThrow();
    expect(() => CancellationQuoteV1Schema.parse({
      ...quote,
      paymentBalances: quote.paymentBalances.map(({ evidenceStatus: _ignored, ...item }) => item),
    })).toThrow();
  });
});
