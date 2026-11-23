import type { PoolClient } from "pg";
import type { PartnerContext } from "./registry";
import {
  decodePartnerCursor,
  encodePartnerCursor,
  type PartnerKeyring,
} from "./fingerprints";
import { PartnerError } from "./errors";

// Parent assortment remains the active authorization anchor in the registry.
// This only chooses whether its item membership bounds this catalog read.
export function partnerCatalogScopeSql(
  ctx: Pick<PartnerContext, "catalogMode">,
) {
  return ctx.catalogMode === "merchant_published"
    ? "$1::text IS NOT NULL"
    : "EXISTS(SELECT 1 FROM integration.assortment_items a WHERE a.assortment_id=$1 AND a.variant_id=v.id)";
}

function toSafeInteger(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new PartnerError("internal_error");
  return number;
}

export async function readPartnerCatalog(
  db: PoolClient,
  ctx: PartnerContext,
  keys: PartnerKeyring,
  input: { limit: number; cursor?: string; variant_ids?: string[] },
  inventory = false,
) {
  const filter = {
    operation: inventory ? "inventory" : "products",
    catalogMode: ctx.catalogMode,
    variantIds: input.variant_ids?.slice().sort() ?? [],
  };
  const sort = input.cursor
    ? decodePartnerCursor(keys, ctx, filter, input.cursor)
    : [];
  if (sort.length > 1) {
    // Each operation owns the cursor key shape in addition to its signed scope.
    throw new PartnerError("invalid_cursor");
  }
  const result = await db.query(
    `
    SELECT v.id AS variant_id,COALESCE(v.sku,'') AS sku,p.title,
      components.count AS component_count,components.item_id,components.required_quantity,ii.id AS live_item_id,
      v.manage_inventory,v.allow_backorder,
      levels.stocked_quantity,levels.reserved_quantity,
      EXISTS(SELECT 1 FROM public.inventory_level r WHERE r.location_id=$3 AND r.deleted_at IS NULL AND r.reserved_quantity<>0) AS location_reserved
    FROM public.product_variant v
    JOIN public.product p ON p.id=v.product_id AND p.deleted_at IS NULL AND p.status='published' AND p.merchant_id=$2
    LEFT JOIN LATERAL (SELECT count(*) AS count,min(inventory_item_id) AS item_id,min(required_quantity) AS required_quantity
      FROM public.product_variant_inventory_item WHERE variant_id=v.id AND deleted_at IS NULL) components ON true
    LEFT JOIN public.inventory_item ii ON ii.id=components.item_id AND ii.deleted_at IS NULL
    LEFT JOIN public.inventory_level levels ON levels.inventory_item_id=components.item_id AND levels.location_id=$3 AND levels.deleted_at IS NULL
    WHERE v.deleted_at IS NULL AND ${partnerCatalogScopeSql(ctx)} AND ($4::text IS NULL OR v.id > $4)
      AND ($5::text[] IS NULL OR v.id=ANY($5))
    ORDER BY v.id LIMIT $6
  `,
    [
      ctx.assortmentId,
      ctx.merchantId,
      ctx.stockLocationId,
      sort[0] ?? null,
      input.variant_ids ?? null,
      input.limit + 1,
    ],
  );
  const asOf = new Date().toISOString();
  const pageRows = result.rows.slice(0, input.limit);
  const data = pageRows.map((row) => {
    if (!inventory)
      return { variant_id: row.variant_id, sku: row.sku, title: row.title };
    const supported =
      Number(row.component_count) === 1 &&
      Number(row.required_quantity) === 1 &&
      !!row.live_item_id &&
      row.manage_inventory &&
      !row.allow_backorder &&
      !row.location_reserved;
    const stocked =
      row.stocked_quantity === null ? 0 : Number(row.stocked_quantity);
    const quantity =
      supported && Number.isSafeInteger(stocked)
        ? Math.max(0, stocked - ctx.policy.safetyStock)
        : null;
    return {
      variant_id: row.variant_id,
      store_id: ctx.storeId,
      availability_status:
        quantity === null
          ? "unavailable"
          : quantity > 0
            ? "available"
            : "out_of_stock",
      available_quantity: quantity,
      as_of: asOf,
    };
  });
  return {
    data,
    page: {
      as_of: asOf,
      next_cursor:
        result.rows.length > input.limit
          ? encodePartnerCursor(keys, ctx, filter, [
              pageRows[pageRows.length - 1].variant_id,
            ])
          : null,
    },
    meta: { request_id: ctx.requestId },
  };
}

