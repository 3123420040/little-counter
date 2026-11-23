import type { OperatingScope } from "@medusa-snus/contracts";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { serializeCsv } from "./csv-export-service";
import { parseCsvRows } from "./csv-parse-service";
import { adjustStock } from "./inventory-service";
import { id } from "../utils/id";
import type { PoolClient } from "../db/client";
import type { HeadersLike } from "../http/headers";
import type { OperatorContext } from "./auth-service";
import { importApplyErrorMessage, type ImportPreviewResult, type ImportPreviewRow, type ImportApplyResult, type ImportApplyRow } from "./import-types";

export const INVENTORY_ADJUSTMENT_IMPORT_COLUMNS = [
  "sku",
  "variantId",
  "inventoryItemId",
  "adjustment",
  "reason",
  "movementType",
] as const;

export const INVENTORY_ADJUSTMENT_EXPORT_COLUMNS = [
  ...INVENTORY_ADJUSTMENT_IMPORT_COLUMNS,
  "stockQuantity",
  "productName",
  "categoryName",
  "status",
] as const;

export function createInventoryAdjustmentImportTemplateCsv(): string {
  return serializeCsv(INVENTORY_ADJUSTMENT_IMPORT_COLUMNS, []);
}

export async function createInventoryAdjustmentExportCsv(scope: OperatingScope): Promise<string> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const result = await client.query(`
      SELECT
        COALESCE(v.sku, ii.sku, '') AS sku,
        v.id AS variant_id,
        ii.id AS inventory_item_id,
        COALESCE(il.stocked_quantity, 0)::numeric AS stock_quantity,
        COALESCE(p.title, ii.title, '') AS product_name,
        COALESCE(categories.category_names, ARRAY[]::text[]) AS category_names,
        COALESCE(p.status, 'draft') AS status
      FROM public.inventory_item ii
      JOIN public.product_variant_inventory_item vii
        ON vii.inventory_item_id = ii.id
       AND vii.deleted_at IS NULL
      JOIN public.product_variant v
        ON v.id = vii.variant_id
       AND v.deleted_at IS NULL
      JOIN public.product p
        ON p.id = v.product_id
       AND p.deleted_at IS NULL
      JOIN public.inventory_level il
        ON il.inventory_item_id = ii.id
       AND il.deleted_at IS NULL
       AND il.location_id = $1
      LEFT JOIN LATERAL (
        SELECT array_agg(pc.name ORDER BY pc.rank ASC, pc.name ASC) AS category_names
        FROM public.product_category_product pcp
        JOIN public.product_category pc
          ON pc.id = pcp.product_category_id
         AND pc.deleted_at IS NULL
         AND pc.merchant_id = $2
        WHERE pcp.product_id = p.id
      ) categories ON true
      WHERE ii.deleted_at IS NULL
        AND p.merchant_id = $2
      ORDER BY p.title ASC, v.id ASC
    `, [scope.stockLocationId, scope.merchantId]);

    return serializeCsv(INVENTORY_ADJUSTMENT_EXPORT_COLUMNS, result.rows.map((row) => [
      row.sku,
      row.variant_id,
      row.inventory_item_id,
      "",
      "",
      "manual_adjustment",
      Number(row.stock_quantity || 0),
      row.product_name || "",
      Array.isArray(row.category_names) ? row.category_names.join("|") : "",
      row.status || "",
    ]));
  });
}

// ── Import Preview (no mutation) ──────────────────────────

interface InventoryItemInfo {
  inventoryItemId: string;
  variantId: string;
  stock: number;
}

async function resolveInventoryItem(
  client: PoolClient,
  row: Record<string, string>,
  scope: OperatingScope,
): Promise<InventoryItemInfo | null> {
  const sku = (row.sku || "").trim();
  const variantId = (row.variantId || "").trim();
  const inventoryItemId = (row.inventoryItemId || "").trim();

  // Try to resolve by any of the three identifiers
  const lookupId = inventoryItemId || variantId || sku;
  if (!lookupId) return null;

  const result = await client.query(`
    SELECT
      vii.inventory_item_id,
      vii.variant_id,
      COALESCE(il.stocked_quantity, 0)::numeric AS stock
    FROM public.product_variant_inventory_item vii
    JOIN public.inventory_level il ON il.inventory_item_id = vii.inventory_item_id AND il.deleted_at IS NULL
    JOIN public.product_variant v ON v.id = vii.variant_id AND v.deleted_at IS NULL
    JOIN public.product p ON p.id = v.product_id AND p.deleted_at IS NULL
    WHERE vii.deleted_at IS NULL
      AND (vii.inventory_item_id = $1 OR vii.variant_id = $1 OR v.sku = $1)
      AND il.location_id = $2
      AND p.merchant_id = $3
    LIMIT 1
  `, [lookupId, scope.stockLocationId, scope.merchantId]);

  if (result.rows.length === 0) return null;
  return {
    inventoryItemId: String(result.rows[0].inventory_item_id),
    variantId: String(result.rows[0].variant_id),
    stock: Number(result.rows[0].stock),
  };
}

