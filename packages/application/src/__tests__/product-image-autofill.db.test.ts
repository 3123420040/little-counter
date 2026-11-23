import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import type { OperatorContext } from "../services/auth-service";
import {
  createProduct,
  processOutboxEvent,
} from "../platform-db";
import { PRODUCT_IMAGE_AUTOFILL_EVENT } from "../services/product-image-autofill-service";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const actor: OperatorContext = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "DB Test Owner",
  organizationId: "org_default",
};
const catalogScope = { scopeKind: "merchant_target" as const, merchantId: "merchant_default" };
const operatingScope = {
  scopeKind: "operating" as const,
  merchantId: "merchant_default",
  storeId: "store_default",
  stockLocationId: "sloc_default",
};

const originalAutofillEnabled = process.env.PRODUCT_IMAGE_AUTOFILL_ENABLED;
const originalAutofillProvider = process.env.PRODUCT_IMAGE_AUTOFILL_PROVIDER;

let client: PoolClient;
const createdProductIds: string[] = [];

async function deleteProductDeep(productId: string): Promise<void> {
  const variants = await client.query<{ id: string; inventory_item_id: string | null; price_set_id: string | null }>(`
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
  `, [productId]);

  await client.query("DELETE FROM outbox.events WHERE aggregate_type = 'product' AND aggregate_id = $1", [productId]).catch(() => undefined);
  await client.query("DELETE FROM audit.events WHERE subject_type = 'product' AND subject_id = $1", [productId]).catch(() => undefined);

  for (const variant of variants.rows) {
    if (variant.price_set_id) {
      await client.query("DELETE FROM public.price WHERE price_set_id = $1", [variant.price_set_id]).catch(() => undefined);
      await client.query("DELETE FROM public.product_variant_price_set WHERE price_set_id = $1", [variant.price_set_id]).catch(() => undefined);
      await client.query("DELETE FROM public.price_set WHERE id = $1", [variant.price_set_id]).catch(() => undefined);
    }
    if (variant.inventory_item_id) {
      await client.query("DELETE FROM public.inventory_level WHERE inventory_item_id = $1", [variant.inventory_item_id]).catch(() => undefined);
      await client.query("DELETE FROM public.product_variant_inventory_item WHERE inventory_item_id = $1", [variant.inventory_item_id]).catch(() => undefined);
      await client.query("DELETE FROM public.inventory_item WHERE id = $1", [variant.inventory_item_id]).catch(() => undefined);
    }
    await client.query("DELETE FROM inventory.product_settings WHERE variant_id = $1", [variant.id]).catch(() => undefined);
    await client.query("DELETE FROM public.product_variant WHERE id = $1", [variant.id]).catch(() => undefined);
  }

  await client.query("DELETE FROM public.product_category_product WHERE product_id = $1", [productId]).catch(() => undefined);
  await client.query("DELETE FROM public.product WHERE id = $1", [productId]).catch(() => undefined);
}

