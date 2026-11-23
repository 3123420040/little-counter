import { withScopedIdempotency } from "../db/idempotency";
import { queryOne } from "../db/query";
import { rawNumber } from "../db/raw-number";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedTransaction } from "../db/transaction";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import { id } from "../utils/id";
import type { MerchantTargetScope, OperatingScope } from "@medusa-snus/contracts";
import type { OperatorContext } from "./auth-service";
import { getProductViewForClient } from "./product-service";
import { assertMerchantMutationTarget } from "./mutation-scope-service";
import { normalizeProductImageUrl } from "./product-image-url";
import { emitProductImageAutofillRequestForClient } from "./product-image-autofill-service";

// Stable operation codes used with withScopedIdempotency.
export const PROD_OPS = {
  createProduct: "product.create",
  updateProduct: "product.update",
} as const;

export interface ProductMutationInput {
  title?: string;
  status?: string;
  sku?: string;
  barcode?: string | null;
  price?: number;
  costPrice?: number;
  reorderLevel?: number;
  categoryIds?: string[];
  imageUrl?: string;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeTitle(value: unknown): string {
  return String(value || "").trim();
}

function normalizeSku(value: unknown): string {
  return String(value || "").trim();
}

function skuBaseFromTitle(title: string): string {
  const base = slugify(title).toUpperCase().replace(/-/g, "-").slice(0, 48).replace(/-$/g, "");
  return base || "PRODUCT";
}

function normalizeBarcode(value: unknown): string | null {
  const barcode = String(value || "").trim();
  return barcode ? barcode : null;
}

function normalizeStatus(value: unknown, fallback = "published"): string {
  const status = String(value || fallback).trim();
  const allowed = new Set(["draft", "proposed", "published", "rejected"]);
  if (!allowed.has(status)) {
    throw new PlatformError("validation_error", "Invalid product status", 400);
  }
  return status;
}

function normalizeAmount(value: unknown, field: string, fallback = 0): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PlatformError("validation_error", `${field} must be a non-negative number`, 400);
  }
  return Math.round(parsed);
}

function normalizeReorderLevel(value: unknown, fallback = 5): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PlatformError("validation_error", "reorderLevel must be a non-negative number", 400);
  }
  return Math.trunc(parsed);
}

function normalizeCategoryIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)));
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>, retryAutoSku = false): Promise<T> {
  await ensurePlatformSchema();
  for (let attempt = 0; ; attempt += 1) {
    try { return await withConnectedTransaction(fn); }
    catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === "23505" && ["catalog_variant_sku_unique", "catalog_variant_barcode_unique", "catalog_inventory_sku_unique"].includes(failure.constraint || "")) {
        if (retryAutoSku && failure.constraint !== "catalog_variant_barcode_unique" && attempt < 2) continue;
        throw new PlatformError("validation_error", "SKU or barcode already exists in this merchant", 409);
      }
      throw error;
    }
  }
}

async function ensureUniqueSku(client: PoolClient, sku: string, merchantId: string, excludeVariantId?: string, excludeInventoryItemId?: string): Promise<void> {
  const existing = await queryOne<{ id: string }>(client, `
    SELECT id
    FROM public.product_variant
    WHERE deleted_at IS NULL
      AND lower(btrim(sku)) = lower(btrim($1))
      AND merchant_id = $3
      AND ($2::text IS NULL OR id <> $2)
    UNION ALL
    SELECT id FROM public.inventory_item
    WHERE deleted_at IS NULL AND merchant_id = $3
      AND lower(btrim(sku)) = lower(btrim($1))
      AND ($4::text IS NULL OR id <> $4)
    LIMIT 1
  `, [sku, excludeVariantId || null, merchantId, excludeInventoryItemId || null]);
  if (existing) {
    throw new PlatformError("validation_error", "SKU already exists", 409);
  }
}

async function generateUniqueSku(client: PoolClient, title: string, merchantId: string): Promise<string> {
  const base = skuBaseFromTitle(title);
  let sku = base;
  let suffix = 2;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const existing = await queryOne<{ id: string }>(client, `
      SELECT id
      FROM public.product_variant
      WHERE deleted_at IS NULL
        AND lower(btrim(sku)) = lower(btrim($1)) AND merchant_id = $2
      UNION ALL
      SELECT id FROM public.inventory_item WHERE deleted_at IS NULL
        AND lower(btrim(sku)) = lower(btrim($1)) AND merchant_id = $2
      LIMIT 1
    `, [sku, merchantId]);
    if (!existing) return sku;
    sku = `${base}-${suffix}`;
    suffix += 1;
  }
  throw new PlatformError("validation_error", "Cannot allocate SKU; provide a unique SKU", 409);
}

