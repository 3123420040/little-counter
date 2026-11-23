import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { serializeCsv } from "./csv-export-service";
import { parseCsvRows } from "./csv-parse-service";
import { normalizeProductImageUrl } from "./product-image-url";
import { createProduct, getDefaultVariantRow, updateProduct } from "./product-management-service";
import { requestProductImageAutofill } from "./product-image-autofill-service";
import { id } from "../utils/id";
import type { PoolClient } from "../db/client";
import type { HeadersLike } from "../http/headers";
import type { OperatorContext } from "./auth-service";
import type { MerchantTargetScope, OperatingScope } from "@medusa-snus/contracts";
import { importApplyErrorMessage, type ImportPreviewResult, type ImportPreviewRow, type ImportApplyResult, type ImportApplyRow } from "./import-types";

export const PRODUCT_IMPORT_COLUMNS = [
  "action",
  "productId",
  "title",
  "status",
  "sku",
  "barcode",
  "price",
  "costPrice",
  "reorderLevel",
  "categoryHandles",
  "imageUrl",
] as const;

export function createProductImportTemplateCsv(): string {
  return serializeCsv(PRODUCT_IMPORT_COLUMNS, []);
}

export async function createProductExportCsv(merchantId: string): Promise<string> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const result = await client.query(`
      SELECT
        p.id AS product_id,
        p.title,
        p.status,
        p.metadata->>'imageUrl' AS image_url,
        COALESCE(variant.sku, '') AS sku,
        COALESCE(variant.barcode, '') AS barcode,
        COALESCE(variant.price, 0)::numeric AS price,
        COALESCE(variant.cost_price, 0)::numeric AS cost_price,
        COALESCE(variant.reorder_level, 5) AS reorder_level,
        COALESCE(categories.category_handles, ARRAY[]::text[]) AS category_handles
      FROM public.product p
      LEFT JOIN LATERAL (
        SELECT
          pv.sku,
          pv.barcode,
          COALESCE((
            SELECT pr.amount
            FROM public.product_variant_price_set vps
            JOIN public.price pr
              ON pr.price_set_id = vps.price_set_id
             AND pr.currency_code = 'vnd'
             AND pr.deleted_at IS NULL
            WHERE vps.variant_id = pv.id
              AND vps.deleted_at IS NULL
            ORDER BY pr.created_at ASC, pr.id ASC
            LIMIT 1
          ), 0) AS price,
          COALESCE(ps.cost_price, 0) AS cost_price,
          COALESCE(ps.reorder_level, 5) AS reorder_level
        FROM public.product_variant pv
        LEFT JOIN inventory.product_settings ps ON ps.variant_id = pv.id
        WHERE pv.product_id = p.id
          AND pv.deleted_at IS NULL
        ORDER BY COALESCE(pv.variant_rank, 0) ASC, pv.created_at ASC, pv.id ASC
        LIMIT 1
      ) variant ON true
      LEFT JOIN LATERAL (
        SELECT array_agg(pc.handle ORDER BY pc.rank ASC, pc.name ASC) AS category_handles
        FROM public.product_category_product pcp
        JOIN public.product_category pc
          ON pc.id = pcp.product_category_id
         AND pc.deleted_at IS NULL
         AND pc.merchant_id = $1
        WHERE pcp.product_id = p.id
      ) categories ON true
      WHERE p.deleted_at IS NULL
        AND p.merchant_id = $1
      ORDER BY p.updated_at DESC, p.title ASC, p.id ASC
    `, [merchantId]);

    return serializeCsv(PRODUCT_IMPORT_COLUMNS, result.rows.map((row) => [
      "update",
      row.product_id,
      row.title,
      row.status,
      row.sku,
      row.barcode,
      Number(row.price || 0),
      Number(row.cost_price || 0),
      Number(row.reorder_level || 0),
      Array.isArray(row.category_handles) ? row.category_handles.join("|") : "",
      row.image_url || "",
    ]));
  });
}

