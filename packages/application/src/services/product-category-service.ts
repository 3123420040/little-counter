import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { withScopedIdempotency } from "../db/idempotency";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import { id } from "../utils/id";
import type { MerchantTargetScope } from "@medusa-snus/contracts";
import type { OperatorContext } from "./auth-service";
import { assertMerchantMutationTarget } from "./mutation-scope-service";

// Stable operation codes used with withScopedIdempotency.
export const CAT_OPS = {
  createCategory: "category.create",
  updateCategory: "category.update",
  deleteCategory: "category.delete",
} as const;

export interface ProductCategoryRecord {
  id: string;
  name: string;
  description: string;
  handle: string;
  parentCategoryId: string | null;
  rank: number;
  isActive: boolean;
  isInternal: boolean;
  productCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeName(value: unknown): string {
  return String(value || "").trim();
}

function normalizeHandle(value: unknown, fallbackName: string): string {
  const raw = String(value || fallbackName).trim();
  return slugify(raw);
}

function toRank(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function toLimit(value: unknown, fallback = 100): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), 200);
}

function toOffset(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

function mapCategoryRow(row: Record<string, unknown>): ProductCategoryRecord {
  return {
    id: String(row.id || ""),
    name: String(row.name || ""),
    description: String(row.description || ""),
    handle: String(row.handle || ""),
    parentCategoryId: row.parent_category_id ? String(row.parent_category_id) : row.parentCategoryId ? String(row.parentCategoryId) : null,
    rank: Number(row.rank || 0),
    isActive: Boolean(row.is_active ?? row.isActive),
    isInternal: Boolean(row.is_internal ?? row.isInternal),
    productCount: row.product_count === undefined ? undefined : Number(row.product_count || 0),
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : row.createdAt ? new Date(String(row.createdAt)).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : row.updatedAt ? new Date(String(row.updatedAt)).toISOString() : undefined,
  };
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(fn);
}

async function findCategoryById(client: PoolClient, categoryId: string, merchantId?: string): Promise<ProductCategoryRecord | null> {
  const row = await queryOne<Record<string, unknown>>(client, `
    SELECT
      pc.*,
      COALESCE(stats.product_count, 0) AS product_count
    FROM public.product_category pc
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS product_count
      FROM public.product_category_product pcp
      JOIN public.product p ON p.id = pcp.product_id AND p.deleted_at IS NULL
      WHERE pcp.product_category_id = pc.id
        AND ($2::text IS NULL OR p.merchant_id = $2)
    ) stats ON true
    WHERE pc.id = $1
      AND pc.deleted_at IS NULL
      AND ($2::text IS NULL OR pc.merchant_id = $2)
  `, [categoryId, merchantId || null]);
  return row ? mapCategoryRow(row) : null;
}

async function assertUniqueHandle(client: PoolClient, merchantId: string, handle: string, excludeId?: string): Promise<void> {
  const existing = await queryOne<{ id: string }>(client, `
    SELECT id
    FROM public.product_category
    WHERE deleted_at IS NULL
      AND lower(handle) = lower($1)
      AND ($2::text IS NULL OR id <> $2)
      AND merchant_id = $3
    LIMIT 1
  `, [handle, excludeId || null, merchantId]);
  if (existing) {
    throw new PlatformError("duplicate_category_handle", "Category handle already exists", 409);
  }
}

async function assertFlatMvpParent(parentCategoryId: unknown): Promise<void> {
  if (parentCategoryId) {
    throw new PlatformError("validation_error", "Category hierarchy is not supported in this MVP", 400);
  }
}

export async function listProductCategories(merchantId: string, query?: {
  q?: string;
  status?: string;
  includeProductCounts?: string | boolean;
  limit?: string | number;
  offset?: string | number;
}) {
  if (!merchantId) throw new PlatformError("scope_required", "Product categories require a merchant scope", 409);
  return withClient(async (client) => {
    const term = `%${String(query?.q || "").trim().toLowerCase()}%`;
    const status = String(query?.status || "all");
    const includeProductCounts = query?.includeProductCounts === false || query?.includeProductCounts === "false" ? false : true;
    const limit = toLimit(query?.limit, 100);
    const offset = toOffset(query?.offset);
    const productCountExpr = includeProductCounts ? "COALESCE(stats.product_count, 0)" : "0";

    const countResult = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM public.product_category pc
      WHERE pc.deleted_at IS NULL
        AND pc.merchant_id = $3
        AND ($1 = '%%' OR lower(pc.name) LIKE $1 OR lower(pc.handle) LIKE $1)
        AND (
          $2 = 'all'
          OR ($2 = 'active' AND pc.is_active = true)
          OR ($2 = 'inactive' AND pc.is_active = false)
        )
    `, [term, status, merchantId]);

    const rows = await client.query(`
      SELECT
        pc.id,
        pc.name,
        pc.description,
        pc.handle,
        pc.parent_category_id,
        pc.rank,
        pc.is_active,
        pc.is_internal,
        pc.created_at,
        pc.updated_at,
        ${productCountExpr} AS product_count
      FROM public.product_category pc
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS product_count
        FROM public.product_category_product pcp
        JOIN public.product p ON p.id = pcp.product_id AND p.deleted_at IS NULL
        WHERE pcp.product_category_id = pc.id
          AND p.merchant_id = $5
      ) stats ON true
      WHERE pc.deleted_at IS NULL
        AND pc.merchant_id = $5
        AND ($1 = '%%' OR lower(pc.name) LIKE $1 OR lower(pc.handle) LIKE $1)
        AND (
          $2 = 'all'
          OR ($2 = 'active' AND pc.is_active = true)
          OR ($2 = 'inactive' AND pc.is_active = false)
        )
      ORDER BY pc.rank ASC, pc.name ASC
      LIMIT $3
      OFFSET $4
    `, [term, status, limit, offset, merchantId]);

    const uncategorized = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM public.product p
      WHERE p.deleted_at IS NULL
        AND p.merchant_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM public.product_category_product pcp
          WHERE pcp.product_id = p.id
        )
    `, [merchantId]);

    return {
      product_categories: rows.rows.map((row) => mapCategoryRow(row as Record<string, unknown>)),
      count: Number(countResult.rows[0]?.count || 0),
      limit,
      offset,
      meta: {
        uncategorizedProductCount: Number(uncategorized.rows[0]?.count || 0),
      },
    };
  });
}