async function ensureUniqueBarcode(client: PoolClient, barcode: string | null, merchantId: string, excludeVariantId?: string): Promise<void> {
  if (!barcode) return;
  const existing = await queryOne<{ id: string }>(client, `
    SELECT id
    FROM public.product_variant
    WHERE deleted_at IS NULL
      AND lower(btrim(barcode)) = lower(btrim($1))
      AND merchant_id = $3
      AND ($2::text IS NULL OR id <> $2)
    LIMIT 1
  `, [barcode, excludeVariantId || null, merchantId]);
  if (existing) {
    throw new PlatformError("validation_error", "Barcode already exists", 409);
  }
}

async function generateUniqueProductHandle(client: PoolClient, title: string, excludeProductId?: string): Promise<string> {
  const base = slugify(title) || `product-${Date.now()}`;
  let handle = base;
  let suffix = 2;
  // Small bounded loop keeps the handle deterministic enough for this MVP.
  for (;;) {
    const existing = await queryOne<{ id: string }>(client, `
      SELECT id
      FROM public.product
      WHERE deleted_at IS NULL
        AND handle = $1
        AND ($2::text IS NULL OR id <> $2)
      LIMIT 1
    `, [handle, excludeProductId || null]);
    if (!existing) return handle;
    handle = `${base}-${suffix}`;
    suffix += 1;
  }
}

async function validateCategoryAssignments(client: PoolClient, categoryIds: string[], merchantId: string): Promise<Array<{ id: string; handle: string }>> {
  if (categoryIds.length === 0) return [];
  const result = await client.query(`
    SELECT id, handle
    FROM public.product_category
    WHERE id = ANY($1::text[])
      AND deleted_at IS NULL
      AND is_active = true
      AND is_internal = false
      AND merchant_id = $2
  `, [categoryIds, merchantId]);
  if (result.rows.length !== categoryIds.length) {
    throw new PlatformError("validation_error", "One or more categories are invalid or inactive", 400);
  }
  return result.rows.map((row) => ({
    id: String(row.id),
    handle: String(row.handle),
  }));
}

async function syncProductCategories(client: PoolClient, productId: string, categoryIds: string[]): Promise<void> {
  await client.query("DELETE FROM public.product_category_product WHERE product_id = $1", [productId]);
  for (const categoryId of categoryIds) {
    await client.query(`
      INSERT INTO public.product_category_product (product_id, product_category_id)
      VALUES ($1, $2)
      ON CONFLICT (product_id, product_category_id) DO NOTHING
    `, [productId, categoryId]);
  }
}

async function syncLegacyCategoryMetadata(client: PoolClient, productId: string, categoryHandles: string[]): Promise<void> {
  if (categoryHandles.length === 0) {
    await client.query(`
      UPDATE public.product
      SET metadata = COALESCE(metadata, '{}'::jsonb) - 'category',
          updated_at = now()
      WHERE id = $1
    `, [productId]);
    return;
  }

  await client.query(`
    UPDATE public.product
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('category', $2::text),
        updated_at = now()
    WHERE id = $1
  `, [productId, categoryHandles[0]]);
}

export async function getDefaultVariantRow(client: PoolClient, productId: string) {
  return queryOne<{
    id: string;
    price_set_id: string | null;
    inventory_item_id: string | null;
  }>(client, `
    SELECT
      pv.id,
      vps.price_set_id,
      pvii.inventory_item_id
    FROM public.product_variant pv
    LEFT JOIN public.product_variant_price_set vps
      ON vps.variant_id = pv.id AND vps.deleted_at IS NULL
    LEFT JOIN public.product_variant_inventory_item pvii
      ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
    WHERE pv.product_id = $1
      AND pv.deleted_at IS NULL
    ORDER BY COALESCE(pv.variant_rank, 0) ASC, pv.created_at ASC, pv.id ASC
    LIMIT 1
  `, [productId]);
}

