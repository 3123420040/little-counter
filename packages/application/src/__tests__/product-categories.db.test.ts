import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import type { OperatorContext } from "../services/auth-service";
import {
  createProduct,
  createProductCategory,
  deleteProductCategory,
  getSyncBootstrap,
  getProduct,
  listAdminProducts,
  listProductCategories,
  listProducts,
  updateProduct,
} from "../platform-db";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const actor: OperatorContext = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "DB Test Owner",
  organizationId: "org_default",
};
const catalogScope = { scopeKind: "merchant_target" as const, merchantId: "merchant_default" };
const catalogOperatingScope = {
  scopeKind: "operating" as const,
  merchantId: "merchant_default",
  storeId: "store_default",
  stockLocationId: "sloc_default",
};

let client: PoolClient;
const createdProductIds: string[] = [];
const createdCategoryIds: string[] = [];

async function deleteProductDeep(productId: string): Promise<void> {
  const variant = await queryOne<{ id: string; inventory_item_id: string | null; price_set_id: string | null }>(client, `
    SELECT
      pv.id,
      pvii.inventory_item_id,
      vps.price_set_id
    FROM public.product_variant pv
    LEFT JOIN public.product_variant_inventory_item pvii
      ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
    LEFT JOIN public.product_variant_price_set vps
      ON vps.variant_id = pv.id AND vps.deleted_at IS NULL
    WHERE pv.product_id = $1
      AND pv.deleted_at IS NULL
    ORDER BY COALESCE(pv.variant_rank, 0) ASC, pv.created_at ASC, pv.id ASC
    LIMIT 1
  `, [productId]);

  if (variant?.price_set_id) {
    await client.query("DELETE FROM public.price WHERE price_set_id = $1", [variant.price_set_id]).catch(() => undefined);
    await client.query("DELETE FROM public.product_variant_price_set WHERE price_set_id = $1", [variant.price_set_id]).catch(() => undefined);
    await client.query("DELETE FROM public.price_set WHERE id = $1", [variant.price_set_id]).catch(() => undefined);
  }
  if (variant?.inventory_item_id) {
    await client.query("DELETE FROM public.inventory_level WHERE inventory_item_id = $1", [variant.inventory_item_id]).catch(() => undefined);
    await client.query("DELETE FROM public.product_variant_inventory_item WHERE inventory_item_id = $1", [variant.inventory_item_id]).catch(() => undefined);
    await client.query("DELETE FROM public.inventory_item WHERE id = $1", [variant.inventory_item_id]).catch(() => undefined);
  }
  if (variant?.id) {
    await client.query("DELETE FROM inventory.product_settings WHERE variant_id = $1", [variant.id]).catch(() => undefined);
    await client.query("DELETE FROM public.product_variant WHERE id = $1", [variant.id]).catch(() => undefined);
  }
  await client.query("DELETE FROM public.product_category_product WHERE product_id = $1", [productId]).catch(() => undefined);
  await client.query("DELETE FROM public.product WHERE id = $1", [productId]).catch(() => undefined);
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
});