export async function getProductCategory(categoryId: string, merchantId: string) {
  if (!merchantId) throw new PlatformError("scope_required", "Product category requires a merchant scope", 409);
  return withClient(async (client) => {
    const category = await findCategoryById(client, categoryId, merchantId);
    if (!category) {
      throw new PlatformError("resource_not_found", "Category not found", 404);
    }
    return {
      product_category: category,
      children: [],
    };
  });
}

async function getProductCategoryMutationTargetForClient(client: PoolClient, categoryId: string): Promise<{ merchantId: string; storeId: null }> {
  const category = await queryOne<{ merchant_id: string | null }>(client, `
    SELECT merchant_id
    FROM public.product_category
    WHERE id = $1 AND deleted_at IS NULL
  `, [categoryId]);
  if (!category) throw new PlatformError("resource_not_found", "Category not found", 404);
  if (!category.merchant_id) throw new PlatformError("forbidden", "Category has no merchant scope", 403);
  return { merchantId: category.merchant_id, storeId: null };
}

export async function getProductCategoryMutationTarget(categoryId: string): Promise<{ merchantId: string; storeId: null }> {
  return withClient((client) => getProductCategoryMutationTargetForClient(client, categoryId));
}

export async function createProductCategory(
  headers: HeadersLike,
  body: {
    name?: string;
    handle?: string;
    description?: string;
    parentCategoryId?: string | null;
    rank?: number;
    isActive?: boolean;
    isInternal?: boolean;
  },
  actor: OperatorContext,
  scope: MerchantTargetScope,
) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: scope.merchantId });
    const result = await withScopedIdempotency(client, headers, body, scope.merchantId, CAT_OPS.createCategory, async () => {
      const name = normalizeName(body.name);
      if (name.length < 2 || name.length > 80) {
        throw new PlatformError("validation_error", "Category name must be 2-80 characters", 400);
      }
      await assertFlatMvpParent(body.parentCategoryId);
      const handle = normalizeHandle(body.handle, name);
      if (!handle) {
        throw new PlatformError("validation_error", "Category handle is required", 400);
      }
      await assertUniqueHandle(client, scope.merchantId, handle);

      const categoryId = id("pcat");
      await client.query(`
        INSERT INTO public.product_category (
          id,
          name,
          description,
          handle,
          mpath,
          is_active,
          is_internal,
          rank,
          parent_category_id,
          metadata,
          merchant_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, false, $7, NULL, '{}'::jsonb, $8)
      `, [
        categoryId,
        name,
        String(body.description || "").trim(),
        handle,
        `${categoryId}.`,
        body.isActive ?? true,
        toRank(body.rank),
        scope.merchantId,
      ]);

      const category = await findCategoryById(client, categoryId, scope.merchantId);
      if (!category) {
        throw new PlatformError("internal_error", "Category was not created", 500);
      }
      await recordAuditEntry(client, actor, "category.created", "product_category", categoryId, {
        after: category,
        merchantId: scope.merchantId,
      });
      return { product_category: category };
    });
    return result;
  });
}