export async function readPartnerCatalogSummary(
  db: PoolClient,
  ctx: PartnerContext,
) {
  const result = await db.query(
    `
    WITH location_reservation AS (
      SELECT EXISTS(SELECT 1 FROM public.inventory_level r
        WHERE r.location_id=$3 AND r.deleted_at IS NULL AND r.reserved_quantity<>0) AS present
    ), eligible AS (
      SELECT v.product_id,components.count AS component_count,components.required_quantity,ii.id AS live_item_id,
        v.manage_inventory,v.allow_backorder,levels.stocked_quantity,location_reservation.present AS location_reserved
      FROM public.product_variant v
      JOIN public.product p ON p.id=v.product_id AND p.deleted_at IS NULL AND p.status='published' AND p.merchant_id=$2
      CROSS JOIN location_reservation
      LEFT JOIN LATERAL (SELECT count(*) AS count,min(inventory_item_id) AS item_id,min(required_quantity) AS required_quantity
        FROM public.product_variant_inventory_item WHERE variant_id=v.id AND deleted_at IS NULL) components ON true
      LEFT JOIN public.inventory_item ii ON ii.id=components.item_id AND ii.deleted_at IS NULL
      LEFT JOIN public.inventory_level levels ON levels.inventory_item_id=components.item_id AND levels.location_id=$3 AND levels.deleted_at IS NULL
      WHERE v.deleted_at IS NULL AND ${partnerCatalogScopeSql(ctx)}
    ), inventory AS (
      SELECT product_id,live_item_id,CASE WHEN component_count=1 AND required_quantity=1 AND live_item_id IS NOT NULL
        AND manage_inventory AND NOT allow_backorder AND NOT location_reserved
        AND COALESCE(stocked_quantity,0)=TRUNC(COALESCE(stocked_quantity,0))
        AND ABS(COALESCE(stocked_quantity,0))<=9007199254740991
        THEN GREATEST(0,COALESCE(stocked_quantity,0)-$4::int) ELSE NULL END AS available_quantity
      FROM eligible
    )
    SELECT transaction_timestamp() AS as_of,COUNT(DISTINCT product_id) AS product_count,COUNT(*) AS sku_count,
      COUNT(live_item_id)>COUNT(DISTINCT live_item_id) AS has_shared_inventory_items,
      COUNT(*) FILTER(WHERE available_quantity>0) AS available_sku_count,
      COUNT(*) FILTER(WHERE available_quantity=0) AS out_of_stock_sku_count,
      COUNT(*) FILTER(WHERE available_quantity IS NULL) AS unavailable_sku_count,
      COALESCE(SUM(available_quantity) FILTER(WHERE available_quantity IS NOT NULL),0) AS available_quantity_sum
    FROM inventory
  `,
    [
      ctx.assortmentId,
      ctx.merchantId,
      ctx.stockLocationId,
      ctx.policy.safetyStock,
    ],
  );
  const row = result.rows[0];
  const productCount = toSafeInteger(row.product_count);
  const skuCount = toSafeInteger(row.sku_count);
  const availableSkuCount = toSafeInteger(row.available_sku_count);
  const outOfStockSkuCount = toSafeInteger(row.out_of_stock_sku_count);
  const unavailableSkuCount = toSafeInteger(row.unavailable_sku_count);
  let availableQuantitySum: number | null = null;
  try {
    availableQuantitySum = toSafeInteger(row.available_quantity_sum);
  } catch {
    availableQuantitySum = null;
  }
  const inventoryComplete =
    unavailableSkuCount === 0 && availableQuantitySum !== null;
  return {
    data: {
      store_id: ctx.storeId,
      as_of: new Date(row.as_of).toISOString(),
      catalog_mode: ctx.catalogMode,
      catalog_scope: "eligible_published_variants" as const,
      quantity_basis: "per_variant" as const,
      has_shared_inventory_items: row.has_shared_inventory_items === true,
      inventory_complete: inventoryComplete,
      product_count: productCount,
      sku_count: skuCount,
      available_sku_count: availableSkuCount,
      out_of_stock_sku_count: outOfStockSkuCount,
      unavailable_sku_count: unavailableSkuCount,
      available_quantity_sum: inventoryComplete ? availableQuantitySum : null,
    },
    meta: { request_id: ctx.requestId },
  };
}
