import type { OperatingScope } from "@medusa-snus/contracts";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { dateOnlyCsvValue, serializeCsv, type CsvCell } from "./csv-export-service";
import { parseCsvRows } from "./csv-parse-service";
import { createPurchaseOrder } from "./inventory-service";
import { id } from "../utils/id";
import type { PoolClient } from "../db/client";
import type { HeadersLike } from "../http/headers";
import type { OperatorContext } from "./auth-service";
import { importApplyErrorMessage, type ImportPreviewResult, type ImportPreviewRow, type ImportApplyResult, type ImportApplyRow } from "./import-types";
import { calculatePurchaseOrderSuggestion } from "@medusa-snus/domain";
import { PlatformError } from "../errors/platform-error";

export const PURCHASE_ORDER_IMPORT_COLUMNS = [
  "supplierName",
  "expectedDate",
  "sku",
  "variantId",
  "quantity",
  "unitCost",
  "unitCostQuality",
] as const;

export const PURCHASE_ORDER_DETAIL_EXPORT_COLUMNS = [
  "poId",
  "supplierName",
  "status",
  "createdAt",
  "expectedDate",
  "sku",
  "variantId",
  "productName",
  "categoryNames",
  "orderedQuantity",
  "receivedQuantity",
  "remainingQuantity",
  "unitCost",
  "unitCostQuality",
  "orderedValue",
  "receivedValue",
  "valueAvailable",
  "lineStatus",
  "lastReceivedAt",
] as const;

export const PURCHASE_ORDER_RECOMMENDATION_COLUMNS = [
  "requestDate",
  "supplierName",
  "expectedDate",
  "sku",
  "variantId",
  "productName",
  "categoryNames",
  "stockStatus",
  "currentStock",
  "sold7Days",
  "sold30Days",
  "openPurchaseOrderQuantity",
  "systemSuggestedQuantity",
  "quantity",
  "unitCost",
  "unitCostQuality",
  "receivedQuantity",
  "internalNote",
] as const;

export function createPurchaseOrderImportTemplateCsv(): string {
  return serializeCsv(PURCHASE_ORDER_IMPORT_COLUMNS, []);
}

export async function createPurchaseOrderExportCsv(scope: OperatingScope): Promise<string> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const result = await client.query(`
      SELECT
        po.supplier_name,
        po.expected_date,
        COALESCE(v.sku, '') AS sku,
        poi.variant_id,
        poi.quantity,
        poi.unit_cost,
        CASE
          WHEN poi.unit_cost > 0 THEN 'known'
          WHEN po.metadata->'costQualityByItemId'->>poi.id = 'free' THEN 'free'
          ELSE 'unknown'
        END AS unit_cost_quality
      FROM inventory.purchase_orders po
      JOIN inventory.purchase_order_items poi ON poi.purchase_order_id = po.id
      JOIN public.product_variant v
        ON v.id = poi.variant_id
       AND v.deleted_at IS NULL
      JOIN public.product p
        ON p.id = v.product_id
       AND p.deleted_at IS NULL
       AND p.merchant_id = $1
      WHERE po.merchant_id = $1
        AND po.store_id = $2
      ORDER BY po.created_at DESC, po.id ASC, poi.created_at ASC, poi.id ASC
    `, [scope.merchantId, scope.storeId]);

    return serializeCsv(PURCHASE_ORDER_IMPORT_COLUMNS, result.rows.map((row) => [
      row.supplier_name,
      dateOnlyCsvValue(row.expected_date),
      row.sku,
      row.variant_id,
      Number(row.quantity || 0),
      Number(row.unit_cost || 0),
      row.unit_cost_quality,
    ]));
  });
}

