import {
  DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE,
  DashboardOperationalSnapshotV1Schema,
  type DashboardOperationalAiIssueV1,
  type DashboardOperationalInventoryIssueV1,
  type DashboardOperationalSnapshotV1,
} from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { DashboardSnapshotReadContext } from "./dashboard-report-foundation";

type OperationalRow = {
  selected_store_count: unknown;
  blank_stock_location_count: unknown;
  ai_pending_count: unknown;
  ambiguous_ai_pending_count: unknown;
  new_customer_count: unknown;
  published_sku_count: unknown;
  inventory_grain_count: unknown;
  low_stock_count: unknown;
  out_of_stock_count: unknown;
  missing_reorder_count: unknown;
  negative_stock_count: unknown;
};

const DASHBOARD_OPERATIONAL_SNAPSHOT_SQL = `
  WITH report_merchant AS (
    SELECT merchant.id, merchant.legacy_organization_id
    FROM app.merchants merchant
    WHERE merchant.id = $1
  ), merchant_ai_review AS (
    SELECT
      COUNT(action.id) FILTER (
        WHERE action.merchant_id = merchant.id
      )::int AS ai_pending_count,
      COUNT(action.id) FILTER (
        WHERE action.organization_id = merchant.legacy_organization_id
          AND action.merchant_id IS DISTINCT FROM merchant.id
      )::int AS ambiguous_ai_pending_count
    FROM report_merchant merchant
    LEFT JOIN ai_module.actions action
      ON action.status IN ('pending', 'review_required')
     AND action.created_at <= $3::timestamptz
     AND (
       action.merchant_id = merchant.id
       OR action.organization_id = merchant.legacy_organization_id
     )
    GROUP BY merchant.id, merchant.legacy_organization_id
  ), selected_stores AS (
    SELECT store.id, store.stock_location_id
    FROM app.stores store
    WHERE store.merchant_id = $1
      AND store.id = ANY($2::text[])
  ), merchant_customer_acquisition AS (
    SELECT COUNT(customer.id)::int AS new_customer_count
    FROM report_merchant merchant
    LEFT JOIN public.customer customer
      ON customer.merchant_id = merchant.id
     AND customer.deleted_at IS NULL
     AND customer.created_at <= $3::timestamptz
     AND (customer.created_at AT TIME ZONE $4::text)::date
       BETWEEN $5::date AND $6::date
  ), selected_store_quality AS (
    SELECT
      COUNT(DISTINCT id)::int AS selected_store_count,
      COUNT(*) FILTER (
        WHERE stock_location_id IS NULL OR BTRIM(stock_location_id) = ''
      )::int AS blank_stock_location_count
    FROM selected_stores
  ), selected_locations AS (
    SELECT DISTINCT stock_location_id AS location_id
    FROM selected_stores
    WHERE stock_location_id IS NOT NULL
      AND BTRIM(stock_location_id) <> ''
  ), published_catalog AS (
    SELECT COUNT(DISTINCT variant.id)::int AS published_sku_count
    FROM public.product_variant variant
    JOIN public.product product
      ON product.id = variant.product_id
     AND product.deleted_at IS NULL
     AND product.merchant_id = $1
     AND product.status = 'published'
    WHERE variant.deleted_at IS NULL
  ), variant_inventory_items AS (
    SELECT DISTINCT mapping.variant_id, mapping.inventory_item_id
    FROM public.product_variant_inventory_item mapping
    WHERE mapping.deleted_at IS NULL
  ), inventory_grains AS (
    SELECT
      variant.id AS variant_id,
      level.location_id,
      SUM(level.stocked_quantity)::numeric AS stocked_quantity,
      settings.reorder_level
    FROM selected_locations selected
    JOIN public.inventory_level level
      ON level.location_id = selected.location_id
     AND level.deleted_at IS NULL
    JOIN variant_inventory_items mapping
      ON mapping.inventory_item_id = level.inventory_item_id
    JOIN public.product_variant variant
      ON variant.id = mapping.variant_id
     AND variant.deleted_at IS NULL
    JOIN public.product product
      ON product.id = variant.product_id
     AND product.deleted_at IS NULL
     AND product.merchant_id = $1
    LEFT JOIN inventory.product_settings settings
      ON settings.variant_id = variant.id
     AND settings.merchant_id = $1
    GROUP BY variant.id, level.location_id, settings.reorder_level
  )
  SELECT
    quality.selected_store_count,
    quality.blank_stock_location_count,
    ai.ai_pending_count,
    ai.ambiguous_ai_pending_count,
    acquisition.new_customer_count,
    catalog.published_sku_count,
    COUNT(grain.variant_id)::int AS inventory_grain_count,
    COUNT(grain.variant_id) FILTER (
      WHERE grain.stocked_quantity > 0
        AND grain.stocked_quantity <= grain.reorder_level
    )::int AS low_stock_count,
    COUNT(grain.variant_id) FILTER (
      WHERE grain.stocked_quantity = 0
    )::int AS out_of_stock_count,
    COUNT(grain.variant_id) FILTER (
      WHERE grain.reorder_level IS NULL
    )::int AS missing_reorder_count,
    COUNT(grain.variant_id) FILTER (
      WHERE grain.stocked_quantity < 0
    )::int AS negative_stock_count
  FROM selected_store_quality quality
  CROSS JOIN merchant_ai_review ai
  CROSS JOIN merchant_customer_acquisition acquisition
  CROSS JOIN published_catalog catalog
  LEFT JOIN inventory_grains grain ON true
  GROUP BY
    quality.selected_store_count,
    quality.blank_stock_location_count,
    ai.ai_pending_count,
    ai.ambiguous_ai_pending_count,
    acquisition.new_customer_count,
    catalog.published_sku_count
`;