afterAll(async () => {
  for (const productId of createdProductIds.reverse()) {
    await deleteProductDeep(productId).catch(() => undefined);
  }
  if (createdCategoryIds.length > 0) {
    await client?.query("DELETE FROM public.product_category WHERE id = ANY($1::text[])", [createdCategoryIds]).catch(() => undefined);
  }
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("Product categories PostgreSQL integration", () => {
  it("reads list and detail stock only at the verified stock location", async () => {
    const created = await createProduct({ "idempotency-key": `db-test:${runId}:scoped-stock` }, {
      title: `Scoped stock ${runId}`, status: "published", sku: `SCOPED-${runId}`, price: 100000,
    }, actor, catalogScope, catalogOperatingScope);
    const productId = created.response.product.id;
    createdProductIds.push(productId);
    const mapping = await queryOne<{ inventory_item_id: string }>(client, `
      SELECT inventory_item_id FROM public.product_variant_inventory_item
      WHERE variant_id=$1 AND deleted_at IS NULL
    `, [created.response.product.variants[0]!.id]);
    if (!mapping) throw new Error("Expected created inventory linkage");
    const location = `stock-scope-${runId}`;
    await client.query("INSERT INTO public.stock_location(id,name) VALUES ($1,$1)", [location]);
    await client.query("INSERT INTO app.stores(id,merchant_id,display_name,stock_location_id) VALUES ($1,$2,$1,$1)", [location, catalogScope.merchantId]);
    try {
      await client.query("UPDATE public.inventory_level SET stocked_quantity=3 WHERE inventory_item_id=$1 AND location_id=$2 AND deleted_at IS NULL", [mapping.inventory_item_id, catalogOperatingScope.stockLocationId]);
      await client.query(`INSERT INTO public.inventory_level(id,inventory_item_id,location_id,stocked_quantity,reserved_quantity,incoming_quantity) VALUES ($1,$2,$1,11,0,0)`, [location, mapping.inventory_item_id]);
      const unscoped = await getProduct(productId, { merchantId: catalogScope.merchantId });
      expect(unscoped.product.variants[0]!.inventory_quantity).toBeNull();
      const unscopedList = await listAdminProducts({ merchantId: catalogScope.merchantId, q: `SCOPED-${runId}` });
      expect(unscopedList.products[0]!.variants[0]!.inventory_quantity).toBeNull();
      for (const [stockLocationId, quantity] of [[catalogOperatingScope.stockLocationId, 3], [location, 11]] as const) {
        const list = await listAdminProducts({ merchantId: catalogScope.merchantId, stockLocationId, q: `SCOPED-${runId}` });
        const detail = await getProduct(productId, { merchantId: catalogScope.merchantId, stockLocationId });
        expect(list.products).toHaveLength(1);
        expect(list.products[0]!.variants[0]!.inventory_quantity).toBe(quantity);
        expect(detail.product.variants[0]!.inventory_quantity).toBe(quantity);
      }
      const updated = await updateProduct({ "idempotency-key": `db-test:${runId}:scoped-stock-update` }, productId, {
        title: `Scoped stock updated ${runId}`, sku: `SCOPED-${runId}`, price: 100000,
      }, actor, catalogScope, { ...catalogOperatingScope, storeId: location, stockLocationId: location });
      expect(updated.response.product.variants[0]!.inventory_quantity).toBe(11);
    } finally {
      await client.query("DELETE FROM public.inventory_level WHERE location_id=$1", [location]);
      await client.query("DELETE FROM app.stores WHERE id=$1", [location]);
      await client.query("DELETE FROM public.stock_location WHERE id=$1", [location]);
    }
  });
  it("backfills the native Snus category and exposes category data in POS/bootstrap reads", async () => {
    const snus = await queryOne<{ id: string; handle: string; is_active: boolean }>(client, `
      SELECT id, handle, is_active
      FROM public.product_category
      WHERE id = 'pcat_snus'
        AND deleted_at IS NULL
    `);
    expect(snus).toMatchObject({
      id: "pcat_snus",
      handle: "snus",
      is_active: true,
    });

    const linked = await queryOne<{ count: string }>(client, `
      SELECT COUNT(*)::int AS count
      FROM public.product_category_product
      WHERE product_category_id = 'pcat_snus'
        AND product_id = 'prod_mint'
    `);
    expect(Number(linked?.count || 0)).toBeGreaterThan(0);

    const posProducts = await listProducts({ merchantId: catalogScope.merchantId, categoryHandle: "snus", limit: 20 });
    expect(posProducts.some((product) => product.id === "prod_mint")).toBe(true);
    expect(posProducts.find((product) => product.id === "prod_mint")?.categories?.[0]?.handle).toBe("snus");

    const bootstrap = await getSyncBootstrap(actor, {
      "x-operating-merchant-id": catalogOperatingScope.merchantId,
      "x-operating-store-id": catalogOperatingScope.storeId,
    });
    expect(bootstrap.data.products.find((product) => product.id === "prod_mint")?.categories?.[0]?.handle).toBe("snus");
  });

  it("supports category CRUD with duplicate and in-use protection", async () => {
    const created = await createProductCategory(
      { "idempotency-key": `db-test:${runId}:category-create` },
      {
        name: `Seasonal ${runId}`,
        description: "Seasonal SKUs",
        rank: 10,
        isActive: true,
      },
      actor,
      catalogScope,
    );
    expect(created.statusCode).toBe(201);
    const categoryId = created.response.product_category.id;
    createdCategoryIds.push(categoryId);

    const duplicatePromise = createProductCategory(
      { "idempotency-key": `db-test:${runId}:category-duplicate` },
      {
        name: `Seasonal ${runId}`,
        handle: created.response.product_category.handle,
      },
      actor,
      catalogScope,
    );
    await expect(duplicatePromise).rejects.toMatchObject({ code: "duplicate_category_handle" });

    const createdProduct = await createProduct(
      { "idempotency-key": `db-test:${runId}:product-create` },
      {
        title: `Catalog Test ${runId}`,
        status: "published",
        sku: `SKU-${runId}`,
        barcode: `BAR-${runId}`,
        price: 123000,
        costPrice: 81000,
        reorderLevel: 6,
        categoryIds: [categoryId],
      },
      actor,
      catalogScope,
      catalogOperatingScope,
    );
    expect(createdProduct.statusCode).toBe(201);
    const productId = createdProduct.response.product.id;
    createdProductIds.push(productId);

    const deleteInUse = deleteProductCategory(
      { "idempotency-key": `db-test:${runId}:category-delete-in-use` },
      categoryId,
      actor,
      catalogScope,
    );
    await expect(deleteInUse).rejects.toMatchObject({ code: "category_in_use" });

    const emptyCategory = await createProductCategory(
      { "idempotency-key": `db-test:${runId}:category-empty` },
      { name: `Disposable ${runId}` },
      actor,
      catalogScope,
    );
    createdCategoryIds.push(emptyCategory.response.product_category.id);
    const removed = await deleteProductCategory(
      { "idempotency-key": `db-test:${runId}:category-delete-empty` },
      emptyCategory.response.product_category.id,
      actor,
      catalogScope,
    );
    expect(removed.statusCode).toBe(200);
    expect(removed.response).toMatchObject({ deleted: true, id: emptyCategory.response.product_category.id });
  });

  it("creates zero-stock product linkage and updates category assignment without changing stock", async () => {
    const baseCategory = await createProductCategory(
      { "idempotency-key": `db-test:${runId}:category-base` },
      { name: `Base ${runId}`, isActive: true },
      actor,
      catalogScope,
    );
    createdCategoryIds.push(baseCategory.response.product_category.id);

    const productResult = await createProduct(
      { "idempotency-key": `db-test:${runId}:product-zero-stock` },
      {
        title: `Zero Stock ${runId}`,
        status: "published",
        sku: `ZERO-${runId}`,
        barcode: `ZERO-BAR-${runId}`,
        price: 150000,
        costPrice: 99000,
        reorderLevel: 9,
        categoryIds: [baseCategory.response.product_category.id],
        imageUrl: "https://example.com/catalog-create.jpg",
      },
      actor,
      catalogScope,
      catalogOperatingScope,
    );
    const product = productResult.response.product;
    createdProductIds.push(product.id);

    expect(product.categories[0]?.id).toBe(baseCategory.response.product_category.id);
    expect(product.variants[0]?.inventory_quantity).toBe(0);
    expect(product.imageUrl).toBe("https://example.com/catalog-create.jpg");

    const linkage = await queryOne<{
      stocked_quantity: string;
      cost_price: string;
      reorder_level: number;
    }>(client, `
      SELECT
        il.stocked_quantity::numeric AS stocked_quantity,
        ps.cost_price::numeric AS cost_price,
        ps.reorder_level
      FROM public.product_variant v
      JOIN public.product_variant_inventory_item pvii ON pvii.variant_id = v.id AND pvii.deleted_at IS NULL
      JOIN public.inventory_level il ON il.inventory_item_id = pvii.inventory_item_id AND il.deleted_at IS NULL
      JOIN inventory.product_settings ps ON ps.variant_id = v.id
      WHERE v.product_id = $1
      LIMIT 1
    `, [product.id]);
    expect(Number(linkage?.stocked_quantity || 0)).toBe(0);
    expect(Number(linkage?.cost_price || 0)).toBe(99000);
    expect(Number(linkage?.reorder_level || 0)).toBe(9);

    const nextCategory = await createProductCategory(
      { "idempotency-key": `db-test:${runId}:category-next` },
      { name: `Next ${runId}`, isActive: true },
      actor,
      catalogScope,
    );
    createdCategoryIds.push(nextCategory.response.product_category.id);

    const updated = await updateProduct(
      { "idempotency-key": `db-test:${runId}:product-update` },
      product.id,
      {
        title: `Zero Stock Updated ${runId}`,
        status: "published",
        sku: `ZERO-${runId}`,
        barcode: `ZERO-BAR-${runId}`,
        price: 155000,
        costPrice: 100000,
        reorderLevel: 11,
        categoryIds: [nextCategory.response.product_category.id],
        imageUrl: "https://example.com/catalog-update.jpg",
      },
      actor,
      catalogScope,
      catalogOperatingScope,
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.response.product.categories[0]?.id).toBe(nextCategory.response.product_category.id);
    expect(updated.response.product.variants[0]?.inventory_quantity).toBe(0);
    expect(updated.response.product.imageUrl).toBe("https://example.com/catalog-update.jpg");

    const posByCategoryId = await listProducts({ merchantId: catalogScope.merchantId, categoryId: nextCategory.response.product_category.id, limit: 20 });
    expect(posByCategoryId.some((item) => item.id === product.id)).toBe(true);
    expect(posByCategoryId.find((item) => item.id === product.id)?.imageUrl).toBe("https://example.com/catalog-update.jpg");

    const posByHandle = await listProducts({ merchantId: catalogScope.merchantId, categoryHandle: nextCategory.response.product_category.handle, limit: 20 });
    expect(posByHandle.some((item) => item.id === product.id)).toBe(true);

    const adminFiltered = await listAdminProducts({
      q: `Zero Stock Updated ${runId}`,
      merchantId: catalogScope.merchantId,
      status: "published",
      categoryId: nextCategory.response.product_category.id,
      limit: 20,
    });
    expect(adminFiltered.products.some((item) => item.id === product.id)).toBe(true);
    expect(adminFiltered.products.find((item) => item.id === product.id)?.imageUrl).toBe("https://example.com/catalog-update.jpg");

    const cleared = await updateProduct(
      { "idempotency-key": `db-test:${runId}:product-image-clear` },
      product.id,
      { imageUrl: "" },
      actor,
      catalogScope,
    );
    expect(cleared.response.product.imageUrl).toBe("");
    const metadataAfterClear = await queryOne<{ metadata: Record<string, unknown> }>(
      client,
      "SELECT metadata FROM public.product WHERE id = $1",
      [product.id],
    );
    expect(metadataAfterClear?.metadata).not.toHaveProperty("imageUrl");
    expect(metadataAfterClear?.metadata).toHaveProperty("category");

    const categories = await listProductCategories(catalogScope.merchantId, { q: `Next ${runId}`, status: "active", includeProductCounts: true });
    const matched = categories.product_categories.find((item) => item.id === nextCategory.response.product_category.id);
    expect(Number(matched?.productCount || 0)).toBeGreaterThan(0);
  });

  it("auto-generates a unique SKU when creating a new product without user-defined SKU", async () => {
    const productResult = await createProduct(
      { "idempotency-key": `db-test:${runId}:product-auto-sku` },
      {
        title: `Túi bạc hà mới ${runId}`,
        status: "published",
        barcode: `AUTO-BAR-${runId}`,
        price: 99000,
        costPrice: 66000,
        reorderLevel: 4,
        categoryIds: [],
      },
      actor,
      catalogScope,
      catalogOperatingScope,
    );
    expect(productResult.statusCode).toBe(201);
    const product = productResult.response.product;
    createdProductIds.push(product.id);

    const sku = product.variants[0]?.sku;
    expect(sku).toMatch(/^TUI-BAC-HA-MOI-/);

    const linkedSku = await queryOne<{ variant_sku: string; inventory_sku: string }>(client, `
      SELECT v.sku AS variant_sku, ii.sku AS inventory_sku
      FROM public.product_variant v
      JOIN public.product_variant_inventory_item pvii ON pvii.variant_id = v.id AND pvii.deleted_at IS NULL
      JOIN public.inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
      WHERE v.product_id = $1
      LIMIT 1
    `, [product.id]);
    expect(linkedSku?.variant_sku).toBe(sku);
    expect(linkedSku?.inventory_sku).toBe(sku);
  });

  it("pages the full filtered product set, reports matching metrics, and finds a secondary live variant", async () => {
    const category = await createProductCategory(
      { "idempotency-key": `db-test:${runId}:category-pagination` },
      { name: `Pagination ${runId}`, isActive: true },
      actor,
      catalogScope,
    );
    createdCategoryIds.push(category.response.product_category.id);
    const sharedTitle = `Catalog pagination ${runId}`;
    const create = async (suffix: string, status: "published" | "draft", categoryIds: string[]) => {
      const result = await createProduct(
        { "idempotency-key": `db-test:${runId}:product-pagination:${suffix}` },
        {
          title: `${sharedTitle} ${suffix}`,
          status,
          sku: `PAGE-${runId}-${suffix}`,
          barcode: `PAGE-BAR-${runId}-${suffix}`,
          price: 100_000,
          costPrice: 70_000,
          reorderLevel: 5,
          categoryIds,
        },
        actor,
        catalogScope,
        catalogOperatingScope,
      );
      createdProductIds.push(result.response.product.id);
      return result.response.product;
    };

    const categorized = await create("a", "published", [category.response.product_category.id]);
    const publishedUncategorized = await create("b", "published", []);
    const draftUncategorized = await create("c", "draft", []);
    const productIds = [categorized.id, publishedUncategorized.id, draftUncategorized.id];
    await client.query(`
      UPDATE public.product
      SET title = $1,
          updated_at = $2::timestamptz
      WHERE id = ANY($3::text[])
    `, [sharedTitle, "2026-10-18T00:00:00.000Z", productIds]);

    const secondaryVariantId = `var_secondary_${runId}`;
    const secondarySku = `SECONDARY-${runId}`;
    await client.query(`
      INSERT INTO public.product_variant (id, title, sku, barcode, product_id, manage_inventory)
      VALUES ($1, 'Secondary', $2, $3, $4, true)
    `, [secondaryVariantId, secondarySku, `SECONDARY-BAR-${runId}`, publishedUncategorized.id]);
    try {
      const expectedOrder = [...productIds].sort();
      const firstPage = await listAdminProducts({
        q: sharedTitle,
        merchantId: catalogScope.merchantId,
        status: "all",
        limit: 2,
        offset: 0,
      });
      expect(firstPage.products.map((product) => product.id)).toEqual(expectedOrder.slice(0, 2));
      expect(firstPage).toMatchObject({
        count: 3,
        metrics: { total: 3, published: 2, draft: 1, uncategorized: 2 },
      });

      const secondPage = await listAdminProducts({
        q: sharedTitle,
        merchantId: catalogScope.merchantId,
        status: "all",
        limit: 2,
        offset: 2,
      });
      expect(secondPage.products.map((product) => product.id)).toEqual(expectedOrder.slice(2));

      const published = await listAdminProducts({
        q: sharedTitle,
        merchantId: catalogScope.merchantId,
        status: "published",
        limit: 20,
      });
      expect(published).toMatchObject({
        count: 2,
        metrics: { total: 2, published: 2, draft: 0, uncategorized: 1 },
      });

      const categoryFiltered = await listAdminProducts({
        q: sharedTitle,
        merchantId: catalogScope.merchantId,
        categoryId: category.response.product_category.id,
        limit: 20,
      });
      expect(categoryFiltered).toMatchObject({
        count: 1,
        metrics: { total: 1, published: 1, draft: 0, uncategorized: 0 },
      });

      const adminSecondaryMatch = await listAdminProducts({
        q: secondarySku,
        merchantId: catalogScope.merchantId,
        limit: 20,
      });
      expect(adminSecondaryMatch.products.map((product) => product.id)).toEqual([publishedUncategorized.id]);
      expect(adminSecondaryMatch.products[0]!.variants[0]).toMatchObject({ id: secondaryVariantId, sku: secondarySku });

      const posSecondaryMatch = await listProducts({
        q: secondarySku,
        merchantId: catalogScope.merchantId,
        limit: 20,
      });
      expect(posSecondaryMatch.map((product) => product.id)).toEqual([publishedUncategorized.id]);
      expect(posSecondaryMatch[0]!.variants[0]).toMatchObject({ id: secondaryVariantId, sku: secondarySku });
      const barcodeMatch = await listProducts({ q: `SECONDARY-BAR-${runId}`, merchantId: catalogScope.merchantId });
      expect(barcodeMatch[0]!.variants[0]).toMatchObject({ id: secondaryVariantId, sku: secondarySku });
    } finally {
      await client.query("DELETE FROM public.product_variant WHERE id = $1", [secondaryVariantId]);
    }
  });
});