export async function createPurchaseOrderDetailExportCsv(poId: string, scope: OperatingScope): Promise<string> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const po = await client.query(`
      SELECT id, supplier_name, status, created_at, expected_date, metadata
      FROM inventory.purchase_orders
      WHERE id = $1 AND merchant_id = $2 AND store_id = $3
    `, [poId, scope.merchantId, scope.storeId]);
    if (po.rows.length === 0) throw new PlatformError("resource_not_found", "Purchase order not found", 404);
    const header = po.rows[0];
    const result = await client.query(`
      SELECT
        poi.id,
        poi.variant_id,
        COALESCE(poi.sku_snapshot, v.sku, '') AS sku,
        COALESCE(poi.product_name_snapshot, p.title, '') AS product_name,
        COALESCE(poi.category_names_snapshot, cat.category_names, '[]'::jsonb) AS category_names,
        poi.quantity,
        poi.received_quantity,
        poi.unit_cost,
        max(por.received_at) AS last_received_at
      FROM inventory.purchase_order_items poi
      LEFT JOIN public.product_variant v ON v.id = poi.variant_id AND v.deleted_at IS NULL
      LEFT JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(pc.name ORDER BY pc.rank ASC, pc.name ASC), '[]'::jsonb) AS category_names
        FROM public.product_category_product pcp
        JOIN public.product_category pc ON pc.id = pcp.product_category_id AND pc.deleted_at IS NULL
        WHERE pcp.product_id = p.id
      ) cat ON true
      LEFT JOIN inventory.purchase_order_receipt_items pori ON pori.purchase_order_item_id = poi.id
      LEFT JOIN inventory.purchase_order_receipts por ON por.id = pori.receipt_id
      WHERE poi.purchase_order_id = $1
      GROUP BY poi.id, v.sku, p.title, cat.category_names
      ORDER BY poi.created_at ASC, poi.id ASC
    `, [poId]);

    return serializeCsv(PURCHASE_ORDER_DETAIL_EXPORT_COLUMNS, result.rows.map((row) => {
      const orderedQuantity = Number(row.quantity || 0);
      const receivedQuantity = Number(row.received_quantity || 0);
      const unitCost = Number(row.unit_cost || 0);
      const costQualityByItemId = header.metadata?.costQualityByItemId && typeof header.metadata.costQualityByItemId === "object"
        ? header.metadata.costQualityByItemId as Record<string, unknown>
        : {};
      const unitCostQuality = unitCost > 0
        ? "known"
        : costQualityByItemId[String(row.id)] === "free"
          ? "free"
          : "unknown";
      const valueAvailable = unitCostQuality !== "unknown";
      const remainingQuantity = Math.max(0, orderedQuantity - receivedQuantity);
      const categoryNames = Array.isArray(row.category_names) ? row.category_names.join("|") : "";
      const lineStatus = header.status === "closed_short" && remainingQuantity > 0
        ? "short_closed"
        : receivedQuantity <= 0
          ? "not_received"
          : remainingQuantity <= 0
            ? "received"
            : "partially_received";
      return [
        header.id,
        header.supplier_name,
        header.status,
        header.created_at instanceof Date ? header.created_at.toISOString() : String(header.created_at || ""),
        dateOnlyCsvValue(header.expected_date),
        row.sku,
        row.variant_id,
        row.product_name,
        categoryNames,
        orderedQuantity,
        receivedQuantity,
        remainingQuantity,
        unitCost,
        unitCostQuality,
        valueAvailable ? orderedQuantity * unitCost : "",
        valueAvailable ? receivedQuantity * unitCost : "",
        valueAvailable,
        lineStatus,
        row.last_received_at instanceof Date ? row.last_received_at.toISOString() : String(row.last_received_at || ""),
      ];
    }));
  });
}