function validateInventoryRow(
  row: Record<string, string>,
  rowNumber: number,
  itemInfo: InventoryItemInfo | null,
): ImportPreviewRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  const sku = (row.sku || "").trim();
  const variantId = (row.variantId || "").trim();
  const inventoryItemId = (row.inventoryItemId || "").trim();

  if (!sku && !variantId && !inventoryItemId) {
    errors.push("Phải cung cấp sku, variantId, hoặc inventoryItemId");
  } else if (!itemInfo) {
    errors.push("Sản phẩm không tồn tại hoặc không thuộc cửa hàng hiện tại");
  }

  const adjustment = Number(row.adjustment);
  if (!Number.isInteger(adjustment) || adjustment === 0) {
    errors.push("adjustment phải là số nguyên khác 0");
  }

  if (itemInfo && Number.isInteger(adjustment)) {
    const newStock = itemInfo.stock + adjustment;
    if (newStock < 0) {
      errors.push(`Số lượng điều chỉnh làm tồn kho âm (hiện tại: ${itemInfo.stock}, điều chỉnh: ${adjustment})`);
    }
  }

  const movementType = (row.movementType || "manual_adjustment").trim();
  const reason = (row.reason || "").trim();

  return {
    rowNumber,
    action: "adjust",
    status: errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid",
    errors,
    warnings,
    normalized: {
      inventoryItemId: itemInfo?.inventoryItemId || inventoryItemId,
      variantId: itemInfo?.variantId || variantId,
      sku,
      adjustment,
      reason: reason || "Import adjustment",
      movementType,
      currentStock: itemInfo?.stock ?? null,
    },
  };
}

export async function previewInventoryImport(csvText: string, scope: OperatingScope): Promise<ImportPreviewResult> {
  const rows = parseCsvRows(csvText, INVENTORY_ADJUSTMENT_IMPORT_COLUMNS);
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
      const itemInfo = await resolveInventoryItem(client, row, scope);
      previewRows.push(validateInventoryRow(row, i + 2, itemInfo));
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

// ── Import Apply (uses adjustStock — never direct stock writes) ──

export async function applyInventoryImport(
  headers: HeadersLike,
  csvText: string,
  actor: OperatorContext,
  scope: OperatingScope,
): Promise<ImportApplyResult> {
  const preview = await previewInventoryImport(csvText, scope);
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

  const applyRows: ImportApplyRow[] = [];
  let appliedCount = 0;
  let errorCount = 0;

  for (const row of preview.rows) {
    const n = row.normalized;
    const rowHeaders: HeadersLike = {
      "idempotency-key": `${preview.importId}-row-${row.rowNumber}`,
    };

    try {
      await adjustStock(
        rowHeaders,
        {
          inventoryItemId: String(n.inventoryItemId),
          adjustment: Number(n.adjustment),
          reason: String(n.reason),
          movementType: String(n.movementType),
          sourceAction: "csv_import",
          reasonCode: String(n.reason || "csv_import"),
          referenceType: "inventory_import",
          referenceId: preview.importId,
          referenceDisplay: `${preview.importId} row ${row.rowNumber}`,
          sourceChannel: "csv_import",
          metadata: {
            importId: preview.importId,
            rowNumber: row.rowNumber,
            sku: n.sku,
            variantId: n.variantId,
          },
        },
        actor,
        scope,
      );
      applyRows.push({
        rowNumber: row.rowNumber,
        action: "adjust",
        status: "applied",
        entityId: String(n.inventoryItemId),
        errors: [],
      });
      appliedCount += 1;
    } catch (err) {
      const message = importApplyErrorMessage(err);
      applyRows.push({
        rowNumber: row.rowNumber,
        action: "adjust",
        status: "error",
        errors: [message],
      });
      errorCount += 1;
    }
  }

  return {
    importId: preview.importId,
    appliedRows: appliedCount,
    skippedRows: 0,
    errorRows: errorCount,
    rows: applyRows,
  };
}
