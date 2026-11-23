import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { serializeCsv } from "./csv-export-service";
import { parseCsvRows } from "./csv-parse-service";
import { createProductCategory, updateProductCategory } from "./product-category-service";
import { id } from "../utils/id";
import type { PoolClient } from "../db/client";
import type { HeadersLike } from "../http/headers";
import type { OperatorContext } from "./auth-service";
import type { MerchantTargetScope } from "@medusa-snus/contracts";
import { importApplyErrorMessage, type ImportPreviewResult, type ImportPreviewRow, type ImportApplyResult, type ImportApplyRow } from "./import-types";

export const CATEGORY_IMPORT_COLUMNS = [
  "action",
  "categoryId",
  "name",
  "handle",
  "description",
  "rank",
  "isActive",
] as const;

export function createCategoryImportTemplateCsv(): string {
  return serializeCsv(CATEGORY_IMPORT_COLUMNS, []);
}

export async function createCategoryExportCsv(merchantId: string): Promise<string> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const result = await client.query(`
      SELECT
        pc.id AS category_id,
        pc.name,
        pc.handle,
        pc.description,
        pc.rank,
        pc.is_active
      FROM public.product_category pc
      WHERE pc.deleted_at IS NULL
        AND pc.merchant_id = $1
      ORDER BY pc.rank ASC, pc.name ASC, pc.id ASC
    `, [merchantId]);

    return serializeCsv(CATEGORY_IMPORT_COLUMNS, result.rows.map((row) => [
      "update",
      row.category_id,
      row.name,
      row.handle,
      row.description || "",
      Number(row.rank || 0),
      Boolean(row.is_active),
    ]));
  });
}

// ── Import Preview (no mutation) ──────────────────────────

async function resolveExistingHandles(client: PoolClient, merchantId: string): Promise<Map<string, string>> {
  const result = await client.query(`
    SELECT lower(handle) AS handle, id
    FROM public.product_category
    WHERE deleted_at IS NULL AND merchant_id = $1
  `, [merchantId]);
  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(String(row.handle), String(row.id));
  }
  return map;
}

async function resolveCategoryById(client: PoolClient, categoryId: string, merchantId: string): Promise<string | null> {
  const result = await client.query(`
    SELECT id FROM public.product_category
    WHERE id = $1 AND deleted_at IS NULL AND merchant_id = $2
    LIMIT 1
  `, [categoryId, merchantId]);
  return result.rows.length > 0 ? String(result.rows[0].id) : null;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function validateCategoryRow(
  row: Record<string, string>,
  rowNumber: number,
  handlesSeen: Set<string>,
  existingHandles: Map<string, string>,
  categoryLookup: string | null,
): ImportPreviewRow {
  const errors: string[] = [];
  const warnings: string[] = [];
  const action = (row.action || "").toLowerCase();

  if (action !== "create" && action !== "update") {
    errors.push("action phải là 'create' hoặc 'update'");
  }

  const name = (row.name || "").trim();
  if (name.length < 2 || name.length > 80) {
    errors.push("name phải từ 2 đến 80 ký tự");
  }

  const rawHandle = (row.handle || "").trim();
  const handle = rawHandle ? slugify(rawHandle) : slugify(name);

  if (!handle) {
    errors.push("handle không hợp lệ");
  }

  if (handle && handlesSeen.has(handle.toLowerCase())) {
    errors.push("Handle đã trùng trong file import");
  }

  const rank = Number(row.rank || 0);
  if (row.rank !== "" && !Number.isFinite(rank)) {
    errors.push("rank phải là số");
  }

  const isActive = row.isActive === "" || row.isActive === undefined
    ? true
    : row.isActive === "true" || row.isActive === "1";

  if (action === "update") {
    const categoryId = (row.categoryId || "").trim();
    if (!categoryId) {
      errors.push("categoryId bắt buộc khi action là 'update'");
    } else if (!categoryLookup) {
      errors.push("Danh mục không tồn tại hoặc không thuộc merchant hiện tại");
    } else {
      // Check handle uniqueness excluding current category
      if (handle) {
        const existingId = existingHandles.get(handle.toLowerCase());
        if (existingId && existingId !== categoryLookup) {
          errors.push("Handle đã tồn tại");
        }
      }
    }
  } else if (action === "create") {
    if (handle) {
      const existingId = existingHandles.get(handle.toLowerCase());
      if (existingId) {
        errors.push("Handle đã tồn tại");
      }
    }
  }

  if (handle) handlesSeen.add(handle.toLowerCase());

  return {
    rowNumber,
    action,
    status: errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "valid",
    errors,
    warnings,
    normalized: {
      action,
      categoryId: (row.categoryId || "").trim(),
      name,
      handle,
      description: (row.description || "").trim(),
      rank: Number.isFinite(rank) ? Math.trunc(rank) : 0,
      isActive,
    },
  };
}

export async function previewCategoryImport(csvText: string, merchantId: string): Promise<ImportPreviewResult> {
  const rows = parseCsvRows(csvText, CATEGORY_IMPORT_COLUMNS);
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
    const existingHandles = await resolveExistingHandles(client, merchantId);
    const handlesSeen = new Set<string>();
    const previewRows: ImportPreviewRow[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const action = (row.action || "").toLowerCase();
      const categoryId = (row.categoryId || "").trim();
      const categoryLookup = action === "update" && categoryId
        ? await resolveCategoryById(client, categoryId, merchantId)
        : null;

      previewRows.push(validateCategoryRow(row, i + 2, handlesSeen, existingHandles, categoryLookup));
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

export async function applyCategoryImport(
  headers: HeadersLike,
  csvText: string,
  actor: OperatorContext,
  scope: MerchantTargetScope,
): Promise<ImportApplyResult> {
  const preview = await previewCategoryImport(csvText, scope.merchantId);
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
        const result = await createProductCategory(
          rowHeaders,
          {
            name: String(n.name),
            handle: String(n.handle),
            description: String(n.description),
            rank: Number(n.rank),
            isActive: Boolean(n.isActive),
          },
          actor,
          scope,
        );
        applyRows.push({
          rowNumber: row.rowNumber,
          action,
          status: "applied",
          entityId: result.response?.product_category?.id,
          errors: [],
        });
        appliedCount += 1;
      } else if (action === "update") {
        const categoryId = String(n.categoryId);
        const result = await updateProductCategory(
          rowHeaders,
          categoryId,
          {
            name: String(n.name),
            handle: String(n.handle),
            description: String(n.description),
            rank: Number(n.rank),
            isActive: Boolean(n.isActive),
          },
          actor,
          scope,
        );
        applyRows.push({
          rowNumber: row.rowNumber,
          action,
          status: "applied",
          entityId: result.response?.product_category?.id || categoryId,
          errors: [],
        });
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