describe("Product image autofill PostgreSQL integration", () => {
  beforeAll(async () => {
    await ensurePlatformSchema();
    client = await connectPlatformClient();
  });

  beforeEach(() => {
    process.env.PRODUCT_IMAGE_AUTOFILL_ENABLED = "true";
    process.env.PRODUCT_IMAGE_AUTOFILL_PROVIDER = "deterministic";
  });

  afterAll(async () => {
    for (const productId of createdProductIds.reverse()) {
      await deleteProductDeep(productId).catch(() => undefined);
    }
    if (originalAutofillEnabled === undefined) delete process.env.PRODUCT_IMAGE_AUTOFILL_ENABLED;
    else process.env.PRODUCT_IMAGE_AUTOFILL_ENABLED = originalAutofillEnabled;
    if (originalAutofillProvider === undefined) delete process.env.PRODUCT_IMAGE_AUTOFILL_PROVIDER;
    else process.env.PRODUCT_IMAGE_AUTOFILL_PROVIDER = originalAutofillProvider;
    client?.release();
    await shutdownPlatformDb().catch(() => undefined);
  });

  it("emits one autofill event and applies a deterministic image when product has no imageUrl", async () => {
    const productResult = await createProduct(
      { "idempotency-key": `db-test:${runId}:autofill-create` },
      {
        title: `Autofill Missing Image ${runId}`,
        status: "published",
        sku: `AUTOIMG-${runId}`,
        barcode: `AUTOIMG-BAR-${runId}`,
        price: 150000,
        costPrice: 90000,
        reorderLevel: 5,
        categoryIds: [],
      },
      actor,
      catalogScope,
      operatingScope,
    );
    const productId = productResult.response.product.id;
    createdProductIds.push(productId);

    const event = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'product'
        AND aggregate_id = $1
        AND event_type = $2
      LIMIT 1
    `, [productId, PRODUCT_IMAGE_AUTOFILL_EVENT]);
    expect(event?.payload).toMatchObject({
      productId,
      merchantId: catalogScope.merchantId,
      storeId: operatingScope.storeId,
      source: "product.create",
      requestedBy: actor.operatorId,
    });

    await processOutboxEvent({ id: event!.id, eventType: event!.event_type, payload: event!.payload });

    const product = await queryOne<{
      image_url: string;
      autofill: Record<string, unknown>;
    }>(client, `
      SELECT metadata->>'imageUrl' AS image_url,
             metadata->'imageAutofill' AS autofill
      FROM public.product
      WHERE id = $1
    `, [productId]);
    expect(product?.image_url).toContain("https://dummyimage.com/512x512/");
    expect(product?.autofill).toMatchObject({
      status: "applied",
      provider: "deterministic",
    });

    const audit = await queryOne<{ count: string }>(client, `
      SELECT count(*)::text AS count
      FROM audit.events
      WHERE subject_type = 'product'
        AND subject_id = $1
        AND action = 'product.image_autofilled'
        AND merchant_id = $2
        AND store_id = $3
    `, [productId, catalogScope.merchantId, operatingScope.storeId]);
    expect(Number(audit?.count || 0)).toBe(1);
  });

  it("does not emit autofill when product already has a user-provided imageUrl", async () => {
    const productResult = await createProduct(
      { "idempotency-key": `db-test:${runId}:manual-image-create` },
      {
        title: `Manual Image ${runId}`,
        status: "published",
        sku: `MANIMG-${runId}`,
        barcode: `MANIMG-BAR-${runId}`,
        price: 110000,
        costPrice: 70000,
        reorderLevel: 4,
        categoryIds: [],
        imageUrl: "https://example.com/manual-product.jpg",
      },
      actor,
      catalogScope,
      operatingScope,
    );
    const productId = productResult.response.product.id;
    createdProductIds.push(productId);

    const count = await queryOne<{ count: string }>(client, `
      SELECT count(*)::text AS count
      FROM outbox.events
      WHERE aggregate_type = 'product'
        AND aggregate_id = $1
        AND event_type = $2
    `, [productId, PRODUCT_IMAGE_AUTOFILL_EVENT]);
    expect(Number(count?.count || 0)).toBe(0);
  });

  it("does not overwrite a user image that was added before the autofill event is processed", async () => {
    const productResult = await createProduct(
      { "idempotency-key": `db-test:${runId}:stale-event-create` },
      {
        title: `Stale Autofill Event ${runId}`,
        status: "published",
        sku: `STALEIMG-${runId}`,
        barcode: `STALEIMG-BAR-${runId}`,
        price: 125000,
        costPrice: 80000,
        reorderLevel: 4,
        categoryIds: [],
      },
      actor,
      catalogScope,
      operatingScope,
    );
    const productId = productResult.response.product.id;
    createdProductIds.push(productId);

    const event = await queryOne<{ id: string; event_type: string; payload: Record<string, unknown> }>(client, `
      SELECT id::text, event_type, payload
      FROM outbox.events
      WHERE aggregate_type = 'product'
        AND aggregate_id = $1
        AND event_type = $2
      LIMIT 1
    `, [productId, PRODUCT_IMAGE_AUTOFILL_EVENT]);

    await client.query(`
      UPDATE public.product
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('imageUrl', 'https://example.com/operator-added.jpg')
      WHERE id = $1
    `, [productId]);

    await processOutboxEvent({ id: event!.id, eventType: event!.event_type, payload: event!.payload });

    const product = await queryOne<{
      image_url: string;
      autofill_attempted_at: string | null;
    }>(client, `
      SELECT metadata->>'imageUrl' AS image_url,
             metadata#>>'{imageAutofill,attemptedAt}' AS autofill_attempted_at
      FROM public.product
      WHERE id = $1
    `, [productId]);
    expect(product?.image_url).toBe("https://example.com/operator-added.jpg");
    expect(product?.autofill_attempted_at).toBeNull();
  });
});
