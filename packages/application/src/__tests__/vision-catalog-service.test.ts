import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  client: { query: vi.fn() },
  ensurePlatformSchema: vi.fn(),
  lifecycleGuard: vi.fn(),
}));

vi.mock("../db/schema", () => ({
  ensurePlatformSchema: db.ensurePlatformSchema,
}));

vi.mock("../services/business-lifecycle-service", () => ({ lockActiveBusinessScopeForClient: db.lifecycleGuard }));

vi.mock("../db/transaction", () => ({
  withConnectedTransaction: vi.fn(async (handler: (client: typeof db.client) => Promise<unknown>) => handler(db.client)),
  withConnectedClient: vi.fn(async (handler: (client: typeof db.client) => Promise<unknown>) => handler(db.client)),
}));

import {
  createVisionReferenceImage,
  listVisionCatalogReadiness,
  listVisionReferenceImagesForProvider,
  syncVisionReferenceImagesFromProductMetadata,
  updateVisionReferenceImage,
  uploadVisionReferenceImage,
} from "../services/vision-catalog-service";

const originalEnv = { ...process.env };

describe("vision catalog service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.lifecycleGuard.mockReset();
    db.client.query.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it.each(["store_primary", null])("freezes and locks the implicit primary image target %s before sync", async storeId => {
    db.client.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FROM app.stores")
      ? storeId ? [{ id: storeId }] : [] : [{ inserted_count: 0, total_products_with_image_url: 0 }] }));
    await syncVisionReferenceImagesFromProductMetadata({ merchantId: "merchant_a" });
    expect(db.client.query).toHaveBeenCalledWith(expect.stringMatching(/FROM app\.stores[\s\S]*FOR SHARE/), ["merchant_a"]);
    expect(db.client.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO app.product_variant_images"), ["merchant_a", storeId]);
  });

  it("syncs reference images from product metadata through the requested merchant and store", async () => {
    db.client.query.mockResolvedValueOnce({
      rows: [{
        inserted_count: "2",
        total_products_with_image_url: "152",
      }],
    });

    const result = await syncVisionReferenceImagesFromProductMetadata({
      merchantId: "merchant_a",
      storeId: "store_a",
    });

    expect(result).toEqual({ insertedCount: 2, totalProductsWithImageUrl: 152 });
    expect(db.ensurePlatformSchema).toHaveBeenCalledOnce();
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO app.product_variant_images"),
      ["merchant_a", "store_a"],
    );
  });

  it("maps catalog readiness states from image and provider index counts", async () => {
    const baseReadinessRow = {
      status: "published",
      barcode: "",
      metadata_image_url: "",
      primary_image_id: "",
      primary_image_url: "",
      reference_image_count: "0",
      approved_image_count: "0",
      pending_image_count: "0",
      rejected_image_count: "0",
      approved_front_image_count: "0",
      approved_counter_capture_image_count: "0",
      approved_strength_text_image_count: "0",
      pending_front_image_count: "0",
      pending_counter_capture_image_count: "0",
      pending_strength_text_image_count: "0",
      indexed_image_count: "0",
      synced_image_count: "0",
      failed_index_count: "0",
      is_high_risk_variant: true,
    };

    db.client.query.mockResolvedValueOnce({
      rows: [
        {
          ...baseReadinessRow,
          product_id: "prod_1",
          variant_id: "var_1",
          title: "Missing Front",
          sku: "NOIMG",
        },
        {
          ...baseReadinessRow,
          product_id: "prod_2",
          variant_id: "var_2",
          title: "Missing Strength",
          sku: "STRENGTH",
          metadata_image_url: "https://cdn.example/strength.jpg",
          primary_image_id: "img_front",
          primary_image_url: "https://cdn.example/front.jpg",
          approved_image_count: "2",
          approved_front_image_count: "1",
          approved_counter_capture_image_count: "1",
          reference_image_count: "2",
        },
        {
          ...baseReadinessRow,
          product_id: "prod_3",
          variant_id: "var_3",
          title: "Pending Strength Approval",
          sku: "PENDING",
          metadata_image_url: "https://cdn.example/pending.jpg",
          primary_image_id: "img_front_pending",
          primary_image_url: "https://cdn.example/front-pending.jpg",
          approved_image_count: "2",
          approved_front_image_count: "1",
          approved_counter_capture_image_count: "1",
          pending_image_count: "1",
          pending_strength_text_image_count: "1",
          reference_image_count: "3",
        },
        {
          ...baseReadinessRow,
          product_id: "prod_4",
          variant_id: "var_4",
          title: "Needs Index",
          sku: "INDEX",
          metadata_image_url: "https://cdn.example/index.jpg",
          primary_image_id: "img_2",
          primary_image_url: "https://cdn.example/index.jpg",
          reference_image_count: "3",
          approved_image_count: "3",
          approved_front_image_count: "1",
          approved_counter_capture_image_count: "1",
          approved_strength_text_image_count: "1",
        },
        {
          ...baseReadinessRow,
          product_id: "prod_5",
          variant_id: "var_5",
          title: "Failed Index",
          sku: "FAIL",
          metadata_image_url: "https://cdn.example/fail.jpg",
          primary_image_id: "img_3",
          primary_image_url: "https://cdn.example/fail.jpg",
          reference_image_count: "1",
          approved_image_count: "3",
          approved_front_image_count: "1",
          approved_counter_capture_image_count: "1",
          approved_strength_text_image_count: "1",
          pending_image_count: "0",
          rejected_image_count: "0",
          indexed_image_count: "1",
          synced_image_count: "0",
          failed_index_count: "1",
        },
        {
          ...baseReadinessRow,
          product_id: "prod_6",
          variant_id: "var_6",
          title: "Ready",
          sku: "READY",
          metadata_image_url: "https://cdn.example/ready.jpg",
          primary_image_id: "img_4",
          primary_image_url: "https://cdn.example/ready.jpg",
          reference_image_count: "3",
          approved_image_count: "3",
          approved_front_image_count: "1",
          approved_counter_capture_image_count: "1",
          approved_strength_text_image_count: "1",
          pending_image_count: "0",
          rejected_image_count: "0",
          indexed_image_count: "3",
          synced_image_count: "3",
          failed_index_count: "0",
        },
      ],
    });

    const items = await listVisionCatalogReadiness({
      merchantId: "merchant_a",
      storeId: "store_a",
      provider: "google_product_search",
      q: "mint",
      limit: 20,
    });

    expect(items.map((item) => item.readiness)).toEqual([
      "needs_image",
      "needs_image",
      "needs_image",
      "needs_index",
      "index_failed",
      "ready",
    ]);
    expect(items.map((item) => item.readinessStatus)).toEqual([
      "missing_front_image",
      "missing_strength_image",
      "pending_approval",
      "pending_provider_sync",
      "index_failed",
      "ready_for_single_scan",
    ]);
    expect(items[0].missingImageTypes).toEqual(["front", "counter_capture", "strength_text"]);
    expect(items[2].readinessReasons).toContain("pending_strength_text_approval");
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("app.vision_catalog_index_items"),
      ["merchant_a", "store_a", "google_product_search", "%mint%", 20, 0],
    );
  });

  it("lists only approved provider reference images by default", async () => {
    db.client.query.mockResolvedValueOnce({
      rows: [{
        image_id: "img_1",
        merchant_id: "merchant_a",
        store_id: null,
        product_id: "prod_1",
        variant_id: "var_1",
        title: "VEL Crispy Peppermint",
        sku: "VEL-CRISPY-PEPPERMINT",
        barcode: "",
        image_url: "https://cdn.example/vel.jpg",
        image_type: "primary",
        quality_status: "approved",
        is_primary: true,
        provider_product_ref: "",
        provider_image_ref: "",
        created_at: new Date("2026-06-28T00:00:00.000Z"),
        updated_at: new Date("2026-06-28T00:00:00.000Z"),
      }],
    });

    const images = await listVisionReferenceImagesForProvider({
      merchantId: "merchant_a",
      provider: "google_product_search",
    });

    expect(images[0]).toMatchObject({
      imageId: "img_1",
      storeId: null,
      sku: "VEL-CRISPY-PEPPERMINT",
      qualityStatus: "approved",
      isPrimary: true,
    });
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("image.quality_status = 'approved'"),
      ["merchant_a", null, "google_product_search", false, 500, 0],
    );
  });

  it("can include pending provider reference images for admin review or explicit local UAT override", async () => {
    db.client.query.mockResolvedValueOnce({
      rows: [{
        image_id: "img_pending",
        merchant_id: "merchant_a",
        store_id: null,
        product_id: "prod_1",
        variant_id: "var_1",
        title: "VEL Crispy Peppermint",
        sku: "VEL-CRISPY-PEPPERMINT",
        barcode: "",
        image_url: "https://cdn.example/vel-pending.jpg",
        image_type: "primary",
        quality_status: "pending",
        is_primary: true,
        provider_product_ref: "",
        provider_image_ref: "",
        created_at: new Date("2026-06-28T00:00:00.000Z"),
        updated_at: new Date("2026-06-28T00:00:00.000Z"),
      }],
    });

    const images = await listVisionReferenceImagesForProvider({
      merchantId: "merchant_a",
      provider: "google_vision_ocr",
      includePending: "true",
    });

    expect(images[0]).toMatchObject({
      imageId: "img_pending",
      qualityStatus: "pending",
    });
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("$4::boolean = true AND image.quality_status = 'pending'"),
      ["merchant_a", null, "google_vision_ocr", true, 500, 0],
    );
  });

  it("creates a manual reference image after validating merchant variant and primary scope", async () => {
    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM app.stores")) return { rows: [{ id: "store_a" }] };
      if (sql.includes("FROM public.product_variant v")) return { rows: [{ product_id: "prod_1", variant_id: "var_1" }] };
      if (sql.includes("UPDATE app.product_variant_images") && sql.includes("is_primary = false")) return { rows: [] };
      if (sql.includes("INSERT INTO app.product_variant_images")) return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
      if (sql.includes("WHERE image.merchant_id = $1")) {
        return { rows: [{
          image_id: "11111111-1111-4111-8111-111111111111",
          merchant_id: "merchant_a",
          store_id: "store_a",
          product_id: "prod_1",
          variant_id: "var_1",
          title: "VEL Crispy Peppermint",
          sku: "VEL-CRISPY-PEPPERMINT",
          barcode: "",
          image_url: "https://cdn.example/manual.jpg",
          image_type: "front",
          quality_status: "approved",
          is_primary: true,
          provider_product_ref: "",
          provider_image_ref: "",
          created_at: new Date("2026-06-28T00:00:00.000Z"),
          updated_at: new Date("2026-06-28T00:00:00.000Z"),
        }] };
      }
      return { rows: [] };
    });

    const image = await createVisionReferenceImage({
      merchantId: "merchant_a",
      storeId: "store_a",
      productId: "prod_1",
      variantId: "var_1",
      imageUrl: "https://cdn.example/manual.jpg",
      imageType: "front",
      qualityStatus: "approved",
      isPrimary: true,
    });

    expect(image).toMatchObject({
      imageId: "11111111-1111-4111-8111-111111111111",
      storeId: "store_a",
      imageUrl: "https://cdn.example/manual.jpg",
      qualityStatus: "approved",
      isPrimary: true,
    });
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE app.product_variant_images"),
      ["merchant_a", "store_a", "var_1", null],
    );
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO app.product_variant_images"),
      expect.arrayContaining(["merchant_a", "store_a", "prod_1", "var_1", "https://cdn.example/manual.jpg"]),
    );
  });

  it("uploads a reference image to GCS before inserting its gs:// URI", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vision-reference-upload-"));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const credentialsPath = join(tempDir, "service-account.json");
    await writeFile(credentialsPath, JSON.stringify({
      client_email: "vision-test@example.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      token_uri: "https://oauth2.googleapis.com/token",
    }));

    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    process.env.GOOGLE_VISION_REFERENCE_BUCKET = "snus-vision-ref-test";
    process.env.GOOGLE_VISION_REFERENCE_PREFIX = "uat-reference-images";
    process.env.VISION_REFERENCE_IMAGE_MAX_BYTES = "1024";

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-token", expires_in: 3600 }), { status: 200 });
      }
      if (href.startsWith("https://storage.googleapis.com/upload/storage/v1/b/snus-vision-ref-test/o")) {
        return new Response(JSON.stringify({ name: "uploaded-object" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    let insertedImageUrl = "";
    db.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM app.stores")) return { rows: [{ id: "store_a" }] };
      if (sql.includes("FROM public.product_variant v")) return { rows: [{ product_id: "prod_1", variant_id: "var_1" }] };
      if (sql.includes("UPDATE app.product_variant_images") && sql.includes("is_primary = false")) return { rows: [] };
      if (sql.includes("INSERT INTO app.product_variant_images")) {
        insertedImageUrl = String(params?.[4] || "");
        return { rows: [{ id: "22222222-2222-4222-8222-222222222222" }] };
      }
      if (sql.includes("WHERE image.merchant_id = $1")) {
        return { rows: [{
          image_id: "22222222-2222-4222-8222-222222222222",
          merchant_id: "merchant_a",
          store_id: "store_a",
          product_id: "prod_1",
          variant_id: "var_1",
          title: "VEL Crispy Peppermint",
          sku: "VEL-CRISPY-PEPPERMINT",
          barcode: "",
          image_url: insertedImageUrl,
          image_type: "counter_capture",
          quality_status: "approved",
          is_primary: true,
          provider_product_ref: "",
          provider_image_ref: "",
          created_at: new Date("2026-06-28T00:00:00.000Z"),
          updated_at: new Date("2026-06-28T00:00:00.000Z"),
        }] };
      }
      return { rows: [] };
    });

    try {
      const image = await uploadVisionReferenceImage({
        merchantId: "merchant_a",
        storeId: "store_a",
        productId: "prod_1",
        variantId: "var_1",
        imageBase64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        fileName: "counter-photo.png",
        imageType: "counter_capture",
        qualityStatus: "approved",
        isPrimary: true,
      });

      expect(image.imageUrl).toMatch(/^gs:\/\/snus-vision-ref-test\/uat-reference-images\/merchant_a\/store_a\/var_1\//);
      expect(fetchMock).toHaveBeenCalledWith("https://oauth2.googleapis.com/token", expect.objectContaining({
        method: "POST",
      }));
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("https://storage.googleapis.com/upload/storage/v1/b/snus-vision-ref-test/o"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer google-token",
            "Content-Type": "image/png",
          }),
        }),
      );
      expect(db.client.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO app.product_variant_images"),
        expect.arrayContaining(["merchant_a", "store_a", "prod_1", "var_1", insertedImageUrl, "counter_capture", "manual", "approved", true]),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updates reference image quality and clears primary when rejected", async () => {
    let lookupCount = 0;
    db.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE image.merchant_id = $1")) {
        lookupCount += 1;
        return { rows: [{
          image_id: "11111111-1111-4111-8111-111111111111",
          merchant_id: "merchant_a",
          store_id: "store_a",
          product_id: "prod_1",
          variant_id: "var_1",
          title: "VEL Crispy Peppermint",
          sku: "VEL-CRISPY-PEPPERMINT",
          barcode: "",
          image_url: "https://cdn.example/manual.jpg",
          image_type: lookupCount === 1 ? "front" : "counter_capture",
          quality_status: lookupCount === 1 ? "approved" : "rejected",
          is_primary: lookupCount === 1,
          provider_product_ref: "",
          provider_image_ref: "",
          created_at: new Date("2026-06-28T00:00:00.000Z"),
          updated_at: new Date("2026-06-28T00:01:00.000Z"),
        }] };
      }
      if (sql.includes("SELECT id FROM app.product_variant_images")) return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
      if (sql.includes("UPDATE app.product_variant_images")) return { rows: [] };
      return { rows: [] };
    });

    const image = await updateVisionReferenceImage({
      merchantId: "merchant_a",
      imageId: "11111111-1111-4111-8111-111111111111",
      imageType: "counter_capture",
      qualityStatus: "rejected",
    });

    expect(image).toMatchObject({
      imageType: "counter_capture",
      qualityStatus: "rejected",
      isPrimary: false,
    });
    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("quality_status = COALESCE"),
      ["merchant_a", "11111111-1111-4111-8111-111111111111", "counter_capture", "rejected", false, null],
    );
  });

  it("rejects non-HTTPS manual reference image URLs", async () => {
    await expect(createVisionReferenceImage({
      merchantId: "merchant_a",
      variantId: "var_1",
      imageUrl: "http://cdn.example/not-safe.jpg",
    })).rejects.toThrow("imageUrl must use HTTPS");
    expect(db.client.query).not.toHaveBeenCalled();
  });

  it("fails closed without a merchant id", async () => {
    await expect(listVisionCatalogReadiness({ merchantId: "" })).rejects.toThrow("merchantId is required");
    expect(db.client.query).not.toHaveBeenCalled();
  });
});