// ── Import Preview (no mutation) ──────────────────────────

async function resolveExistingSkus(client: PoolClient, merchantId: string): Promise<Map<string, string>> {
  const result = await client.query(`
    SELECT lower(btrim(pv.sku)) AS sku, pv.id AS variant_id
    FROM public.product_variant pv
    JOIN public.product p ON p.id = pv.product_id AND p.deleted_at IS NULL
    WHERE pv.deleted_at IS NULL AND p.merchant_id = $1
  `, [merchantId]);
  const map = new Map<string, string>();
  for (const row of result.rows) {
    if (row.sku) map.set(String(row.sku), String(row.variant_id));
  }
  return map;
}

async function resolveExistingBarcodes(client: PoolClient, merchantId: string): Promise<Map<string, string>> {
  const result = await client.query(`
    SELECT lower(btrim(pv.barcode)) AS barcode, pv.id AS variant_id
    FROM public.product_variant pv
    JOIN public.product p ON p.id = pv.product_id AND p.deleted_at IS NULL
    WHERE pv.deleted_at IS NULL AND pv.barcode IS NOT NULL AND pv.barcode <> '' AND p.merchant_id = $1
  `, [merchantId]);
  const map = new Map<string, string>();
  for (const row of result.rows) {
    if (row.barcode) map.set(String(row.barcode), String(row.variant_id));
  }
  return map;
}

async function resolveProductById(client: PoolClient, productId: string, merchantId: string): Promise<{ id: string; variantId: string; inventoryItemId: string | null } | null> {
  const product = await client.query("SELECT id FROM public.product WHERE id=$1 AND merchant_id=$2 AND deleted_at IS NULL", [productId, merchantId]);
  if (!product.rows.length) return null;
  const variant = await getDefaultVariantRow(client, productId);
  return variant ? { id: productId, variantId: variant.id, inventoryItemId: variant.inventory_item_id } : null;
}

async function resolveCategoryHandles(client: PoolClient, handles: string[], merchantId: string): Promise<{ found: string[]; missing: string[] }> {
  if (handles.length === 0) return { found: [], missing: [] };
  const result = await client.query(`
    SELECT id, handle
    FROM public.product_category
    WHERE lower(handle) = ANY($1::text[])
      AND deleted_at IS NULL
      AND merchant_id = $2
      AND is_active = true
      AND is_internal = false
  `, [handles.map((h) => h.toLowerCase()), merchantId]);
  const foundHandles = new Set(result.rows.map((r) => String(r.handle).toLowerCase()));
  const found = result.rows.map((r) => String(r.id));
  const missing = handles.filter((h) => !foundHandles.has(h.toLowerCase()));
  return { found, missing };
}

const VALID_STATUSES = new Set(["draft", "proposed", "published", "rejected"]);

