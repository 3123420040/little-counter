import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { withScopedIdempotency } from "../db/idempotency";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import { emitExactOutbox } from "../repositories/outbox-repository";
import { id } from "../utils/id";
import type { OperatorContext } from "./auth-service";
import type { OperatingScope } from "@medusa-snus/contracts";
import { serializeCsv, type CsvCell } from "./csv-export-service";
import { recordStockMovement } from "./stock-movement-service";
import {
  buildExactPurchaseOrderReceivedEvent,
  buildExactStockChangedEvent,
} from "./exact-outbox-event-builders";

// Stable operation codes used with withScopedIdempotency. Each mutation has a
// distinct, lowercase, tenant-stable identifier so the same Idempotency-Key
// can be safely reused across merchants and operations.
export const INV_OPS = {
  adjustStock: "inventory.adjust_stock",
  createPurchaseOrder: "inventory.create_purchase_order",
  receivePurchaseOrder: "inventory.receive_purchase_order",
  sendPurchaseOrder: "inventory.send_purchase_order",
  cancelPurchaseOrder: "inventory.cancel_purchase_order",
  closeShortPurchaseOrder: "inventory.close_short_purchase_order",
} as const;

type PurchaseOrderStatus = "draft" | "sent" | "partially_received" | "received" | "cancelled" | "closed_short";
type PurchaseOrderCostQuality = "known" | "free" | "unknown";

interface PurchaseOrderItemInput {
  purchaseOrderItemId: string;
  receivedQuantity: number;
}

export type PurchaseOrderCatalogQuery = {
  q?: string;
  categoryId?: string;
  limit?: string | number;
  offset?: string | number;
  selectedVariantIds?: string;
};

export type PurchaseOrderDetailQuery = {
  receiptLimit?: string | number;
  receiptOffset?: string | number;
};

function boundedCatalogInteger(
  value: string | number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new PlatformError("validation_error", `${field} must be between ${minimum} and ${maximum}`, 400);
  }
  return parsed;
}

function selectedCatalogVariantIds(value?: string): string[] {
  const ids = String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length > 50) {
    throw new PlatformError("validation_error", "selectedVariantIds supports at most 50 variants", 400);
  }
  return Array.from(new Set(ids));
}

export interface StockMovementFilters {
  inventoryItemId?: string;
  productId?: string;
  variantId?: string;
  movementType?: string;
  sourceAction?: string;
  direction?: string;
  actorId?: string;
  referenceType?: string;
  referenceId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: string | number;
  cursor?: string;
}

function normalizeDateOnly(value?: string): string | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new PlatformError("validation_error", "expectedDate must be an ISO date or datetime", 400);
  }
  return parsed.toISOString().slice(0, 10);
}

function assertReason(reason?: string): string {
  const normalized = String(reason || "").trim();
  if (!normalized) throw new PlatformError("validation_error", "reason is required", 400);
  if (normalized.length > 1000) throw new PlatformError("validation_error", "reason is too long", 400);
  return normalized;
}

function parseReceiveItems(items?: PurchaseOrderItemInput[]): PurchaseOrderItemInput[] {
  if (!items?.length) throw new PlatformError("validation_error", "items are required", 400);
  const seen = new Set<string>();
  return items.map((item) => {
    const purchaseOrderItemId = String(item.purchaseOrderItemId || "").trim();
    const receivedQuantity = Number(item.receivedQuantity);
    if (!purchaseOrderItemId) throw new PlatformError("validation_error", "purchaseOrderItemId is required", 400);
    if (seen.has(purchaseOrderItemId)) throw new PlatformError("validation_error", "Duplicate purchaseOrderItemId in receipt", 400);
    seen.add(purchaseOrderItemId);
    if (!Number.isInteger(receivedQuantity) || receivedQuantity <= 0) {
      throw new PlatformError("validation_error", "receivedQuantity must be a positive integer", 400);
    }
    return { purchaseOrderItemId, receivedQuantity };
  });
}

function lineStatus(quantity: number, receivedQuantity: number, poStatus?: PurchaseOrderStatus): string {
  if (poStatus === "closed_short" && receivedQuantity < quantity) return "short_closed";
  if (receivedQuantity <= 0) return "not_received";
  if (receivedQuantity >= quantity) return "received";
  return "partially_received";
}

function purchaseOrderCostQuality(
  metadata: unknown,
  itemId: string,
  unitCost: number,
): PurchaseOrderCostQuality {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const qualities = record.costQualityByItemId && typeof record.costQualityByItemId === "object"
    && !Array.isArray(record.costQualityByItemId)
    ? record.costQualityByItemId as Record<string, unknown>
    : {};
  const quality = String(qualities[itemId] || "");
  if (quality === "known" && unitCost > 0) return "known";
  if (quality === "free" && unitCost === 0) return "free";
  return unitCost > 0 ? "known" : "unknown";
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(fn);
}

export async function listInventoryItems(scope: OperatingScope) {
  return withClient(async (client) => {
    const result = await client.query(`
      SELECT
        COALESCE(vii.inventory_item_id, ii.id) AS id,
        v.product_id,
        COALESCE(v.sku, ii.sku, '') AS sku,
        COALESCE(v.barcode, '') AS barcode,
        COALESCE(p.title, ii.title, '') AS title,
        COALESCE(p.status, 'draft') AS status,
        COALESCE(il.stocked_quantity, 0)::numeric AS stock,
        COALESCE(ps.reorder_level, 5) AS reorder_level
        ,
        COALESCE(cat.categories, '[]'::json) AS categories
      FROM public.inventory_item ii
      LEFT JOIN public.product_variant_inventory_item vii ON vii.inventory_item_id = ii.id AND vii.deleted_at IS NULL
      LEFT JOIN public.product_variant v ON v.id = vii.variant_id AND v.deleted_at IS NULL
      LEFT JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
      LEFT JOIN public.inventory_level il ON il.inventory_item_id = ii.id AND il.deleted_at IS NULL
        AND il.location_id = $1
      LEFT JOIN inventory.product_settings ps ON ps.variant_id = v.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(
          json_agg(
            json_build_object('id', pc.id, 'name', pc.name, 'handle', pc.handle)
            ORDER BY pc.rank ASC, pc.name ASC
          ) FILTER (WHERE pc.id IS NOT NULL),
          '[]'::json
        ) AS categories
        FROM public.product_category_product pcp
        JOIN public.product_category pc ON pc.id = pcp.product_category_id AND pc.deleted_at IS NULL AND pc.merchant_id = $2
        WHERE pcp.product_id = p.id
      ) cat ON true
      WHERE ii.deleted_at IS NULL
        AND p.merchant_id = $2
      ORDER BY title ASC
    `, [scope.stockLocationId, scope.merchantId]);
    return {
      inventory_items: result.rows.map((row) => ({
        id: row.id,
        product_id: row.product_id,
        sku: row.sku,
        barcode: row.barcode,
        title: row.title,
        status: row.status,
        reorder_level: Number(row.reorder_level || 5),
        categories: Array.isArray(row.categories) ? row.categories : [],
        location_levels: [{ stocked_quantity: Number(row.stock) }],
      })),
    };
  });
}