export async function createPurchaseOrderRecommendationCsv(
  scope: OperatingScope,
  params: { coverageDays?: number; includeZeroSuggestion?: boolean } = {},
): Promise<string> {
  const coverageDays = Number.isInteger(params.coverageDays) && params.coverageDays && params.coverageDays > 0 ? params.coverageDays : 30;
  const includeZeroSuggestion = params.includeZeroSuggestion === true;
  const requestDate = new Date().toISOString().slice(0, 10);

  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const result = await client.query(`
      SELECT
        v.id AS variant_id,
        COALESCE(v.sku, '') AS sku,
        COALESCE(p.title, '') AS product_name,
        COALESCE(cat.category_names, '[]'::jsonb) AS category_names,
        COALESCE(il.stocked_quantity, 0)::numeric AS current_stock,
        COALESCE(ps.reorder_level, 5)::int AS reorder_level,
        COALESCE(ps.preferred_stock, 20)::int AS preferred_stock,
        COALESCE(ps.cost_price, 0)::numeric AS unit_cost,
        COALESCE(sales.sold_7_days, 0)::int AS sold_7_days,
        COALESCE(sales.sold_30_days, 0)::int AS sold_30_days,
        COALESCE(open_po.open_quantity, 0)::int AS open_purchase_order_quantity
      FROM public.product_variant v
      JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
      JOIN public.product_variant_inventory_item vii ON vii.variant_id = v.id AND vii.deleted_at IS NULL
      JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id
        AND il.location_id = $2
        AND il.deleted_at IS NULL
      LEFT JOIN inventory.product_settings ps ON ps.variant_id = v.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(pc.name ORDER BY pc.rank ASC, pc.name ASC), '[]'::jsonb) AS category_names
        FROM public.product_category_product pcp
        JOIN public.product_category pc ON pc.id = pcp.product_category_id AND pc.deleted_at IS NULL
        WHERE pcp.product_id = p.id
      ) cat ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(sum(CASE WHEN sm.created_at >= now() - interval '7 days' THEN -sm.quantity_change ELSE 0 END), 0)::int AS sold_7_days,
          COALESCE(sum(-sm.quantity_change), 0)::int AS sold_30_days
        FROM medusa.stock_movements sm
        WHERE sm.inventory_item_id = vii.inventory_item_id
          AND sm.merchant_id = $1
          AND sm.store_id = $3
          AND sm.stock_location_id = $2
          AND sm.movement_type = 'sale'
          AND sm.quantity_change < 0
          AND sm.created_at >= now() - interval '30 days'
      ) sales ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(GREATEST(poi.quantity - poi.received_quantity, 0)), 0)::int AS open_quantity
        FROM inventory.purchase_order_items poi
        JOIN inventory.purchase_orders po ON po.id = poi.purchase_order_id
        WHERE poi.variant_id = v.id
          AND po.merchant_id = $1
          AND po.store_id = $3
          AND po.status IN ('draft', 'sent', 'partially_received')
      ) open_po ON true
      WHERE v.deleted_at IS NULL
        AND p.merchant_id = $1
      ORDER BY p.title ASC, v.sku ASC, v.id ASC
    `, [scope.merchantId, scope.stockLocationId, scope.storeId]);

    const rows: CsvCell[][] = [];
    for (const row of result.rows) {
      const currentStock = Number(row.current_stock || 0);
      const reorderLevel = Number(row.reorder_level || 5);
      const suggestedQuantity = calculatePurchaseOrderSuggestion({
        sold7Days: Number(row.sold_7_days || 0),
        sold30Days: Number(row.sold_30_days || 0),
        currentStock,
        openPurchaseOrderQuantity: Number(row.open_purchase_order_quantity || 0),
        reorderLevel,
        preferredStock: Number(row.preferred_stock || 20),
        coverageDays,
      });
      if (!includeZeroSuggestion && suggestedQuantity <= 0) continue;
      const stockStatus = currentStock <= 0 ? "out_of_stock" : currentStock <= reorderLevel ? "low_stock" : "available";
      const categoryNames = Array.isArray(row.category_names) ? row.category_names.join("|") : "";
      rows.push([
        requestDate,
        "",
        "",
        row.sku,
        row.variant_id,
        row.product_name,
        categoryNames,
        stockStatus,
        currentStock,
        Number(row.sold_7_days || 0),
        Number(row.sold_30_days || 0),
        Number(row.open_purchase_order_quantity || 0),
        suggestedQuantity,
        suggestedQuantity,
        Number(row.unit_cost || 0),
        Number(row.unit_cost || 0) > 0 ? "known" : "unknown",
        "",
        `coverageDays=${coverageDays}; remove internal stock/sales columns before sending to supplier if needed`,
      ]);
    }

    return serializeCsv(PURCHASE_ORDER_RECOMMENDATION_COLUMNS, rows);
  });
}