function validateProductRow(
  row: Record<string, string>,
  rowNumber: number,
  skusSeen: Set<string>,
  barcodesSeen: Set<string>,
  existingSkus: Map<string, string>,
  existingBarcodes: Map<string, string>,
  categoryResult: { found: string[]; missing: string[] },
  productLookup: { id: string; variantId: string; inventoryItemId: string | null } | null,
  codeKeys: Map<string, string>,
  inventorySkus: Map<string, string>,
): ImportPreviewRow {
  const errors: string[] = [];
  const warnings: string[] = [];
  const action = (row.action || "").toLowerCase();

  if (action !== "create" && action !== "update") {
    errors.push("action phải là 'create' hoặc 'update'");
  }

  const title = (row.title || "").trim();
  if (title.length < 2) {
    errors.push("title phải có ít nhất 2 ký tự");
  }

  const status = (row.status || "published").trim();
  if (!VALID_STATUSES.has(status)) {
    errors.push("status không hợp lệ (draft, proposed, published, rejected)");
  }

  const sku = (row.sku || "").trim();
  const barcode = (row.barcode || "").trim();
  const price = Number(row.price);
  const costPrice = Number(row.costPrice);
  const reorderLevel = Number(row.reorderLevel);

  if (sku && skusSeen.has(codeKeys.get(sku)!)) {
    errors.push("SKU đã trùng trong file import");
  }
  if (barcode && barcodesSeen.has(codeKeys.get(barcode)!)) {
    errors.push("Barcode đã trùng trong file import");
  }

  const occupiedItem = sku ? inventorySkus.get(codeKeys.get(sku)!) : undefined;
  if (occupiedItem && (action !== "update" || occupiedItem !== productLookup?.inventoryItemId)) {
    errors.push("SKU đã tồn tại trong inventory của merchant hiện tại");
  }

  if (action === "update") {
    const productId = (row.productId || "").trim();
    if (!productId) {
      errors.push("productId bắt buộc khi action là 'update'");
    } else if (!productLookup) {
      errors.push("Sản phẩm không tồn tại hoặc không thuộc merchant hiện tại");
    } else {
      // For update, check SKU uniqueness against existing SKUs excluding current variant
      if (sku) {
        const existingVariantId = existingSkus.get(codeKeys.get(sku)!);
        if (existingVariantId && existingVariantId !== productLookup.variantId) {
          errors.push("SKU đã tồn tại");
        }
      }
      if (barcode) {
        const existingVariantId = existingBarcodes.get(codeKeys.get(barcode)!);
        if (existingVariantId && existingVariantId !== productLookup.variantId) {
          errors.push("Barcode đã tồn tại");
        }
      }
    }
  } else if (action === "create") {
    if (sku) {
      const existingVariantId = existingSkus.get(codeKeys.get(sku)!);
      if (existingVariantId) {
        errors.push("SKU đã tồn tại");
      }
    }
    if (barcode) {
      const existingVariantId = existingBarcodes.get(codeKeys.get(barcode)!);
      if (existingVariantId) {
        errors.push("Barcode đã tồn tại");
      }
    }
  }

  if (row.price !== "" && (!Number.isFinite(price) || price < 0)) {
    errors.push("price phải là số không âm");
  }
  if (row.costPrice !== "" && (!Number.isFinite(costPrice) || costPrice < 0)) {
    errors.push("costPrice phải là số không âm");
  }
  if (row.reorderLevel !== "" && (!Number.isFinite(reorderLevel) || reorderLevel < 0)) {
    errors.push("reorderLevel phải là số không âm");
  }

  // Image URL validation
  const imageUrl = (row.imageUrl || "").trim();
  if (imageUrl) {
    try {
      normalizeProductImageUrl(imageUrl);
    } catch {
      errors.push("imageUrl phải là URL HTTPS hợp lệ");
    }
  }

  // Category handle validation
  if (categoryResult.missing.length > 0) {
    errors.push(`Danh mục không tồn tại hoặc không thuộc merchant hiện tại: ${categoryResult.missing.join(", ")}`);
  }

  if (sku) skusSeen.add(codeKeys.get(sku)!);
  if (barcode) barcodesSeen.add(codeKeys.get(barcode)!);

  return {
    rowNumber,
    action,
    status: errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid",
    errors,
    warnings,
    normalized: {
      action,
      productId: (row.productId || "").trim(),
      title,
      status,
      sku,
      barcode,
      price: Number.isFinite(price) ? Math.round(price) : 0,
      costPrice: Number.isFinite(costPrice) ? Math.round(costPrice) : 0,
      reorderLevel: Number.isFinite(reorderLevel) ? Math.trunc(reorderLevel) : 5,
      categoryIds: categoryResult.found,
      imageUrl,
    },
  };
}