export async function listPurchaseOrderCatalog(
  scope: OperatingScope,
  query: PurchaseOrderCatalogQuery = {},
) {
  return withClient(async (client) => {
    const limit = boundedCatalogInteger(query.limit, 25, 1, 50, "limit");
    const offset = boundedCatalogInteger(query.offset, 0, 0, 100_000, "offset");
    const search = String(query.q || "").trim().slice(0, 120);
    const categoryId = String(query.categoryId || "").trim();
    const selectedVariantIds = selectedCatalogVariantIds(query.selectedVariantIds);
    const params: unknown[] = [scope.merchantId, scope.stockLocationId, search, categoryId];
    const matchSql = `
      p.merchant_id = $1
      AND p.deleted_at IS NULL
      AND p.status = 'published'
      AND pv.deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM public.product_variant_inventory_item scoped_vii
        JOIN public.inventory_level scoped_il
          ON scoped_il.inventory_item_id = scoped_vii.inventory_item_id
         AND scoped_il.deleted_at IS NULL
        WHERE scoped_vii.variant_id = pv.id
          AND scoped_vii.deleted_at IS NULL
          AND scoped_il.location_id = $2
      )
      AND (
        $3 = ''
        OR p.title ILIKE '%' || $3 || '%'
        OR COALESCE(pv.sku, '') ILIKE '%' || $3 || '%'
        OR COALESCE(pv.barcode, '') ILIKE '%' || $3 || '%'
        OR EXISTS (
          SELECT 1
          FROM public.product_category_product search_pcp
          JOIN public.product_category search_pc
            ON search_pc.id = search_pcp.product_category_id
           AND search_pc.deleted_at IS NULL
          WHERE search_pcp.product_id = p.id
            AND search_pc.name ILIKE '%' || $3 || '%'
        )
      )
      AND (
        $4 = ''
        OR EXISTS (
          SELECT 1
          FROM public.product_category_product filter_pcp
          WHERE filter_pcp.product_id = p.id
            AND filter_pcp.product_category_id = $4
        )
      )
    `;
    const count = await client.query<{ count: string | number }>(`
      SELECT count(*) AS count
      FROM public.product_variant pv
      JOIN public.product p ON p.id = pv.product_id
      WHERE ${matchSql}
    `, params);
    params.push(selectedVariantIds, limit, offset);
    const rows = await client.query(`
      WITH page AS (
        SELECT pv.id
        FROM public.product_variant pv
        JOIN public.product p ON p.id = pv.product_id
        WHERE ${matchSql}
        ORDER BY p.title ASC, COALESCE(pv.sku, '') ASC, pv.id ASC
        LIMIT $6 OFFSET $7
      ), requested AS (
        SELECT unnest($5::text[]) AS id
      ), chosen AS (
        SELECT id FROM page
        UNION
        SELECT id FROM requested
      )
      SELECT
        pv.id AS variant_id,
        pv.product_id,
        p.title AS product_name,
        COALESCE(pv.title, '') AS variant_name,
        COALESCE(pv.sku, '') AS sku,
        COALESCE(pv.barcode, '') AS barcode,
        ps.cost_price AS default_unit_cost,
        COALESCE(cat.category_names, '[]'::jsonb) AS category_names,
        pv.id = ANY($5::text[]) AS selected
      FROM chosen
      JOIN public.product_variant pv ON pv.id = chosen.id AND pv.deleted_at IS NULL
      JOIN public.product p
        ON p.id = pv.product_id
       AND p.deleted_at IS NULL
       AND p.status = 'published'
       AND p.merchant_id = $1
      LEFT JOIN inventory.product_settings ps ON ps.variant_id = pv.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(
          jsonb_agg(pc.name ORDER BY pc.rank ASC, pc.name ASC),
          '[]'::jsonb
        ) AS category_names
        FROM public.product_category_product pcp
        JOIN public.product_category pc
          ON pc.id = pcp.product_category_id
         AND pc.deleted_at IS NULL
        WHERE pcp.product_id = p.id
      ) cat ON true
      WHERE EXISTS (
        SELECT 1
        FROM public.product_variant_inventory_item scoped_vii
        JOIN public.inventory_level scoped_il
          ON scoped_il.inventory_item_id = scoped_vii.inventory_item_id
         AND scoped_il.deleted_at IS NULL
        WHERE scoped_vii.variant_id = pv.id
          AND scoped_vii.deleted_at IS NULL
          AND scoped_il.location_id = $2
      )
      ORDER BY selected DESC, p.title ASC, COALESCE(pv.sku, '') ASC, pv.id ASC
    `, params);
    const total = Number(count.rows[0]?.count || 0);
    return {
      data: rows.rows.map((row) => {
        const defaultUnitCost = row.default_unit_cost === null || row.default_unit_cost === undefined
          ? null
          : Number(row.default_unit_cost);
        return {
          variantId: String(row.variant_id),
          productId: String(row.product_id),
          productName: String(row.product_name || ""),
          variantName: String(row.variant_name || ""),
          sku: String(row.sku || ""),
          barcode: String(row.barcode || ""),
          categoryNames: normalizeJsonArray(row.category_names),
          defaultUnitCost,
          defaultUnitCostQuality: defaultUnitCost !== null && defaultUnitCost > 0 ? "known" : "unknown",
          selected: row.selected === true,
        };
      }),
      page: {
        total,
        limit,
        offset,
        hasPrevious: offset > 0,
        hasNext: offset + limit < total,
      },
    };
  });
}

export async function adjustStock(headers: HeadersLike, body: {
  inventoryItemId?: string;
  adjustment?: number;
  reason?: string;
  movementType?: string;
  sourceAction?: string;
  reasonCode?: string;
  referenceType?: string;
  referenceId?: string;
  referenceDisplay?: string;
  sourceChannel?: string;
  metadata?: Record<string, unknown>;
}, actor: OperatorContext, scope: OperatingScope) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const result = await withScopedIdempotency(client, headers, body, scope.merchantId, INV_OPS.adjustStock, async () => {
      const row = await queryOne<Record<string, unknown>>(client, `
        SELECT
          il.id AS inventory_level_id,
          il.stocked_quantity::numeric AS stock,
          vii.inventory_item_id,
          vii.variant_id,
          v.product_id,
          COALESCE(ps.reorder_level, 5) AS reorder_level,
          COALESCE(ps.cost_price, 0)::numeric AS cost_price
        FROM public.product_variant_inventory_item vii
        JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id AND il.deleted_at IS NULL
        JOIN public.product_variant v ON v.id = vii.variant_id AND v.deleted_at IS NULL
        JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
        LEFT JOIN inventory.product_settings ps ON ps.variant_id = v.id
        WHERE vii.deleted_at IS NULL AND (vii.inventory_item_id = $1 OR vii.variant_id = $1 OR v.product_id = $1)
          AND il.location_id = $2
          AND p.merchant_id = $3
        LIMIT 1
        FOR UPDATE OF il
      `, [body.inventoryItemId || "", scope.stockLocationId, scope.merchantId]);
      if (!row) throw new PlatformError("resource_not_found", "Inventory item not found", 404);

      const adjustment = Number(body.adjustment || 0);
      if (!Number.isInteger(adjustment) || adjustment === 0) throw new PlatformError("validation_error", "Adjustment must be a non-zero integer", 400);

      const newStock = Number(row.stock) + adjustment;
      if (newStock < 0) throw new PlatformError("validation_error", "Stock cannot go below zero", 400);

      await client.query("UPDATE public.inventory_level SET stocked_quantity = $2, updated_at = now() WHERE id = $1", [row.inventory_level_id, newStock]);
      const adjustmentId = body.referenceId || id("adj");
      const movement = await recordStockMovement(client, {
        inventoryItemId: String(row.inventory_item_id),
        productId: String(row.product_id || ""),
        variantId: String(row.variant_id || ""),
        movementType: body.movementType || "manual_adjustment",
        sourceAction: body.sourceAction || (body.reason === "cycle_count" ? "cycle_count" : "manual_adjustment"),
        quantityBefore: Number(row.stock),
        quantityChange: adjustment,
        quantityAfter: newStock,
        referenceType: body.referenceType || "adjustment",
        referenceId: adjustmentId,
        referenceDisplay: body.referenceDisplay || adjustmentId,
        reason: body.reason || "adjustment",
        reasonCode: body.reasonCode || body.reason || "adjustment",
        actor,
        scope,
        sourceChannel: body.sourceChannel || "inventory",
        metadata: body.metadata,
      });
      const eventId = await emitExactOutbox(client, buildExactStockChangedEvent({
        merchantId: scope.merchantId,
        storeId: scope.storeId,
        inventoryItemId: String(row.inventory_item_id),
        movementId: String(movement.id),
        sourceOccurredAt: movement.created_at,
        payload: {
          productId: row.product_id,
          variantId: row.variant_id,
          quantityAfter: newStock,
          quantityBefore: Number(row.stock),
          quantityChange: adjustment,
          reorderLevel: row.reorder_level,
          stockLocationId: scope.stockLocationId,
        },
      }));
      await recordAuditEntry(client, actor, "stock.adjusted", "inventory_item", String(row.inventory_item_id), {
        after: { adjustment, newStock },
        reason: body.reason,
        correlationId: eventId,
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return { data: { newLevel: newStock, movement } };
    });
    return result;
  });
}