export async function createProduct(
  headers: HeadersLike,
  body: ProductMutationInput,
  actor: OperatorContext,
  scope: MerchantTargetScope,
  operatingScope: OperatingScope,
) {
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: scope.merchantId, storeId: operatingScope.storeId });
    const result = await withScopedIdempotency(client, headers, body, scope.merchantId, PROD_OPS.createProduct, async () => {
      const title = normalizeTitle(body.title);
      const barcode = normalizeBarcode(body.barcode);
      const status = normalizeStatus(body.status, "published");
      const price = normalizeAmount(body.price, "price");
      const costPrice = normalizeAmount(body.costPrice, "costPrice");
      const reorderLevel = normalizeReorderLevel(body.reorderLevel, 5);
      const categoryIds = normalizeCategoryIds(body.categoryIds);

      if (title.length < 2) {
        throw new PlatformError("validation_error", "title is required", 400);
      }

      const requestedSku = normalizeSku(body.sku);
      const sku = requestedSku || await generateUniqueSku(client, title, scope.merchantId);
      if (requestedSku) await ensureUniqueSku(client, sku, scope.merchantId);
      await ensureUniqueBarcode(client, barcode, scope.merchantId);
      if (operatingScope.merchantId !== scope.merchantId) {
        throw new PlatformError("forbidden", "Product creation scope does not match merchant target", 403);
      }
      const categories = await validateCategoryAssignments(client, categoryIds, scope.merchantId);

      const productId = id("prod");
      const variantId = id("var");
      const priceSetId = id("ps");
      const priceId = id("price");
      const inventoryItemId = id("iitem");
      const inventoryLevelId = id("ilev");
      const imageUrl = normalizeProductImageUrl(body.imageUrl);
      const handle = await generateUniqueProductHandle(client, title);

      await client.query(`
        INSERT INTO public.product (id, title, handle, status, metadata, merchant_id)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `, [productId, title, handle, status, JSON.stringify(imageUrl ? { imageUrl } : {}), scope.merchantId]);

      await client.query(`
        INSERT INTO public.product_variant (id, title, sku, barcode, product_id, manage_inventory)
        VALUES ($1, 'Default', $2, $3, $4, true)
      `, [variantId, sku, barcode, productId]);

      await client.query(`
        INSERT INTO public.price_set (id, merchant_id)
        VALUES ($1, $2)
      `, [priceSetId, scope.merchantId]);

      await client.query(`
        INSERT INTO public.product_variant_price_set (id, variant_id, price_set_id)
        VALUES ($1, $2, $3)
      `, [id("pvps"), variantId, priceSetId]);

      await client.query(`
        INSERT INTO public.price (id, price_set_id, currency_code, amount, raw_amount)
        VALUES ($1, $2, 'vnd', $3, $4::jsonb)
      `, [priceId, priceSetId, price, JSON.stringify(rawNumber(price))]);

      await client.query(`
        INSERT INTO public.inventory_item (id, sku, title, requires_shipping)
        VALUES ($1, $2, $3, true)
      `, [inventoryItemId, sku, title]);

      await client.query(`
        INSERT INTO public.product_variant_inventory_item (id, variant_id, inventory_item_id, required_quantity)
        VALUES ($1, $2, $3, 1)
      `, [id("pvii"), variantId, inventoryItemId]);

      await client.query(`
        INSERT INTO public.inventory_level (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity, incoming_quantity)
        VALUES ($1, $2, $3, 0, 0, 0)
      `, [inventoryLevelId, inventoryItemId, operatingScope.stockLocationId]);

      await client.query(`
        INSERT INTO inventory.product_settings (variant_id, product_id, cost_price, reorder_level, preferred_stock, merchant_id)
        VALUES ($1, $2, $3, $4, 20, $5)
      `, [variantId, productId, costPrice, reorderLevel, scope.merchantId]);

      await syncProductCategories(client, productId, categories.map((category) => category.id));
      await syncLegacyCategoryMetadata(client, productId, categories.map((category) => category.handle));

      const product = await getProductViewForClient(client, productId, operatingScope.stockLocationId);
      if (!product) {
        throw new PlatformError("internal_error", "Product was not created", 500);
      }
      await recordAuditEntry(client, actor, "product.created", "product", productId, {
        after: product,
        merchantId: scope.merchantId,
        storeId: operatingScope.storeId,
      });
      if (!imageUrl) {
        await emitProductImageAutofillRequestForClient(client, {
          productId,
          merchantId: scope.merchantId,
          storeId: operatingScope.storeId,
          title,
          sku,
          source: "product.create",
          requestedBy: actor.operatorId,
        });
      }
      return { product };
    });
    return result;
  }, !normalizeSku(body.sku));
}