export async function previewProductImport(csvText: string, merchantId: string): Promise<ImportPreviewResult> {
  const rows = parseCsvRows(csvText, PRODUCT_IMPORT_COLUMNS);
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
    const existingSkus = await resolveExistingSkus(client, merchantId);
    const inventoryRows = await client.query<{ sku: string; id: string }>(
      "SELECT lower(btrim(sku)) AS sku,id FROM public.inventory_item WHERE merchant_id=$1 AND deleted_at IS NULL AND nullif(btrim(sku),'') IS NOT NULL", [merchantId],
    );
    const inventorySkus = new Map(inventoryRows.rows.map((row) => [row.sku, row.id]));
    const existingBarcodes = await resolveExistingBarcodes(client, merchantId);

    const codes = [...new Set(rows.flatMap((row) => [(row.sku || "").trim(), (row.barcode || "").trim()]))];
    const normalized = await client.query<{ code: string; key: string }>(
      "SELECT code, lower(btrim(code)) AS key FROM unnest($1::text[]) AS input(code)", [codes],
    );
    const codeKeys = new Map(normalized.rows.map((row) => [row.code, row.key]));
    const skusSeen = new Set<string>();
    const barcodesSeen = new Set<string>();
    const previewRows: ImportPreviewRow[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const handles = (row.categoryHandles || "").split("|").map((h) => h.trim()).filter(Boolean);
      const categoryResult = await resolveCategoryHandles(client, handles, merchantId);
      const action = (row.action || "").toLowerCase();
      const productId = (row.productId || "").trim();
      const productLookup = action === "update" && productId
        ? await resolveProductById(client, productId, merchantId)
        : null;

      previewRows.push(validateProductRow(row, i + 2, skusSeen, barcodesSeen, existingSkus, existingBarcodes, categoryResult, productLookup, codeKeys, inventorySkus));
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

// ── Import Apply (uses domain services) ───────────────────

export async function applyProductImport(
  headers: HeadersLike,
  csvText: string,
  actor: OperatorContext,
  scope: MerchantTargetScope,
  operatingScope: OperatingScope,
): Promise<ImportApplyResult> {
  // First preview to validate
  const preview = await previewProductImport(csvText, scope.merchantId);
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
    const action = String(n.action);
    const rowHeaders: HeadersLike = {
      "idempotency-key": `${preview.importId}-row-${row.rowNumber}`,
    };

    try {
      if (action === "create") {
        const result = await createProduct(
          rowHeaders,
          {
            title: String(n.title),
            status: String(n.status),
            sku: String(n.sku),
            barcode: n.barcode ? String(n.barcode) : undefined,
            price: Number(n.price),
            costPrice: Number(n.costPrice),
            reorderLevel: Number(n.reorderLevel),
            categoryIds: n.categoryIds as string[],
            imageUrl: n.imageUrl ? String(n.imageUrl) : undefined,
          },
          actor,
          scope,
          operatingScope,
        );
        applyRows.push({
          rowNumber: row.rowNumber,
          action,
          status: "applied",
          entityId: result.response?.product?.id,
          errors: [],
        });
        appliedCount += 1;
      } else if (action === "update") {
        const productId = String(n.productId);
        const result = await updateProduct(
          rowHeaders,
          productId,
          {
            title: String(n.title),
            status: String(n.status),
            sku: String(n.sku),
            barcode: n.barcode ? String(n.barcode) : undefined,
            price: Number(n.price),
            costPrice: Number(n.costPrice),
            reorderLevel: Number(n.reorderLevel),
            categoryIds: n.categoryIds as string[],
            imageUrl: n.imageUrl ? String(n.imageUrl) : undefined,
          },
          actor,
          scope,
          operatingScope,
        );
        applyRows.push({
          rowNumber: row.rowNumber,
          action,
          status: "applied",
          entityId: result.response?.product?.id || productId,
          errors: [],
        });
        if (!n.imageUrl && !result.response?.product?.imageUrl) {
          await requestProductImageAutofill({
            productId,
            merchantId: scope.merchantId,
            storeId: operatingScope.storeId,
            title: String(n.title),
            sku: String(n.sku),
            source: "product.import.update",
            requestedBy: actor.operatorId,
          });
        }
        appliedCount += 1;
      }
    } catch (err) {
      const message = importApplyErrorMessage(err);
      applyRows.push({
        rowNumber: row.rowNumber,
        action,
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