export async function updateProductCategory(
  headers: HeadersLike,
  categoryId: string,
  body: {
    name?: string;
    handle?: string;
    description?: string;
    parentCategoryId?: string | null;
    rank?: number;
    isActive?: boolean;
    isInternal?: boolean;
  },
  actor: OperatorContext,
  scope: MerchantTargetScope,
) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: scope.merchantId });
    const result = await withScopedIdempotency(client, headers, { categoryId, ...body }, scope.merchantId, CAT_OPS.updateCategory, async () => {
      const before = await findCategoryById(client, categoryId);
      if (!before) {
        throw new PlatformError("resource_not_found", "Category not found", 404);
      }
      assertMerchantMutationTarget(scope, await getProductCategoryMutationTargetForClient(client, categoryId), "Category");
      await assertFlatMvpParent(body.parentCategoryId);

      const nextName = body.name === undefined ? before.name : normalizeName(body.name);
      if (nextName.length < 2 || nextName.length > 80) {
        throw new PlatformError("validation_error", "Category name must be 2-80 characters", 400);
      }
      const nextHandle = body.handle === undefined && body.name === undefined
        ? before.handle
        : normalizeHandle(body.handle, nextName);
      if (!nextHandle) {
        throw new PlatformError("validation_error", "Category handle is required", 400);
      }
      await assertUniqueHandle(client, scope.merchantId, nextHandle, categoryId);

      await client.query(`
        UPDATE public.product_category
        SET
          name = $2,
          description = $3,
          handle = $4,
          is_active = $5,
          is_internal = $6,
          rank = $7,
          updated_at = now()
        WHERE id = $1
      `, [
        categoryId,
        nextName,
        body.description === undefined ? before.description : String(body.description || "").trim(),
        nextHandle,
        body.isActive ?? before.isActive,
        body.isInternal ?? before.isInternal,
        body.rank === undefined ? before.rank : toRank(body.rank),
      ]);

      const after = await findCategoryById(client, categoryId, scope.merchantId);
      if (!after) {
        throw new PlatformError("internal_error", "Category was not updated", 500);
      }
      await recordAuditEntry(client, actor, "category.updated", "product_category", categoryId, {
        before,
        after,
        merchantId: scope.merchantId,
      });
      return { product_category: after };
    }, 200);
    return result;
  });
}

export async function deleteProductCategory(
  headers: HeadersLike,
  categoryId: string,
  actor: OperatorContext,
  scope: MerchantTargetScope,
) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: scope.merchantId });
    const result = await withScopedIdempotency(client, headers, { categoryId }, scope.merchantId, CAT_OPS.deleteCategory, async () => {
      const before = await findCategoryById(client, categoryId);
      if (!before) {
        throw new PlatformError("resource_not_found", "Category not found", 404);
      }
      assertMerchantMutationTarget(scope, await getProductCategoryMutationTargetForClient(client, categoryId), "Category");

      const usage = await queryOne<{ product_count: string; child_count: string }>(client, `
        SELECT
          (
            SELECT COUNT(*)::int
            FROM public.product_category_product pcp
            JOIN public.product p ON p.id = pcp.product_id AND p.deleted_at IS NULL
            WHERE pcp.product_category_id = $1
              AND p.merchant_id = $2
          ) AS product_count,
          (
            SELECT COUNT(*)::int
            FROM public.product_category child
            WHERE child.parent_category_id = $1
              AND child.deleted_at IS NULL
              AND child.merchant_id = $2
          ) AS child_count
      `, [categoryId, scope.merchantId]);

      const productCount = Number(usage?.product_count || 0);
      const childCount = Number(usage?.child_count || 0);
      if (productCount > 0 || childCount > 0) {
        throw new PlatformError("category_in_use", "Category is still in use", 409, {
          productCount,
          childCount,
        });
      }

      await client.query(`
        UPDATE public.product_category
        SET deleted_at = now(), updated_at = now()
        WHERE id = $1 AND merchant_id = $2
      `, [categoryId, scope.merchantId]);

      await recordAuditEntry(client, actor, "category.deleted", "product_category", categoryId, {
        before,
        after: { deleted: true },
        merchantId: scope.merchantId,
      });
      return { deleted: true, id: categoryId };
    }, 200);
    return result;
  });
}
