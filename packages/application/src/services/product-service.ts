import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";

export interface ProductCategoryRef {
  id: string;
  name: string;
  handle: string;
}

export interface ProductVariantView {
  id: string;
  sku: string;
  barcode: string;
  prices: Array<{ amount: number }>;
  inventory_quantity: number | null;
  cost_price?: number;
  reorder_level?: number;
}

export interface ProductView {
  id: string;
  title: string;
  status: string;
  categories: ProductCategoryRef[];
  variants: ProductVariantView[];
  created_at?: string;
  updated_at?: string;
  imageUrl: string;
}

export interface ProductListQuery {
  q?: string;
  categoryId?: string;
  categoryHandle?: string;
  limit?: string | number;
  /** Merchant scope for tenant isolation. When set, products are filtered to the merchant. */
  merchantId?: string;
  /** Operating stock location for inventory reads. Selects the exact inventory_level row. */
  stockLocationId?: string;
}

export interface AdminProductListQuery extends ProductListQuery {
  status?: string;
  offset?: string | number;
}

export interface AdminProductListMetrics {
  total: number;
  published: number;
  draft: number;
  uncategorized: number;
}

function toLimit(value: string | number | undefined, fallback = 100): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), 500);
}

function toOffset(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

function parseCategoryArray(value: unknown): ProductCategoryRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      id: String(item.id || ""),
      name: String(item.name || ""),
      handle: String(item.handle || ""),
    }))
    .filter((item) => item.id);
}

function mapProductRow(row: Record<string, unknown>): ProductView {
  const variantId = String(row.variant_id || "");
  return {
    id: String(row.id || ""),
    title: String(row.title || ""),
    status: String(row.status || ""),
    categories: parseCategoryArray(row.categories),
    imageUrl: String(row.image_url || row.imageUrl || ""),
    variants: variantId
      ? [{
          id: variantId,
          sku: String(row.sku || ""),
          barcode: String(row.barcode || ""),
          prices: [{ amount: Number(row.price || 0) }],
          inventory_quantity: row.stock === null ? null : Number(row.stock || 0),
          cost_price: Number(row.cost_price || 0),
          reorder_level: Number(row.reorder_level || 0),
        }]
      : [],
    created_at: row.created_at ? new Date(String(row.created_at)).toISOString() : undefined,
    updated_at: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined,
  };
}

function buildFilterSql(
  query: ProductListQuery | AdminProductListQuery | undefined,
  options: { publishedOnly: boolean },
): { where: string; params: unknown[]; searchParameter?: number } {
  const clauses = ["p.deleted_at IS NULL"];
  const params: unknown[] = [];
  let searchParameter: number | undefined;

  if (options.publishedOnly) {
    clauses.push("p.status = 'published'");
  } else if (query && "status" in query && query.status && query.status !== "all") {
    params.push(String(query.status));
    clauses.push(`p.status = $${params.length}`);
  }

  const term = String(query?.q || "").trim().toLowerCase();
  if (term) {
    params.push(`%${term}%`);
    const index = params.length;
    searchParameter = index;
    clauses.push(`(
      lower(p.title) LIKE $${index}
      OR EXISTS (
        SELECT 1
        FROM public.product_variant search_variant
        WHERE search_variant.product_id = p.id
          AND search_variant.deleted_at IS NULL
          AND (
            lower(COALESCE(search_variant.sku, '')) LIKE $${index}
            OR lower(COALESCE(search_variant.barcode, '')) LIKE $${index}
          )
      )
    )`);
  }

  const categoryId = String(query?.categoryId || "").trim();
  if (categoryId) {
    params.push(categoryId);
    const index = params.length;
    clauses.push(`EXISTS (
      SELECT 1
      FROM public.product_category_product pcp
      JOIN public.product_category pc ON pc.id = pcp.product_category_id
      WHERE pcp.product_id = p.id
        AND pc.deleted_at IS NULL
        AND pc.id = $${index}
    )`);
  }

  const categoryHandle = String(query?.categoryHandle || "").trim().toLowerCase();
  if (categoryHandle) {
    params.push(categoryHandle);
    const index = params.length;
    clauses.push(`EXISTS (
      SELECT 1
      FROM public.product_category_product pcp
      JOIN public.product_category pc ON pc.id = pcp.product_category_id
      WHERE pcp.product_id = p.id
        AND pc.deleted_at IS NULL
        AND lower(pc.handle) = $${index}
    )`);
  }

  const merchantId = String(query?.merchantId || "").trim();
  if (merchantId) {
    params.push(merchantId);
    const index = params.length;
    // Migration 003 deterministically assigned historical rows to the default
    // merchant. NULL is therefore unknown ownership and must fail closed.
    clauses.push(`p.merchant_id = $${index}`);
  }

  return {
    where: clauses.join("\n        AND "),
    params,
    searchParameter,
  };
}