function csvList(value: unknown): string[] {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function singleText(value: unknown): string {
  return String(value || "").trim();
}

function parsedLimit(value: unknown, fallback = 50, max = 200): number {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseIsoDate(value: unknown, field: string, boundary: "start" | "end" = "start"): string | null {
  const text = singleText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const time = boundary === "end" ? "23:59:59.999" : "00:00:00.000";
    return new Date(`${text}T${time}+07:00`).toISOString();
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new PlatformError("validation_error", `${field} must be a valid ISO date`, 400);
  return date.toISOString();
}

function encodeMovementCursor(row: { createdAt: unknown; id: unknown }): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id })).toString("base64url");
}

function decodeMovementCursor(cursor?: string): { createdAt: string; id: string } | null {
  const text = singleText(cursor);
  if (!text) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Record<string, unknown>;
    const createdAt = singleText(parsed.createdAt);
    const id = singleText(parsed.id);
    if (!createdAt || !id) return null;
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return null;
    return { createdAt: date.toISOString(), id };
  } catch {
    throw new PlatformError("validation_error", "cursor is invalid", 400);
  }
}

function normalizedMovementFilters(filtersOrProductId?: string | StockMovementFilters): StockMovementFilters {
  if (!filtersOrProductId) return {};
  if (typeof filtersOrProductId === "string") return { productId: filtersOrProductId };
  return filtersOrProductId;
}

function movementWhere(scope: OperatingScope, filters: StockMovementFilters, options: { includeCursor: boolean }) {
  const clauses = [
    "sm.merchant_id = $1",
    "sm.store_id = $2",
    "sm.stock_location_id = $3",
  ];
  const values: unknown[] = [scope.merchantId, scope.storeId, scope.stockLocationId];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    clauses.push(clause.replace(/\?/g, `$${values.length}`));
  };

  const inventoryItemId = singleText(filters.inventoryItemId);
  if (inventoryItemId) add("sm.inventory_item_id = ?", inventoryItemId);

  const productId = singleText(filters.productId);
  if (productId) add("(sm.inventory_item_id = ? OR sm.product_id = ? OR v.product_id = ?)", productId);

  const variantId = singleText(filters.variantId);
  if (variantId) add("(sm.variant_id = ? OR v.id = ?)", variantId);

  const movementTypes = csvList(filters.movementType);
  if (movementTypes.length) add("sm.movement_type = ANY(?::text[])", movementTypes);

  const sourceActions = csvList(filters.sourceAction);
  if (sourceActions.length) add("COALESCE(sm.source_action, sm.movement_type) = ANY(?::text[])", sourceActions);

  if (filters.direction === "in") clauses.push("sm.quantity_change > 0");
  if (filters.direction === "out") clauses.push("sm.quantity_change < 0");

  const actorId = singleText(filters.actorId);
  if (actorId) add("sm.performed_by = ?", actorId);

  const referenceType = singleText(filters.referenceType);
  if (referenceType) add("sm.reference_type = ?", referenceType);

  const referenceId = singleText(filters.referenceId);
  if (referenceId) add("sm.reference_id = ?", referenceId);

  const dateFrom = parseIsoDate(filters.dateFrom, "dateFrom");
  if (dateFrom) add("sm.created_at >= ?::timestamptz", dateFrom);

  const dateTo = parseIsoDate(filters.dateTo, "dateTo", "end");
  if (dateTo) add("sm.created_at <= ?::timestamptz", dateTo);

  const cursor = options.includeCursor ? decodeMovementCursor(filters.cursor) : null;
  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    clauses.push(`(sm.created_at < $${values.length - 1}::timestamptz OR (sm.created_at = $${values.length - 1}::timestamptz AND sm.id::text < $${values.length}))`);
  }

  return { where: clauses.join(" AND "), values };
}

function sourceActionFallback(movementType: unknown, referenceType: unknown): string {
  const movement = singleText(movementType);
  const reference = singleText(referenceType);
  if (movement === "sale") return "pos_sale";
  if (movement === "purchase_receipt") return "po_receive";
  if (movement === "return") return "return";
  if (reference === "order_correction") return "order_correction";
  if (reference === "order_found_stock") return "found_stock";
  return movement || "stock_movement";
}