// ── Import Preview (no mutation) ──────────────────────────

interface VariantInfo {
  variantId: string;
  sku: string;
}

async function resolveVariant(
  client: PoolClient,
  row: Record<string, string>,
  scope: OperatingScope,
): Promise<VariantInfo | null> {
  const variantId = (row.variantId || "").trim();
  const sku = (row.sku || "").trim();
  const lookupId = variantId || sku;
  if (!lookupId) return null;

  const result = await client.query(`
    SELECT v.id AS variant_id, COALESCE(v.sku, '') AS sku
    FROM public.product_variant v
    JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
    JOIN public.product_variant_inventory_item vii ON vii.variant_id = v.id AND vii.deleted_at IS NULL
    JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id AND il.deleted_at IS NULL
    WHERE v.deleted_at IS NULL
      AND (v.id = $1 OR v.sku = $1)
      AND p.merchant_id = $2
      AND il.location_id = $3
    LIMIT 1
  `, [lookupId, scope.merchantId, scope.stockLocationId]);

  if (result.rows.length === 0) return null;
  return {
    variantId: String(result.rows[0].variant_id),
    sku: String(result.rows[0].sku),
  };
}

interface POGroup {
  supplierName: string;
  expectedDate: string;
  items: Array<{ variantId: string; quantity: number; unitCost: number; unitCostQuality: "known" | "free"; rowNumber: number }>;
  rowNumbers: number[];
}

function validatePORow(
  row: Record<string, string>,
  rowNumber: number,
  variantInfo: VariantInfo | null,
): ImportPreviewRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  const supplierName = (row.supplierName || "").trim();
  if (!supplierName) {
    errors.push("supplierName bắt buộc");
  }

  const variantId = (row.variantId || "").trim();
  const sku = (row.sku || "").trim();
  if (!variantId && !sku) {
    errors.push("Phải cung cấp variantId hoặc sku");
  } else if (!variantInfo) {
    errors.push("Sản phẩm không tồn tại hoặc không thuộc cửa hàng hiện tại");
  }

  const quantity = Number(row.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    errors.push("quantity phải là số nguyên dương");
  }

  const unitCostText = String(row.unitCost || "").trim();
  const unitCost = Number(unitCostText);
  const requestedCostQuality = String(row.unitCostQuality || "").trim().toLowerCase();
  if (!unitCostText || !Number.isFinite(unitCost) || unitCost < 0) {
    errors.push("unitCost bắt buộc và phải là số không âm");
  }
  if (requestedCostQuality && requestedCostQuality !== "known" && requestedCostQuality !== "free") {
    errors.push("unitCostQuality chỉ nhận known hoặc free");
  }
  const unitCostQuality = requestedCostQuality === "free" ? "free" : "known";
  if (unitCost === 0 && unitCostQuality !== "free") {
    errors.push("unitCost 0 phải được xác nhận bằng unitCostQuality=free");
  }
  if (unitCost > 0 && requestedCostQuality === "free") {
    errors.push("unitCostQuality=free yêu cầu unitCost bằng 0");
  }

  const expectedDate = (row.expectedDate || "").trim();

  return {
    rowNumber,
    action: "create_po_line",
    status: errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid",
    errors,
    warnings,
    normalized: {
      supplierName,
      expectedDate,
      variantId: variantInfo?.variantId || variantId,
      sku: variantInfo?.sku || sku,
      quantity: Number.isInteger(quantity) ? quantity : 0,
      unitCost: Number.isFinite(unitCost) ? Math.round(unitCost) : 0,
      unitCostQuality,
    },
  };
}