export async function updateProduct(
  headers: HeadersLike,
  productId: string,
  body: ProductMutationInput,
  actor: OperatorContext,
  scope: MerchantTargetScope,
  operatingScope?: OperatingScope,
) {
  if (operatingScope && operatingScope.merchantId !== scope.merchantId) {
    throw new PlatformError("forbidden", "Product merchant does not match the selected store", 403);
  }
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, operatingScope
      ? { scopeType: "store", merchantId: scope.merchantId, storeId: operatingScope.storeId }
      : { scopeType: "merchant", merchantId: scope.merchantId });
    const result = await withScopedIdempotency(client, headers, { productId, ...body, stockLocationId: operatingScope?.stockLocationId }, scope.merchantId, PROD_OPS.updateProduct, async () => {
      const before = await getProductViewForClient(client, productId, operatingScope?.stockLocationId);
      if (!before) {
        throw new PlatformError("resource_not_found", "Product not found", 404);
      }
      const target = await getProductMutationTargetForClient(client, productId);
      assertMerchantMutationTarget(scope, target, "Product");

      const defaultVariant = await getDefaultVariantRow(client, productId);
      if (!defaultVariant || !defaultVariant.price_set_id || !defaultVariant.inventory_item_id) {
        throw new PlatformError("internal_error", "Product is missing default variant linkage", 500);
      }

      const title = body.title === undefined ? before.title : normalizeTitle(body.title);
      const status = body.status === undefined ? before.status : normalizeStatus(body.status, before.status);
      const variantBefore = before.variants[0];
      const sku = body.sku === undefined ? String(variantBefore?.sku || "") : normalizeSku(body.sku);
      const barcode = body.barcode === undefined ? normalizeBarcode(variantBefore?.barcode) : normalizeBarcode(body.barcode);
      const price = body.price === undefined ? Number(variantBefore?.prices?.[0]?.amount || 0) : normalizeAmount(body.price, "price");
      const costPrice = body.costPrice === undefined ? Number(variantBefore?.cost_price || 0) : normalizeAmount(body.costPrice, "costPrice");
      const reorderLevel = body.reorderLevel === undefined ? Number(variantBefore?.reorder_level || 5) : normalizeReorderLevel(body.reorderLevel, 5);
      const imageUrl = body.imageUrl === undefined ? undefined : normalizeProductImageUrl(body.imageUrl);
      const categoryIds = body.categoryIds === undefined
        ? before.categories.map((category) => category.id)
        : normalizeCategoryIds(body.categoryIds);

      if (title.length < 2) {
        throw new PlatformError("validation_error", "title is required", 400);
      }
      if (!sku) {
        throw new PlatformError("validation_error", "sku is required", 400);
      }

      await ensureUniqueSku(client, sku, scope.merchantId, defaultVariant.id, defaultVariant.inventory_item_id);
      await ensureUniqueBarcode(client, barcode, scope.merchantId, defaultVariant.id);
      const categories = await validateCategoryAssignments(client, categoryIds, scope.merchantId);

      await client.query(`
        UPDATE public.product
        SET title = $2,
            status = $3,
            updated_at = now()
        WHERE id = $1
      `, [productId, title, status]);

      if (imageUrl !== undefined) {
        await client.query(
          `UPDATE public.product
          SET metadata = CASE
                WHEN $2::text IS NULL THEN COALESCE(metadata, '{}'::jsonb) - 'imageUrl'
                ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('imageUrl', $2::text)
              END,
              updated_at = now()
          WHERE id = $1`,
          [productId, imageUrl]
        );
      }
      await client.query(`
        UPDATE public.product_variant
        SET sku = $2,
            barcode = $3,
            updated_at = now()
        WHERE id = $1
      `, [defaultVariant.id, sku, barcode]);

      await client.query(`
        UPDATE public.price
        SET amount = $2,
            raw_amount = $3::jsonb,
            updated_at = now()
        WHERE price_set_id = $1
          AND currency_code = 'vnd'
          AND deleted_at IS NULL
      `, [defaultVariant.price_set_id, price, JSON.stringify(rawNumber(price))]);

      await client.query(`
        UPDATE public.inventory_item
        SET sku = $2,
            title = $3
        WHERE id = $1
      `, [defaultVariant.inventory_item_id, sku, title]);

      await client.query(`
        UPDATE inventory.product_settings
        SET cost_price = $2,
            reorder_level = $3,
            updated_at = now()
        WHERE variant_id = $1
      `, [defaultVariant.id, costPrice, reorderLevel]);

      await syncProductCategories(client, productId, categories.map((category) => category.id));
      await syncLegacyCategoryMetadata(client, productId, categories.map((category) => category.handle));

      const after = await getProductViewForClient(client, productId, operatingScope?.stockLocationId);
      if (!after) {
        throw new PlatformError("internal_error", "Product was not updated", 500);
      }
      await recordAuditEntry(client, actor, "product.updated", "product", productId, {
        before,
        after,
        merchantId: scope.merchantId,
        storeId: operatingScope?.storeId,
      });
      return { product: after };
    }, 200);
    return result;
  });
}

async function getProductMutationTargetForClient(client: PoolClient, productId: string): Promise<{ merchantId: string; storeId: null }> {
  const product = await queryOne<{ merchant_id: string | null }>(client, `
    SELECT merchant_id
    FROM public.product
    WHERE id = $1 AND deleted_at IS NULL
  `, [productId]);
  if (!product) throw new PlatformError("resource_not_found", "Product not found", 404);
  if (!product.merchant_id) throw new PlatformError("forbidden", "Product has no merchant scope", 403);
  return { merchantId: product.merchant_id, storeId: null };
}

export async function getProductMutationTarget(productId: string): Promise<{ merchantId: string; storeId: null }> {
  return withTransaction((client) => getProductMutationTargetForClient(client, productId));
}