export async function listStockMovements(scope: OperatingScope, filtersOrProductId?: string | StockMovementFilters) {
  return withClient(async (client) => {
    const filters = normalizedMovementFilters(filtersOrProductId);
    const limit = parsedLimit(filters.limit);
    const pageLimit = limit + 1;
    const movementFilter = movementWhere(scope, filters, { includeCursor: true });
    const result = await client.query(`
      SELECT
        sm.id::text AS id,
        sm.inventory_item_id AS "inventoryItemId",
        COALESCE(sm.product_id, v.product_id) AS "productId",
        COALESCE(sm.variant_id, v.id) AS "variantId",
        COALESCE(sm.sku_snapshot, v.sku, ii.sku, '') AS sku,
        COALESCE(sm.product_title_snapshot, p.title, ii.title, '') AS "productTitle",
        sm.movement_type AS "movementType",
        COALESCE(sm.source_action, sm.movement_type) AS "sourceAction",
        CASE WHEN sm.quantity_change > 0 THEN 'in' ELSE 'out' END AS direction,
        (sm.quantity_after - sm.quantity_change) AS "quantityBefore",
        sm.quantity_change AS "quantityChange",
        sm.quantity_after AS "quantityAfter",
        sm.reference_type AS "referenceType",
        sm.reference_id AS "referenceId",
        COALESCE(sm.reference_display, sm.reference_id) AS "referenceDisplay",
        sm.reason,
        COALESCE(sm.reason_code, sm.reason, sm.movement_type) AS "reasonCode",
        sm.performed_by AS "performedBy",
        COALESCE(sm.actor_display_name_snapshot, su.display_name, sm.performed_by) AS "actorDisplayName",
        COALESCE(sm.actor_role_snapshot, su.role) AS "actorRole",
        sm.actual_operator_id AS "actualOperatorId",
        sm.source_channel AS "sourceChannel",
        sm.merchant_id AS "merchantId",
        sm.store_id AS "storeId",
        sm.stock_location_id AS "stockLocationId",
        COALESCE(sm.metadata, '{}'::jsonb) AS metadata,
        sm.created_at AS "createdAt"
      FROM medusa.stock_movements sm
      LEFT JOIN public.inventory_item ii ON ii.id = sm.inventory_item_id AND ii.deleted_at IS NULL
      LEFT JOIN public.product_variant_inventory_item vii ON vii.inventory_item_id = sm.inventory_item_id AND vii.deleted_at IS NULL
      LEFT JOIN public.product_variant v ON v.id = vii.variant_id AND v.deleted_at IS NULL
      LEFT JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
      LEFT JOIN medusa.staff_users su ON su.operator_id = sm.performed_by
      WHERE ${movementFilter.where}
      ORDER BY sm.created_at DESC, sm.id::text DESC
      LIMIT $${movementFilter.values.length + 1}
    `, [...movementFilter.values, pageLimit]);

    const rows = result.rows.slice(0, limit).map((row) => {
      const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
      return {
        ...row,
        sourceAction: row.sourceAction || sourceActionFallback(row.movementType, row.referenceType),
        quantityBefore: Number(row.quantityBefore || 0),
        quantityChange: Number(row.quantityChange || 0),
        quantityAfter: Number(row.quantityAfter || 0),
        metadata,
        historyQuality: (metadata as Record<string, unknown>).historyQuality === "backfilled" ? "backfilled" : "native",
      };
    });
    const hasMore = result.rows.length > limit;
    const last = rows[rows.length - 1];

    const summaryFilter = movementWhere(scope, filters, { includeCursor: false });
    const summaryResult = await client.query(`
      SELECT
        COALESCE(sum(CASE WHEN sm.quantity_change > 0 THEN sm.quantity_change ELSE 0 END), 0)::int AS "totalIn",
        ABS(COALESCE(sum(CASE WHEN sm.quantity_change < 0 THEN sm.quantity_change ELSE 0 END), 0))::int AS "totalOut",
        COALESCE(sum(sm.quantity_change), 0)::int AS "netChange",
        count(*)::int AS "movementCount"
      FROM medusa.stock_movements sm
      LEFT JOIN public.product_variant_inventory_item vii ON vii.inventory_item_id = sm.inventory_item_id AND vii.deleted_at IS NULL
      LEFT JOIN public.product_variant v ON v.id = vii.variant_id AND v.deleted_at IS NULL
      WHERE ${summaryFilter.where}
    `, summaryFilter.values);

    const latestFilter = movementWhere(scope, filters, { includeCursor: false });
    const latestResult = await client.query(`
      SELECT sm.inventory_item_id AS "inventoryItemId", sm.quantity_after AS "quantityAfter"
      FROM medusa.stock_movements sm
      LEFT JOIN public.product_variant_inventory_item vii ON vii.inventory_item_id = sm.inventory_item_id AND vii.deleted_at IS NULL
      LEFT JOIN public.product_variant v ON v.id = vii.variant_id AND v.deleted_at IS NULL
      WHERE ${latestFilter.where}
      ORDER BY sm.created_at DESC, sm.id::text DESC
      LIMIT 1
    `, latestFilter.values);
    const latest = latestResult.rows[0];
    let currentStock: number | null = null;
    if (latest?.inventoryItemId) {
      const current = await queryOne<{ stock: string }>(client, `
        SELECT COALESCE(stocked_quantity, 0)::numeric AS stock
        FROM public.inventory_level
        WHERE inventory_item_id = $1
          AND location_id = $2
          AND deleted_at IS NULL
        LIMIT 1
      `, [latest.inventoryItemId, scope.stockLocationId]);
      currentStock = current ? Number(current.stock || 0) : null;
    }
    const summaryRow = summaryResult.rows[0] || {};
    return {
      data: rows,
      summary: {
        totalIn: Number(summaryRow.totalIn || 0),
        totalOut: Number(summaryRow.totalOut || 0),
        netChange: Number(summaryRow.netChange || 0),
        movementCount: Number(summaryRow.movementCount || 0),
        latestQuantityAfter: latest ? Number(latest.quantityAfter || 0) : null,
        currentStock,
        reconciledToCurrentStock: latest && currentStock !== null ? Number(latest.quantityAfter || 0) === currentStock : null,
      },
      pagination: {
        limit,
        nextCursor: hasMore && last ? encodeMovementCursor(last) : null,
        hasMore,
      },
    };
  });
}

const STOCK_MOVEMENT_EXPORT_COLUMNS = [
  "timestamp",
  "product_title",
  "sku",
  "movement_type",
  "source_action",
  "direction",
  "quantity_before",
  "quantity_change",
  "quantity_after",
  "reason_code",
  "reason",
  "actor_display_name",
  "actor_id",
  "reference_type",
  "reference_display",
  "reference_id",
  "merchant_id",
  "store_id",
  "stock_location_id",
] as const;

export async function createStockMovementHistoryExportCsv(scope: OperatingScope, filters: StockMovementFilters = {}) {
  const result = await listStockMovements(scope, { ...filters, limit: 1000, cursor: undefined });
  const rows = result.data.map((movement) => ([
    movement.createdAt instanceof Date ? movement.createdAt.toISOString() : String(movement.createdAt || ""),
    movement.productTitle,
    movement.sku,
    movement.movementType,
    movement.sourceAction,
    movement.direction,
    movement.quantityBefore,
    movement.quantityChange,
    movement.quantityAfter,
    movement.reasonCode,
    movement.reason,
    movement.actorDisplayName,
    movement.performedBy,
    movement.referenceType,
    movement.referenceDisplay,
    movement.referenceId,
    movement.merchantId,
    movement.storeId,
    movement.stockLocationId,
  ] satisfies CsvCell[]));
  return serializeCsv(STOCK_MOVEMENT_EXPORT_COLUMNS, rows);
}

export async function listPurchaseOrders(scope: OperatingScope) {
  return withClient(async (client) => {
    return { data: await listPurchaseOrdersForClient(client, scope) };
  });
}

async function listPurchaseOrdersForClient(client: PoolClient, scope: OperatingScope) {
  const result = await client.query(`
      SELECT
        po.*,
        COALESCE(count(poi.id), 0)::int AS line_count,
        COALESCE(sum(poi.quantity), 0)::int AS ordered_quantity,
        COALESCE(sum(poi.received_quantity), 0)::int AS received_quantity,
        COALESCE(sum(GREATEST(poi.quantity - poi.received_quantity, 0)), 0)::int AS remaining_quantity,
        COALESCE(sum(poi.quantity * poi.unit_cost), 0)::numeric AS total_cost,
        COALESCE(bool_and(
          poi.unit_cost > 0
          OR COALESCE(po.metadata->'costQualityByItemId'->>poi.id = 'free', false)
        ) FILTER (WHERE poi.id IS NOT NULL), true) AS total_cost_available,
        COALESCE(json_agg(json_build_object(
        'id', poi.id,
        'variantId', poi.variant_id,
        'quantity', poi.quantity,
        'unitCost', poi.unit_cost,
        'unitCostQuality', CASE
          WHEN poi.unit_cost > 0 THEN 'known'
          WHEN po.metadata->'costQualityByItemId'->>poi.id = 'free' THEN 'free'
          ELSE 'unknown'
        END,
        'receivedQuantity', poi.received_quantity,
        'sku', COALESCE(poi.sku_snapshot, v.sku, ''),
        'productName', COALESCE(poi.product_name_snapshot, p.title, ''),
        'categoryNames', COALESCE(poi.category_names_snapshot, '[]'::jsonb)
      ) ORDER BY poi.created_at) FILTER (WHERE poi.id IS NOT NULL), '[]') AS items
      FROM inventory.purchase_orders po
      LEFT JOIN inventory.purchase_order_items poi ON poi.purchase_order_id = po.id
      LEFT JOIN public.product_variant v ON v.id = poi.variant_id AND v.deleted_at IS NULL
      LEFT JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
      WHERE po.merchant_id = $1 AND po.store_id = $2
      GROUP BY po.id
      ORDER BY po.created_at DESC
    `, [scope.merchantId, scope.storeId]);
  return result.rows.map((row) => ({
    id: row.id,
    supplierName: row.supplier_name,
    status: row.status,
    expectedDate: row.expected_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
    cancelledAt: row.cancelled_at,
    closedAt: row.closed_at,
    lineCount: Number(row.line_count || 0),
    orderedQuantity: Number(row.ordered_quantity || 0),
    receivedQuantity: Number(row.received_quantity || 0),
    remainingQuantity: Number(row.remaining_quantity || 0),
    totalCost: row.total_cost_available === true ? Number(row.total_cost || 0) : null,
    totalCostAvailable: row.total_cost_available === true,
    items: row.items,
  }));
}

function normalizeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((entry) => String(entry)).filter(Boolean) : [];
    } catch {
      return value.split("|").map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [];
}

async function purchaseOrderDetailForClient(
  client: PoolClient,
  poId: string,
  scope: OperatingScope,
  query: PurchaseOrderDetailQuery = {},
) {
  const po = await queryOne<Record<string, unknown>>(client, `
    SELECT *
    FROM inventory.purchase_orders
    WHERE id = $1
  `, [poId]);
  if (!po) throw new PlatformError("resource_not_found", "Purchase order not found", 404);
  if (po.merchant_id && po.merchant_id !== scope.merchantId) {
    throw new PlatformError("forbidden", "Purchase order belongs to a different merchant", 403);
  }
  if (po.store_id && po.store_id !== scope.storeId) {
    throw new PlatformError("forbidden", "Purchase order belongs to a different store", 403);
  }

  const itemResult = await client.query(`
    SELECT
      poi.id,
      poi.variant_id,
      COALESCE(vii.inventory_item_id, '') AS inventory_item_id,
      COALESCE(poi.sku_snapshot, v.sku, '') AS sku,
      COALESCE(poi.product_name_snapshot, p.title, '') AS product_name,
      COALESCE(poi.category_names_snapshot, cat.category_names, '[]'::jsonb) AS category_names,
      poi.quantity,
      poi.unit_cost,
      poi.received_quantity,
      COALESCE(il.stocked_quantity, 0)::numeric AS current_stock,
      max(por.received_at) AS last_received_at
    FROM inventory.purchase_order_items poi
    LEFT JOIN public.product_variant v ON v.id = poi.variant_id AND v.deleted_at IS NULL
    LEFT JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
    LEFT JOIN public.product_variant_inventory_item vii ON vii.variant_id = poi.variant_id AND vii.deleted_at IS NULL
    LEFT JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id
      AND il.location_id = $2
      AND il.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(pc.name ORDER BY pc.rank ASC, pc.name ASC), '[]'::jsonb) AS category_names
      FROM public.product_category_product pcp
      JOIN public.product_category pc ON pc.id = pcp.product_category_id AND pc.deleted_at IS NULL
      WHERE pcp.product_id = p.id
    ) cat ON true
    LEFT JOIN inventory.purchase_order_receipt_items pori ON pori.purchase_order_item_id = poi.id
    LEFT JOIN inventory.purchase_order_receipts por ON por.id = pori.receipt_id
    WHERE poi.purchase_order_id = $1
    GROUP BY poi.id, v.sku, p.title, vii.inventory_item_id, il.stocked_quantity, cat.category_names
    ORDER BY poi.created_at ASC, poi.id ASC
  `, [poId, scope.stockLocationId]);

  const status = String(po.status || "draft") as PurchaseOrderStatus;
  const items = itemResult.rows.map((row) => {
    const quantity = Number(row.quantity || 0);
    const receivedQuantity = Number(row.received_quantity || 0);
    const unitCost = Number(row.unit_cost || 0);
    return {
      id: row.id,
      variantId: row.variant_id,
      inventoryItemId: row.inventory_item_id,
      sku: row.sku,
      productName: row.product_name,
      categoryNames: normalizeJsonArray(row.category_names),
      quantity,
      unitCost,
      unitCostQuality: purchaseOrderCostQuality(po.metadata, String(row.id), unitCost),
      receivedQuantity,
      remainingQuantity: Math.max(0, quantity - receivedQuantity),
      lineStatus: lineStatus(quantity, receivedQuantity, status),
      currentStock: Number(row.current_stock || 0),
      lastReceivedAt: row.last_received_at,
    };
  });

  const receiptLimit = boundedCatalogInteger(query.receiptLimit, 10, 1, 50, "receiptLimit");
  const receiptOffset = boundedCatalogInteger(query.receiptOffset, 0, 0, 100_000, "receiptOffset");
  const receiptCountResult = await client.query<{ count: string | number }>(`
    SELECT count(*) AS count
    FROM inventory.purchase_order_receipts por
    WHERE por.purchase_order_id = $1
      AND por.merchant_id = $2
      AND por.store_id = $3
  `, [poId, scope.merchantId, scope.storeId]);
  const receiptTotal = Number(receiptCountResult.rows[0]?.count || 0);

  const receiptRows = await client.query(`
    WITH receipt_page AS (
      SELECT por.*
      FROM inventory.purchase_order_receipts por
      WHERE por.purchase_order_id = $1
        AND por.merchant_id = $2
        AND por.store_id = $3
      ORDER BY por.received_at DESC, por.created_at DESC, por.id DESC
      LIMIT $4 OFFSET $5
    )
    SELECT
      por.id AS receipt_id,
      por.received_at,
      por.received_by,
      por.note,
      pori.purchase_order_item_id,
      pori.quantity_received,
      pori.unit_cost,
      pori.inventory_value,
      pori.quantity_after,
      COALESCE(poi.sku_snapshot, v.sku, '') AS sku,
      COALESCE(poi.product_name_snapshot, p.title, '') AS product_name
    FROM receipt_page por
    LEFT JOIN inventory.purchase_order_receipt_items pori ON pori.receipt_id = por.id
    LEFT JOIN inventory.purchase_order_items poi ON poi.id = pori.purchase_order_item_id
    LEFT JOIN public.product_variant v ON v.id = poi.variant_id AND v.deleted_at IS NULL
    LEFT JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
    ORDER BY por.received_at DESC, por.created_at DESC, por.id DESC, pori.created_at ASC, pori.id ASC
  `, [poId, scope.merchantId, scope.storeId, receiptLimit, receiptOffset]);

  const receiptsById = new Map<string, {
    id: string;
    receivedAt: unknown;
    receivedBy: unknown;
    note: unknown;
    totalQuantity: number;
    inventoryValue: number;
    valueAvailable: boolean;
    unknownCostLineCount: number;
    items: unknown[];
  }>();
  for (const row of receiptRows.rows) {
    const receiptId = String(row.receipt_id || "");
    if (!receiptId) continue;
    let receipt = receiptsById.get(receiptId);
    if (!receipt) {
      receipt = {
        id: receiptId,
        receivedAt: row.received_at,
        receivedBy: row.received_by,
        note: row.note,
        totalQuantity: 0,
        inventoryValue: 0,
        valueAvailable: true,
        unknownCostLineCount: 0,
        items: [],
      };
      receiptsById.set(receiptId, receipt);
    }
    if (row.purchase_order_item_id) {
      const quantityReceived = Number(row.quantity_received || 0);
      const inventoryValue = Number(row.inventory_value || 0);
      const unitCost = Number(row.unit_cost || 0);
      const unitCostQuality = purchaseOrderCostQuality(
        po.metadata,
        String(row.purchase_order_item_id),
        unitCost,
      );
      receipt.totalQuantity += quantityReceived;
      receipt.inventoryValue += inventoryValue;
      if (unitCostQuality === "unknown") {
        receipt.valueAvailable = false;
        receipt.unknownCostLineCount += 1;
      }
      receipt.items.push({
        purchaseOrderItemId: row.purchase_order_item_id,
        sku: row.sku,
        productName: row.product_name,
        quantityReceived,
        unitCost,
        unitCostQuality,
        inventoryValue,
        quantityAfter: Number(row.quantity_after || 0),
      });
    }
  }

  const orderedQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const receivedQuantity = items.reduce((sum, item) => sum + item.receivedQuantity, 0);
  const unknownCostLineCount = items.filter((item) => item.unitCostQuality === "unknown").length;
  const valueAvailable = unknownCostLineCount === 0;
  const orderedValue = valueAvailable
    ? items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0)
    : null;
  const receivedValue = valueAvailable
    ? items.reduce((sum, item) => sum + item.receivedQuantity * item.unitCost, 0)
    : null;

  return {
    id: po.id,
    supplierName: po.supplier_name,
    status,
    expectedDate: po.expected_date,
    createdAt: po.created_at,
    createdBy: po.created_by,
    updatedAt: po.updated_at,
    sentAt: po.sent_at,
    sentBy: po.sent_by,
    cancelledAt: po.cancelled_at,
    cancelledBy: po.cancelled_by,
    cancelReason: po.cancel_reason,
    closedAt: po.closed_at,
    closedBy: po.closed_by,
    closeReason: po.close_reason,
    source: po.source || "manual",
    totals: {
      lineCount: items.length,
      orderedQuantity,
      receivedQuantity,
      remainingQuantity: Math.max(0, orderedQuantity - receivedQuantity),
      orderedValue,
      receivedValue,
      valueAvailable,
      unknownCostLineCount,
    },
    items,
    receipts: Array.from(receiptsById.values()).map((receipt) => ({
      ...receipt,
      inventoryValue: receipt.valueAvailable ? receipt.inventoryValue : null,
    })),
    receiptPage: {
      total: receiptTotal,
      limit: receiptLimit,
      offset: receiptOffset,
      hasPrevious: receiptOffset > 0,
      hasNext: receiptOffset + receiptLimit < receiptTotal,
    },
  };
}

