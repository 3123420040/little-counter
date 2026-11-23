import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "../db/client";
import {
  DashboardOperationalSnapshotErrorV1,
  readDashboardOperationalSnapshotV1,
} from "../services/dashboard-operational-snapshot";

const context = {
  normalizedScope: {
    scopeKind: "report" as const,
    merchantId: "merchant-a",
    storeIds: ["store-a", "store-b"],
  },
  localDateRange: {
    from: "2026-08-17",
    to: "2026-08-17",
    inclusiveDays: 1,
  },
  storeTimeWindows: [
    {
      storeId: "store-a",
      timeZone: "UTC",
      startInclusive: "2026-08-17T00:00:00.000Z",
      endExclusive: "2026-08-18T00:00:00.000Z",
    },
    {
      storeId: "store-b",
      timeZone: "Asia/Ho_Chi_Minh",
      startInclusive: "2026-08-16T17:00:00.000Z",
      endExclusive: "2026-08-17T17:00:00.000Z",
    },
  ],
  reportAsOf: "2026-08-17T09:00:00.000Z",
  metricTimeBasis: {
    order: "order_business_date" as const,
    payment: "payment_event_at" as const,
    accounting: "accounting_source_occurred_at" as const,
  },
};

function clientReturning(row: Record<string, unknown>) {
  const query = vi.fn(async () => ({ rows: [row] }));
  return {
    client: { query } as unknown as PoolClient,
    query,
  };
}

describe("GAP-14 canonical operational dashboard snapshot", () => {
  it("returns exact merchant catalog and selected-store variant/location counts", async () => {
    const { client, query } = clientReturning({
      selected_store_count: "2",
      blank_stock_location_count: "0",
      ai_pending_count: "4",
      ambiguous_ai_pending_count: "0",
      new_customer_count: "6",
      published_sku_count: "3",
      inventory_grain_count: "4",
      low_stock_count: "2",
      out_of_stock_count: "1",
      missing_reorder_count: "0",
      negative_stock_count: "0",
    });

    await expect(readDashboardOperationalSnapshotV1(client, context)).resolves.toEqual({
      schemaVersion: 1,
      reportMerchantAiReviewQueue: {
        status: "available",
        dataQualityStatus: "complete",
        pendingOrReviewRequiredCount: 4,
      },
      reportMerchantCatalog: {
        status: "available",
        dataQualityStatus: "complete",
        publishedSkuCount: 3,
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
        inventoryVariantLocationCount: 4,
        lowStockVariantLocationCount: 2,
        outOfStockVariantLocationCount: 1,
      },
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    const normalizedSql = String(sql).toLowerCase().replace(/\s+/g, " ");
    expect(normalizedSql).toContain("count(distinct variant.id)");
    expect(normalizedSql).toContain("join ai_module.actions");
    expect(normalizedSql).toContain("status in ('pending', 'review_required')");
    expect(normalizedSql).toContain("created_at <= $3::timestamptz");
    expect(normalizedSql).toContain("join public.customer");
    expect(normalizedSql).toContain("customer.merchant_id = merchant.id");
    expect(normalizedSql).toContain("customer.created_at at time zone $4::text");
    expect(normalizedSql).toContain("between $5::date and $6::date");
    expect(normalizedSql).toContain("product.status = 'published'");
    expect(normalizedSql).toContain("sum(level.stocked_quantity)");
    expect(normalizedSql).toContain("group by variant.id, level.location_id");
    expect(normalizedSql).toContain("stocked_quantity > 0");
    expect(normalizedSql).toContain("grain.stocked_quantity <= grain.reorder_level");
    expect(normalizedSql).toContain("stocked_quantity = 0");
    expect(normalizedSql).not.toContain("coalesce(settings.reorder_level, 5)");
    expect(params).toEqual([
      "merchant-a",
      ["store-a", "store-b"],
      "2026-08-17T09:00:00.000Z",
      "Asia/Ho_Chi_Minh",
      "2026-08-17",
      "2026-08-17",
    ]);
  });

  it("withholds only the AI factor when reviewable legacy ownership is ambiguous", async () => {
    const { client } = clientReturning({
      selected_store_count: 2,
      blank_stock_location_count: 0,
      ai_pending_count: 4,
      ambiguous_ai_pending_count: 1,
      new_customer_count: 6,
      published_sku_count: 3,
      inventory_grain_count: 4,
      low_stock_count: 2,
      out_of_stock_count: 1,
      missing_reorder_count: 0,
      negative_stock_count: 0,
    });

    await expect(readDashboardOperationalSnapshotV1(client, context)).resolves.toEqual({
      schemaVersion: 1,
      reportMerchantAiReviewQueue: {
        status: "unavailable",
        dataQualityStatus: "unavailable",
        issues: ["ambiguous_merchant_ai_ownership"],
      },
      reportMerchantCatalog: {
        status: "available",
        dataQualityStatus: "complete",
        publishedSkuCount: 3,
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
        inventoryVariantLocationCount: 4,
        lowStockVariantLocationCount: 2,
        outOfStockVariantLocationCount: 1,
      },
    });
  });

  it("withholds both inventory factors when exact grain quality is incomplete", async () => {
    const { client } = clientReturning({
      selected_store_count: 2,
      blank_stock_location_count: 1,
      ai_pending_count: 0,
      ambiguous_ai_pending_count: 0,
      new_customer_count: 0,
      published_sku_count: 0,
      inventory_grain_count: 5,
      low_stock_count: 2,
      out_of_stock_count: 1,
      missing_reorder_count: 2,
      negative_stock_count: 1,
    });

    await expect(readDashboardOperationalSnapshotV1(client, context)).resolves.toEqual({
      schemaVersion: 1,
      reportMerchantAiReviewQueue: {
        status: "available",
        dataQualityStatus: "complete",
        pendingOrReviewRequiredCount: 0,
      },
      reportMerchantCatalog: {
        status: "available",
        dataQualityStatus: "complete",
        publishedSkuCount: 0,
      },
      reportMerchantCustomerAcquisition: {
        status: "available",
        dataQualityStatus: "complete",
        attributionScope: "report_merchant",
        businessTimeZone: "Asia/Ho_Chi_Minh",
        newCustomerCount: 0,
      },
      selectedReportStoresInventory: {
        status: "unavailable",
        dataQualityStatus: "unavailable",
        issues: [
          "blank_selected_stock_location",
          "missing_reorder_level",
          "negative_stock",
        ],
      },
    });
  });

  it("rejects a selected-store ownership mismatch instead of returning partial counts", async () => {
    const { client } = clientReturning({
      selected_store_count: 1,
      blank_stock_location_count: 0,
      ai_pending_count: 0,
      ambiguous_ai_pending_count: 0,
      new_customer_count: 0,
      published_sku_count: 3,
      inventory_grain_count: 4,
      low_stock_count: 2,
      out_of_stock_count: 1,
      missing_reorder_count: 0,
      negative_stock_count: 0,
    });

    await expect(readDashboardOperationalSnapshotV1(client, context))
      .rejects.toThrow(DashboardOperationalSnapshotErrorV1);
  });
});