function productDetailSql(whereClause: string, options: { stockLocationId?: string; searchParameter?: number; exactSearchParameter?: number } = {}): string {
  // When stockLocationId is provided, we inline a quoted string literal into the
  // LATERAL subquery. This is safe because the value comes from
  // OperatingScope.stockLocationId which is a non-user-controlled ID (validated
  // upstream by requireMutationScope). The value is escaped against SQL
  // injection by doubling any embedded single quote and wrapping in E'...'.
  const stockLocationClause = options.stockLocationId
    ? `AND il.location_id = ${sqlStringLiteral(options.stockLocationId)}`
    : "AND false";
  const variantSearchOrder = options.searchParameter && options.exactSearchParameter
    ? `CASE WHEN lower(COALESCE(pv.sku,''))=$${options.exactSearchParameter} OR lower(COALESCE(pv.barcode,''))=$${options.exactSearchParameter} THEN 0
        WHEN lower(COALESCE(pv.sku,'')) LIKE $${options.searchParameter} OR lower(COALESCE(pv.barcode,'')) LIKE $${options.searchParameter} THEN 1 ELSE 2 END,`
    : "";
  return `
    SELECT
      p.id,
      p.title,
      p.status,
      p.created_at,
      p.updated_at,
      COALESCE(NULLIF(p.metadata->>'imageUrl', ''), NULLIF(p.thumbnail, ''), img.url, '') AS image_url,
      v.variant_id,
      v.sku,
      v.barcode,
      v.price,
      v.stock,
      v.cost_price,
      v.reorder_level,
      COALESCE(cat.categories, '[]'::json) AS categories
    FROM public.product p
    LEFT JOIN LATERAL (
      SELECT
        pv.id AS variant_id,
        COALESCE(pv.sku, '') AS sku,
        COALESCE(pv.barcode, '') AS barcode,
        COALESCE(pr.amount, 0)::numeric AS price,
        ${options.stockLocationId ? "COALESCE(il.stocked_quantity, 0)::numeric" : "NULL::numeric"} AS stock,
        COALESCE(ps.cost_price, 0)::numeric AS cost_price,
        COALESCE(ps.reorder_level, 5) AS reorder_level
      FROM public.product_variant pv
      LEFT JOIN public.product_variant_price_set vps
        ON vps.variant_id = pv.id AND vps.deleted_at IS NULL
      LEFT JOIN public.price pr
        ON pr.price_set_id = vps.price_set_id
       AND pr.currency_code = 'vnd'
       AND pr.deleted_at IS NULL
      LEFT JOIN public.product_variant_inventory_item pvii
        ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
      LEFT JOIN public.inventory_level il
        ON il.inventory_item_id = pvii.inventory_item_id
       AND il.deleted_at IS NULL
       ${stockLocationClause}
      LEFT JOIN inventory.product_settings ps
        ON ps.variant_id = pv.id
      WHERE pv.product_id = p.id
        AND pv.deleted_at IS NULL
      ORDER BY ${variantSearchOrder} COALESCE(pv.variant_rank, 0) ASC, pv.created_at ASC, pv.id ASC
      LIMIT 1
    ) v ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        json_agg(
          json_build_object('id', pc.id, 'name', pc.name, 'handle', pc.handle)
          ORDER BY pc.rank ASC, pc.name ASC
        ) FILTER (WHERE pc.id IS NOT NULL),
        '[]'::json
      ) AS categories
      FROM public.product_category_product pcp
      JOIN public.product_category pc
        ON pc.id = pcp.product_category_id
       AND pc.deleted_at IS NULL
      WHERE pcp.product_id = p.id
    ) cat ON true
    LEFT JOIN LATERAL (
      SELECT url
      FROM public.image i
      WHERE i.product_id = p.id
        AND i.deleted_at IS NULL
      ORDER BY i.rank ASC, i.created_at ASC, i.id ASC
      LIMIT 1
    ) img ON true
    WHERE ${whereClause}
  `;
}