export async function getPurchaseOrderDetail(
  poId: string,
  scope: OperatingScope,
  query: PurchaseOrderDetailQuery = {},
) {
  return withClient(async (client) => ({ data: await purchaseOrderDetailForClient(client, poId, scope, query) }));
}

export async function createPurchaseOrder(headers: HeadersLike, body: { supplierName?: string; items?: Array<{ variantId: string; quantity: number; unitCost: number; unitCostQuality?: PurchaseOrderCostQuality }>; expectedDate?: string; source?: string }, actor: OperatorContext, scope: OperatingScope) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const result = await withScopedIdempotency(client, headers, body, scope.merchantId, INV_OPS.createPurchaseOrder, async () => {
      const supplierName = String(body.supplierName || "").trim();
      if (!supplierName || !body.items?.length) throw new PlatformError("validation_error", "supplierName and items are required", 400);
      const expectedDate = normalizeDateOnly(body.expectedDate);
      const source = body.source === "csv_import" || body.source === "recommendation_csv" ? body.source : "manual";
      const seenVariants = new Set<string>();
      const poId = id("po");
      const costQualityByItemId: Record<string, "known" | "free"> = {};
      await client.query("INSERT INTO inventory.purchase_orders (id, supplier_name, expected_date, created_by, merchant_id, store_id, source) VALUES ($1, $2, $3, $4, $5, $6, $7)", [poId, supplierName, expectedDate, actor.operatorId, scope.merchantId, scope.storeId, source]);
      for (const item of body.items) {
        const variantId = String(item.variantId || "").trim();
        const quantity = Number(item.quantity);
        const unitCost = Number(item.unitCost);
        if (!variantId) throw new PlatformError("validation_error", "variantId is required", 400);
        if (seenVariants.has(variantId)) throw new PlatformError("validation_error", "Duplicate variantId in purchase order", 400);
        seenVariants.add(variantId);
        if (!Number.isInteger(quantity) || quantity <= 0) throw new PlatformError("validation_error", "quantity must be a positive integer", 400);
        if (!Number.isInteger(unitCost) || unitCost < 0) throw new PlatformError("validation_error", "unitCost must be a non-negative integer", 400);
        const unitCostQuality = item.unitCostQuality === "free"
          ? "free"
          : item.unitCostQuality === "known" || unitCost > 0
            ? "known"
            : "unknown";
        if (unitCostQuality === "known" && unitCost <= 0) {
          throw new PlatformError("validation_error", "Known purchase cost must be positive", 400);
        }
        if (unitCostQuality === "free" && unitCost !== 0) {
          throw new PlatformError("validation_error", "Free purchase cost must be exactly zero", 400);
        }
        if (unitCostQuality === "unknown") {
          throw new PlatformError("purchase_order_cost_unknown", "Purchase cost is unknown; enter a positive cost or explicitly confirm free", 409);
        }
        const ownedVariant = await queryOne<{ id: string; sku: string; product_name: string; category_names: unknown }>(client, `
          SELECT
            v.id,
            COALESCE(v.sku, '') AS sku,
            COALESCE(p.title, '') AS product_name,
            COALESCE(cat.category_names, '[]'::jsonb) AS category_names
          FROM public.product_variant v
          JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
          JOIN public.product_variant_inventory_item vii ON vii.variant_id = v.id AND vii.deleted_at IS NULL
          JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id AND il.deleted_at IS NULL
          LEFT JOIN LATERAL (
            SELECT COALESCE(jsonb_agg(pc.name ORDER BY pc.rank ASC, pc.name ASC), '[]'::jsonb) AS category_names
            FROM public.product_category_product pcp
            JOIN public.product_category pc ON pc.id = pcp.product_category_id AND pc.deleted_at IS NULL
            WHERE pcp.product_id = p.id
          ) cat ON true
          WHERE v.id = $1 AND v.deleted_at IS NULL
            AND p.merchant_id = $2
            AND il.location_id = $3
          LIMIT 1
        `, [variantId, scope.merchantId, scope.stockLocationId]);
        if (!ownedVariant) throw new PlatformError("resource_not_found", "Purchase-order variant is outside the active store", 404);
        const purchaseOrderItemId = id("poi");
        await client.query(`
          INSERT INTO inventory.purchase_order_items (
            id, purchase_order_id, variant_id, quantity, unit_cost,
            sku_snapshot, product_name_snapshot, category_names_snapshot
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `, [
          purchaseOrderItemId,
          poId,
          variantId,
          quantity,
          unitCost,
          ownedVariant.sku,
          ownedVariant.product_name,
          JSON.stringify(normalizeJsonArray(ownedVariant.category_names)),
        ]);
        costQualityByItemId[purchaseOrderItemId] = unitCostQuality;
      }
      await client.query(`
        UPDATE inventory.purchase_orders
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{costQualityByItemId}',
          $2::jsonb,
          true
        )
        WHERE id = $1
      `, [poId, JSON.stringify(costQualityByItemId)]);
      await recordAuditEntry(client, actor, "purchase_order.created", "purchase_order", poId, { after: { supplierName, source }, merchantId: scope.merchantId, storeId: scope.storeId });
      const created = (await listPurchaseOrdersForClient(client, scope)).find((po) => po.id === poId);
      if (!created) throw new PlatformError("internal_error", "Created purchase order could not be loaded", 500);
      return { data: created };
    });
    return result;
  });
}