export class DashboardOperationalSnapshotErrorV1 extends PlatformError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("dashboard_operational_snapshot_invalid", message, 422, details);
    this.name = "DashboardOperationalSnapshotErrorV1";
  }
}

function count(value: unknown, field: keyof OperationalRow): number {
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "bigint") parsed = Number(value);
  else if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    parsed = Number(value);
  } else {
    throw new DashboardOperationalSnapshotErrorV1(
      "Operational dashboard count is invalid",
      { field },
    );
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DashboardOperationalSnapshotErrorV1(
      "Operational dashboard count is invalid",
      { field },
    );
  }
  return parsed;
}

export async function readDashboardOperationalSnapshotV1(
  client: PoolClient,
  context: DashboardSnapshotReadContext,
): Promise<DashboardOperationalSnapshotV1> {
  const merchantId = String(context.normalizedScope.merchantId || "").trim();
  const storeIds = [...context.normalizedScope.storeIds];
  if (!merchantId || storeIds.length === 0 || new Set(storeIds).size !== storeIds.length) {
    throw new DashboardOperationalSnapshotErrorV1(
      "Operational dashboard scope is invalid",
    );
  }

  const result = await client.query<OperationalRow>(
    DASHBOARD_OPERATIONAL_SNAPSHOT_SQL,
    [
      merchantId,
      storeIds,
      context.reportAsOf,
      DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE,
      context.localDateRange.from,
      context.localDateRange.to,
    ],
  );
  if (result.rows.length !== 1) {
    throw new DashboardOperationalSnapshotErrorV1(
      "Operational dashboard query returned an invalid row count",
      { rowCount: result.rows.length },
    );
  }
  const row = result.rows[0]!;
  const selectedStoreCount = count(row.selected_store_count, "selected_store_count");
  if (selectedStoreCount !== storeIds.length) {
    throw new DashboardOperationalSnapshotErrorV1(
      "Operational dashboard selected-store ownership mismatch",
      { expected: storeIds.length, actual: selectedStoreCount },
    );
  }

  const blankStockLocations = count(
    row.blank_stock_location_count,
    "blank_stock_location_count",
  );
  const aiPendingCount = count(row.ai_pending_count, "ai_pending_count");
  const ambiguousAiPendingCount = count(
    row.ambiguous_ai_pending_count,
    "ambiguous_ai_pending_count",
  );
  const publishedSkuCount = count(row.published_sku_count, "published_sku_count");
  const newCustomerCount = count(row.new_customer_count, "new_customer_count");
  const inventoryVariantLocationCount = count(
    row.inventory_grain_count,
    "inventory_grain_count",
  );
  const lowStockVariantLocationCount = count(row.low_stock_count, "low_stock_count");
  const outOfStockVariantLocationCount = count(
    row.out_of_stock_count,
    "out_of_stock_count",
  );
  const missingReorderCount = count(
    row.missing_reorder_count,
    "missing_reorder_count",
  );
  const negativeStockCount = count(row.negative_stock_count, "negative_stock_count");
  const aiIssues: DashboardOperationalAiIssueV1[] = [];
  if (ambiguousAiPendingCount > 0) {
    aiIssues.push("ambiguous_merchant_ai_ownership");
  }
  const issues: DashboardOperationalInventoryIssueV1[] = [];
  if (blankStockLocations > 0) issues.push("blank_selected_stock_location");
  if (missingReorderCount > 0) issues.push("missing_reorder_level");
  if (negativeStockCount > 0) issues.push("negative_stock");

  return DashboardOperationalSnapshotV1Schema.parse({
    schemaVersion: 1,
    reportMerchantAiReviewQueue: aiIssues.length > 0
      ? {
          status: "unavailable",
          dataQualityStatus: "unavailable",
          issues: aiIssues,
        }
      : {
          status: "available",
          dataQualityStatus: "complete",
          pendingOrReviewRequiredCount: aiPendingCount,
        },
    reportMerchantCatalog: {
      status: "available",
      dataQualityStatus: "complete",
      publishedSkuCount,
    },
    reportMerchantCustomerAcquisition: {
      status: "available",
      dataQualityStatus: "complete",
      attributionScope: "report_merchant",
      businessTimeZone: DASHBOARD_SYSTEM_DEFAULT_TIME_ZONE,
      newCustomerCount,
    },
    selectedReportStoresInventory: issues.length > 0
      ? {
          status: "unavailable",
          dataQualityStatus: "unavailable",
          issues,
        }
      : {
          status: "available",
          dataQualityStatus: "complete",
          inventoryVariantLocationCount,
          lowStockVariantLocationCount,
          outOfStockVariantLocationCount,
        },
  });
}