/**
 * Escape a string for safe inclusion as a Postgres string literal.
 * Used only for ID-shaped values that come from validated OperatingScope fields.
 */
function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function getProductViewForClient(client: PoolClient, productId: string, stockLocationId?: string): Promise<ProductView | null> {
  const result = await client.query(productDetailSql("p.id = $1 AND p.deleted_at IS NULL", { stockLocationId }), [productId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapProductRow(row) : null;
}

export async function getProduct(productId: string, options: { merchantId?: string; stockLocationId?: string } = {}): Promise<{ product: ProductView }> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const where = options.merchantId
      ? "p.id = $1 AND p.deleted_at IS NULL AND p.merchant_id = $2"
      : "p.id = $1 AND p.deleted_at IS NULL";
    const params = options.merchantId ? [productId, options.merchantId] : [productId];
    const result = await client.query(productDetailSql(where, { stockLocationId: options.stockLocationId }), params);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new PlatformError("resource_not_found", "Product not found", 404);
    }
    return { product: mapProductRow(row) };
  });
}

export async function listProducts(query?: ProductListQuery): Promise<ProductView[]> {
  await ensurePlatformSchema();

  return withConnectedClient(async (client) => {
    const limit = toLimit(query?.limit, 100);
    const { where, params, searchParameter } = buildFilterSql(query, { publishedOnly: true });
    const result = await client.query(`
      WITH filtered AS (
        SELECT p.id
        FROM public.product p
        WHERE ${where}
        ORDER BY p.title ASC
        LIMIT $${params.length + 1}
      )
      ${productDetailSql("p.id IN (SELECT id FROM filtered)", { stockLocationId: query?.stockLocationId, searchParameter, exactSearchParameter: searchParameter ? params.length + 2 : undefined })}
      ORDER BY p.title ASC
    `, [...params, limit, ...(searchParameter ? [String(query?.q).trim().toLowerCase()] : [])]);

    return result.rows.map((row) => mapProductRow(row as Record<string, unknown>));
  });
}

export async function listAdminProducts(query?: AdminProductListQuery) {
  await ensurePlatformSchema();

  return withConnectedClient(async (client) => {
    const limit = toLimit(query?.limit, 100);
    const offset = toOffset(query?.offset);
    const { where, params, searchParameter } = buildFilterSql(query, { publishedOnly: false });

    const countResult = await client.query<AdminProductListMetrics>(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE p.status = 'published')::int AS published,
        COUNT(*) FILTER (WHERE p.status <> 'published')::int AS draft,
        COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1
          FROM public.product_category_product pcp
          JOIN public.product_category pc
            ON pc.id = pcp.product_category_id
           AND pc.deleted_at IS NULL
          WHERE pcp.product_id = p.id
        ))::int AS uncategorized
      FROM public.product p
      WHERE ${where}
    `, params);

    const rows = await client.query(`
      WITH filtered AS (
        SELECT p.id
        FROM public.product p
        WHERE ${where}
        ORDER BY p.updated_at DESC, p.title ASC, p.id ASC
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
      )
      ${productDetailSql("p.id IN (SELECT id FROM filtered)", { stockLocationId: query?.stockLocationId, searchParameter, exactSearchParameter: searchParameter ? params.length + 3 : undefined })}
      ORDER BY p.updated_at DESC, p.title ASC, p.id ASC
    `, [...params, limit, offset, ...(searchParameter ? [String(query?.q).trim().toLowerCase()] : [])]);

    return {
      products: rows.rows.map((row) => mapProductRow(row as Record<string, unknown>)),
      count: Number(countResult.rows[0]?.total || 0),
      metrics: {
        total: Number(countResult.rows[0]?.total || 0),
        published: Number(countResult.rows[0]?.published || 0),
        draft: Number(countResult.rows[0]?.draft || 0),
        uncategorized: Number(countResult.rows[0]?.uncategorized || 0),
      } satisfies AdminProductListMetrics,
      limit,
      offset,
    };
  });
}