export async function receivePurchaseOrder(headers: HeadersLike, poId: string, body: { note?: string; items?: Array<{ purchaseOrderItemId: string; receivedQuantity: number }> }, actor: OperatorContext, scope: OperatingScope) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const result = await withScopedIdempotency(client, headers, body, scope.merchantId, INV_OPS.receivePurchaseOrder, async () => {
      const requestedItems = parseReceiveItems(body.items);
      const po = await queryOne<Record<string, unknown>>(client, `
        SELECT * FROM inventory.purchase_orders WHERE id = $1 FOR UPDATE
      `, [poId]);
      if (!po) throw new PlatformError("resource_not_found", "Purchase order not found", 404);
      if (po.merchant_id && po.merchant_id !== scope.merchantId) {
        throw new PlatformError("forbidden", "Purchase order belongs to a different merchant", 403);
      }
      if (po.store_id && po.store_id !== scope.storeId) {
        throw new PlatformError("forbidden", "Purchase order belongs to a different store", 403);
      }
      const currentStatus = String(po.status || "draft") as PurchaseOrderStatus;
      if (!["draft", "sent", "partially_received"].includes(currentStatus)) {
        throw new PlatformError("invalid_state_transition", "Cannot receive this purchase order in its current status", 409, { status: currentStatus });
      }

      // Lock every requested purchase-order item first, then acquire the
      // shared inventory-level locks in a stable inventory-item order. Two different
      // purchase orders can otherwise receive the same multi-line inventory
      // set in opposite payload orders and deadlock on inventory_level.
      const lockedItems = new Map<string, Record<string, unknown>>();
      for (const received of requestedItems) {
        const item = await queryOne<Record<string, unknown>>(
          client,
          "SELECT * FROM inventory.purchase_order_items WHERE id = $1 AND purchase_order_id = $2 FOR UPDATE",
          [received.purchaseOrderItemId, poId],
        );
        if (!item) throw new PlatformError("resource_not_found", "Purchase order item not found", 404);
        const unitCost = Number(item.unit_cost || 0);
        const unitCostQuality = purchaseOrderCostQuality(po.metadata, String(item.id), unitCost);
        if (unitCostQuality === "unknown") {
          throw new PlatformError(
            "purchase_order_cost_unknown",
            "Cannot receive a purchase-order line with unknown cost",
            409,
            { purchaseOrderItemId: received.purchaseOrderItemId },
          );
        }
        const remaining = Number(item.quantity) - Number(item.received_quantity);
        const qty = Number(received.receivedQuantity);
        if (remaining <= 0) {
          throw new PlatformError("invalid_receipt_quantity", "Purchase order item is already fully received", 409, { purchaseOrderItemId: received.purchaseOrderItemId });
        }
        if (qty > remaining) {
          throw new PlatformError("invalid_receipt_quantity", "Received quantity exceeds remaining quantity", 409, {
            purchaseOrderItemId: received.purchaseOrderItemId,
            remaining,
            receivedQuantity: qty,
          });
        }
        lockedItems.set(received.purchaseOrderItemId, item);
      }

      await client.query("SELECT integration.lock_commerce_inputs($1, $2::text[])", [
        scope.merchantId,
        [...lockedItems.values()].map((item) => String(item.variant_id)),
      ]);
      const resolvedVariants = new Map<string, Record<string, unknown>>();
      for (const received of requestedItems) {
        const item = lockedItems.get(received.purchaseOrderItemId)!;
        const variant = await queryOne<Record<string, unknown>>(client, `
          SELECT vii.inventory_item_id, v.product_id, il.id AS inventory_level_id, COALESCE(ps.reorder_level, 5) AS reorder_level
          FROM public.product_variant v
          JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
          JOIN public.product_variant_inventory_item vii ON vii.variant_id = v.id AND vii.deleted_at IS NULL
          JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id AND il.deleted_at IS NULL
          LEFT JOIN inventory.product_settings ps ON ps.variant_id = v.id
          WHERE v.id = $1 AND v.deleted_at IS NULL AND il.location_id = $2 AND p.merchant_id = $3
          LIMIT 1
        `, [item.variant_id, scope.stockLocationId, scope.merchantId]);
        if (!variant) throw new PlatformError("resource_not_found", "Purchase-order variant is outside the active store", 404);
        resolvedVariants.set(received.purchaseOrderItemId, variant);
      }
      const lockOrder = [...requestedItems].sort((left, right) => {
        const leftKey = String(resolvedVariants.get(left.purchaseOrderItemId)!.inventory_item_id);
        const rightKey = String(resolvedVariants.get(right.purchaseOrderItemId)!.inventory_item_id);
        return (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0)
          || (left.purchaseOrderItemId < right.purchaseOrderItemId ? -1 : left.purchaseOrderItemId > right.purchaseOrderItemId ? 1 : 0);
      });
      const runningStock = new Map<string, number>();
      for (const received of lockOrder) {
        const variant = resolvedVariants.get(received.purchaseOrderItemId)!;
        const levelId = String(variant.inventory_level_id);
        if (runningStock.has(levelId)) continue;
        const level = await queryOne<{ stock: string }>(client, `
          SELECT stocked_quantity::numeric AS stock FROM public.inventory_level
          WHERE id = $1 AND deleted_at IS NULL FOR UPDATE
        `, [levelId]);
        if (!level) throw new PlatformError("resource_not_found", "Purchase-order stock level was removed", 404);
        runningStock.set(levelId, Number(level.stock));
      }

      const receiptId = id("por");
      const receiptInsert = await client.query<{ received_at: Date | string }>(`
        INSERT INTO inventory.purchase_order_receipts (
          id, purchase_order_id, merchant_id, store_id, stock_location_id,
          received_by, note, source, idempotency_key
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'web_pos', $8)
        RETURNING received_at
      `, [receiptId, poId, scope.merchantId, scope.storeId, scope.stockLocationId, actor.operatorId, body.note || null, headerValue(headers, "idempotency-key") || null]);
      const receipt = receiptInsert.rows[0]!;

      let inventoryValue = 0;
      const receiptItems: Array<{ purchaseOrderItemId: string; quantityReceived: number; variantId: string }> = [];
      for (const received of requestedItems) {
        const item = lockedItems.get(received.purchaseOrderItemId);
        if (!item) throw new PlatformError("resource_not_found", "Purchase order item not found", 404);
        const unitCost = Number(item.unit_cost || 0);
        const unitCostQuality = purchaseOrderCostQuality(po.metadata, String(item.id), unitCost);
        const qty = Number(received.receivedQuantity);
        const variant = resolvedVariants.get(received.purchaseOrderItemId);
        if (!variant) throw new PlatformError("resource_not_found", "Purchase-order variant is outside the active store", 404);
        const quantityBefore = runningStock.get(String(variant.inventory_level_id))!;
        const newStock = quantityBefore + qty;
        runningStock.set(String(variant.inventory_level_id), newStock);
        await client.query("UPDATE public.inventory_level SET stocked_quantity = $2, updated_at = now() WHERE id = $1", [variant.inventory_level_id, newStock]);
        await client.query("UPDATE inventory.purchase_order_items SET received_quantity = received_quantity + $2, updated_at = now() WHERE id = $1", [item.id, qty]);
        const lineInventoryValue = qty * unitCost;
        await client.query(`
          INSERT INTO inventory.purchase_order_receipt_items (
            id, receipt_id, purchase_order_item_id, variant_id, inventory_item_id,
            quantity_received, unit_cost, inventory_value, quantity_after
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          id("pori"),
          receiptId,
          item.id,
          item.variant_id,
          variant.inventory_item_id,
          qty,
          unitCost,
          lineInventoryValue,
          newStock,
        ]);
        const movement = await recordStockMovement(client, {
          inventoryItemId: String(variant.inventory_item_id),
          productId: String(variant.product_id || ""),
          variantId: String(item.variant_id || ""),
          movementType: "purchase_receipt",
          sourceAction: "po_receive",
          quantityBefore,
          quantityChange: qty,
          quantityAfter: newStock,
          referenceType: "purchase_order_receipt",
          referenceId: receiptId,
          referenceDisplay: `${poId} / ${receiptId}`,
          reason: "PO received",
          reasonCode: "po_received",
          actor,
          scope,
          sourceChannel: "inventory",
          metadata: {
            purchaseOrderId: poId,
            purchaseOrderItemId: item.id,
            receiptId,
            unitCost,
            unitCostQuality,
            inventoryValue: lineInventoryValue,
          },
        });
        inventoryValue += lineInventoryValue;
        receiptItems.push({ purchaseOrderItemId: String(item.id), quantityReceived: qty, variantId: String(item.variant_id) });
        await emitExactOutbox(client, buildExactStockChangedEvent({
          merchantId: scope.merchantId,
          storeId: scope.storeId,
          inventoryItemId: String(variant.inventory_item_id),
          movementId: String(movement.id),
          sourceOccurredAt: movement.created_at,
          payload: {
            productId: variant.product_id,
            variantId: item.variant_id,
            quantityBefore,
            quantityChange: qty,
            quantityAfter: newStock,
            reorderLevel: variant.reorder_level,
            purchaseOrderId: poId,
            receiptId,
            stockLocationId: scope.stockLocationId,
          },
        }));
      }
      const statusResult = await client.query(`
        SELECT bool_and(received_quantity >= quantity) AS all_received, bool_or(received_quantity > 0) AS any_received
        FROM inventory.purchase_order_items WHERE purchase_order_id = $1
      `, [poId]);
      const status = statusResult.rows[0]?.all_received ? "received" : statusResult.rows[0]?.any_received ? "partially_received" : currentStatus;
      await client.query("UPDATE inventory.purchase_orders SET status = $2, updated_at = now() WHERE id = $1", [poId, status]);
      const eventId = await emitExactOutbox(client, buildExactPurchaseOrderReceivedEvent({
        merchantId: scope.merchantId,
        storeId: scope.storeId,
        receiptId,
        sourceOccurredAt: receipt.received_at,
        payload: {
          purchaseOrderId: poId,
          inventoryValue,
          stockLocationId: scope.stockLocationId,
        },
      }));
      await recordAuditEntry(client, actor, "purchase_order.receipt_created", "purchase_order_receipt", receiptId, {
        after: { purchaseOrderId: poId, status, inventoryValue, items: receiptItems },
        correlationId: eventId,
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      const purchaseOrder = await purchaseOrderDetailForClient(client, poId, scope);
      return { data: { ...purchaseOrder, purchaseOrder, receipt: { id: receiptId, inventoryValue, items: receiptItems } } };
    });
    return result;
  });
}

export async function sendPurchaseOrder(headers: HeadersLike, poId: string, body: { note?: string }, actor: OperatorContext, scope: OperatingScope) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const result = await withScopedIdempotency(client, headers, body, scope.merchantId, INV_OPS.sendPurchaseOrder, async () => {
      const po = await queryOne<Record<string, unknown>>(client, "SELECT * FROM inventory.purchase_orders WHERE id = $1 FOR UPDATE", [poId]);
      if (!po) throw new PlatformError("resource_not_found", "Purchase order not found", 404);
      if (po.merchant_id && po.merchant_id !== scope.merchantId) throw new PlatformError("forbidden", "Purchase order belongs to a different merchant", 403);
      if (po.store_id && po.store_id !== scope.storeId) throw new PlatformError("forbidden", "Purchase order belongs to a different store", 403);
      if (po.status !== "draft") throw new PlatformError("invalid_state_transition", "Only draft purchase orders can be marked sent", 409, { status: po.status });

      await client.query(`
        UPDATE inventory.purchase_orders
        SET status = 'sent', sent_at = now(), sent_by = $2, updated_at = now(),
            metadata = metadata || jsonb_build_object('sentNote', $3::text)
        WHERE id = $1
      `, [poId, actor.operatorId, body.note || ""]);
      await recordAuditEntry(client, actor, "purchase_order.sent", "purchase_order", poId, {
        after: { status: "sent", note: body.note || null },
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return { data: await purchaseOrderDetailForClient(client, poId, scope) };
    });
    return result;
  });
}

export async function cancelPurchaseOrder(headers: HeadersLike, poId: string, body: { reason?: string }, actor: OperatorContext, scope: OperatingScope) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const result = await withScopedIdempotency(client, headers, body, scope.merchantId, INV_OPS.cancelPurchaseOrder, async () => {
      const reason = assertReason(body.reason);
      const po = await queryOne<Record<string, unknown>>(client, "SELECT * FROM inventory.purchase_orders WHERE id = $1 FOR UPDATE", [poId]);
      if (!po) throw new PlatformError("resource_not_found", "Purchase order not found", 404);
      if (po.merchant_id && po.merchant_id !== scope.merchantId) throw new PlatformError("forbidden", "Purchase order belongs to a different merchant", 403);
      if (po.store_id && po.store_id !== scope.storeId) throw new PlatformError("forbidden", "Purchase order belongs to a different store", 403);
      if (!["draft", "sent"].includes(String(po.status))) {
        throw new PlatformError("invalid_state_transition", "Only draft or sent purchase orders can be cancelled", 409, { status: po.status });
      }
      const received = await queryOne<{ received_quantity: string }>(client, `
        SELECT COALESCE(sum(received_quantity), 0)::text AS received_quantity
        FROM inventory.purchase_order_items
        WHERE purchase_order_id = $1
      `, [poId]);
      if (Number(received?.received_quantity || 0) > 0) {
        throw new PlatformError("invalid_state_transition", "Cannot cancel a purchase order after receiving stock", 409);
      }

      await client.query(`
        UPDATE inventory.purchase_orders
        SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now()
        WHERE id = $1
      `, [poId, actor.operatorId, reason]);
      await recordAuditEntry(client, actor, "purchase_order.cancelled", "purchase_order", poId, {
        after: { status: "cancelled", reason },
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return { data: await purchaseOrderDetailForClient(client, poId, scope) };
    });
    return result;
  });
}

export async function closeShortPurchaseOrder(headers: HeadersLike, poId: string, body: { reason?: string }, actor: OperatorContext, scope: OperatingScope) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
    const result = await withScopedIdempotency(client, headers, body, scope.merchantId, INV_OPS.closeShortPurchaseOrder, async () => {
      const reason = assertReason(body.reason);
      const po = await queryOne<Record<string, unknown>>(client, "SELECT * FROM inventory.purchase_orders WHERE id = $1 FOR UPDATE", [poId]);
      if (!po) throw new PlatformError("resource_not_found", "Purchase order not found", 404);
      if (po.merchant_id && po.merchant_id !== scope.merchantId) throw new PlatformError("forbidden", "Purchase order belongs to a different merchant", 403);
      if (po.store_id && po.store_id !== scope.storeId) throw new PlatformError("forbidden", "Purchase order belongs to a different store", 403);
      if (po.status !== "partially_received") {
        throw new PlatformError("invalid_state_transition", "Only partially received purchase orders can be closed short", 409, { status: po.status });
      }
      const quantities = await queryOne<{ any_received: boolean; any_remaining: boolean }>(client, `
        SELECT
          bool_or(received_quantity > 0) AS any_received,
          bool_or(received_quantity < quantity) AS any_remaining
        FROM inventory.purchase_order_items
        WHERE purchase_order_id = $1
      `, [poId]);
      if (!quantities?.any_received || !quantities?.any_remaining) {
        throw new PlatformError("invalid_state_transition", "Purchase order is not eligible for short close", 409);
      }

      await client.query(`
        UPDATE inventory.purchase_orders
        SET status = 'closed_short', closed_at = now(), closed_by = $2, close_reason = $3, updated_at = now()
        WHERE id = $1
      `, [poId, actor.operatorId, reason]);
      await recordAuditEntry(client, actor, "purchase_order.closed_short", "purchase_order", poId, {
        after: { status: "closed_short", reason },
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return { data: await purchaseOrderDetailForClient(client, poId, scope) };
    });
    return result;
  });
}