export async function previewPurchaseOrderImport(csvText: string, scope: OperatingScope): Promise<ImportPreviewResult> {
  const rows = parseCsvRows(csvText, PURCHASE_ORDER_IMPORT_COLUMNS);
  const importId = id("imp");

  if (rows.length === 0) {
    return {
      importId,
      valid: true,
      summary: { totalRows: 0, validRows: 0, errorRows: 0, warningRows: 0 },
      rows: [],
    };
  }

  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const previewRows: ImportPreviewRow[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const variantInfo = await resolveVariant(client, row, scope);
      previewRows.push(validatePORow(row, i + 2, variantInfo));
    }

    const errorRows = previewRows.filter((r) => r.status === "error").length;
    const warningRows = previewRows.filter((r) => r.status === "warning").length;
    const validRows = previewRows.filter((r) => r.status === "valid").length;

    return {
      importId,
      valid: errorRows === 0,
      summary: { totalRows: previewRows.length, validRows, errorRows, warningRows },
      rows: previewRows,
    };
  });
}

// ── Import Apply (creates draft POs — receiving remains explicit) ──

export async function applyPurchaseOrderImport(
  headers: HeadersLike,
  csvText: string,
  actor: OperatorContext,
  scope: OperatingScope,
): Promise<ImportApplyResult> {
  const preview = await previewPurchaseOrderImport(csvText, scope);
  if (!preview.valid) {
    return {
      importId: preview.importId,
      appliedRows: 0,
      skippedRows: preview.summary.errorRows,
      errorRows: preview.summary.errorRows,
      rows: preview.rows.map((r) => ({
        rowNumber: r.rowNumber,
        action: r.action,
        status: r.status === "error" ? "error" as const : "skipped" as const,
        errors: r.errors,
      })),
    };
  }

  // Group rows into POs by supplierName + expectedDate
  const poGroups = new Map<string, POGroup>();
  for (const row of preview.rows) {
    const n = row.normalized;
    const key = `${String(n.supplierName)}|${String(n.expectedDate)}`;
    let group = poGroups.get(key);
    if (!group) {
      group = {
        supplierName: String(n.supplierName),
        expectedDate: String(n.expectedDate),
        items: [],
        rowNumbers: [],
      };
      poGroups.set(key, group);
    }
    group.items.push({
      variantId: String(n.variantId),
      quantity: Number(n.quantity),
      unitCost: Number(n.unitCost),
      unitCostQuality: n.unitCostQuality === "free" ? "free" : "known",
      rowNumber: row.rowNumber,
    });
    group.rowNumbers.push(row.rowNumber);
  }

  const applyRows: ImportApplyRow[] = [];
  let appliedCount = 0;
  let errorCount = 0;

  for (const [, group] of poGroups) {
    const poHeaders: HeadersLike = {
      "idempotency-key": `${preview.importId}-po-${group.supplierName}-${group.expectedDate}`,
    };

    try {
      const result = await createPurchaseOrder(
        poHeaders,
        {
          supplierName: group.supplierName,
          items: group.items.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            unitCost: item.unitCost,
            unitCostQuality: item.unitCostQuality,
          })),
          expectedDate: group.expectedDate || undefined,
          source: "csv_import",
        },
        actor,
        scope,
      );

      const poId = result.response?.data?.id;
      for (const item of group.items) {
        applyRows.push({
          rowNumber: item.rowNumber,
          action: "create_po_line",
          status: "applied",
          entityId: poId ? String(poId) : undefined,
          errors: [],
        });
      }
      appliedCount += group.items.length;
    } catch (err) {
      const message = importApplyErrorMessage(err);
      for (const item of group.items) {
        applyRows.push({
          rowNumber: item.rowNumber,
          action: "create_po_line",
          status: "error",
          errors: [message],
        });
      }
      errorCount += group.items.length;
    }
  }

  // Sort by row number for consistent output
  applyRows.sort((a, b) => a.rowNumber - b.rowNumber);

  return {
    importId: preview.importId,
    appliedRows: appliedCount,
    skippedRows: 0,
    errorRows: errorCount,
    rows: applyRows,
  };
}
