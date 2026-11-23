import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { PlatformError } from "../errors/platform-error";
import { ensureProductQrIdentity, extractProductQrSlug, getProductTagViewModel, resolveProductScan } from "../services/product-qr-service";

const scope = {
  scopeKind: "operating" as const,
  merchantId: "merchant_a",
  storeId: "store_a",
  stockLocationId: "sloc_a",
};

describe("product QR service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.lifecycleGuard.mockReset();
    db.client.query.mockResolvedValue({ rows: [] });
  });

  it("extracts the stable product QR slug from public URLs", () => {
    expect(extractProductQrSlug("https://snus.example/s/default/main/p/iceberg-black-abc123?utm=tag")).toBe("iceberg-black-abc123");
    expect(extractProductQrSlug("https://snus.example/scan/iceberg-black-abc123?utm=tag")).toBe("iceberg-black-abc123");
    expect(extractProductQrSlug("https://snus.example/shop?qr=tag-42")).toBe("tag-42");
    expect(extractProductQrSlug("SKU-42")).toBe("SKU-42");
  });

  it("creates a stable QR identity for a product variant in the active store", async () => {
    db.client.query
      .mockResolvedValueOnce({
        rows: [{
          product_id: "prod_1",
          variant_id: "var_1",
          title: "ICEBERG Hardcore",
          image_url: "",
          status: "published",
          sku: "ICE-160",
          barcode: "BAR-160",
          price: "250000",
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-4000-8000-000000000001",
          merchant_id: "merchant_a",
          store_id: "store_a",
          product_id: "prod_1",
          variant_id: "var_1",
          slug: "ice-160-abcd1234",
          public_url_path: "/s/merchant_a/store_a/p/ice-160-abcd1234",
          payload_version: 1,
          print_version: 1,
          status: "active",
        }],
      });

    const result = await ensureProductQrIdentity({ productId: "prod_1", scope });

    expect(db.client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM app.product_qr_codes"),
      ["merchant_a", "store_a", "var_1"],
    );
    expect(result.data).toMatchObject({
      productId: "prod_1",
      variantId: "var_1",
      slug: "ice-160-abcd1234",
      publicUrlPath: "/s/merchant_a/store_a/p/ice-160-abcd1234",
    });
  });

  it("upgrades existing product QR identities to the customer Scan & Go public route", async () => {
    db.client.query
      .mockResolvedValueOnce({
        rows: [{
          product_id: "prod_1",
          variant_id: "var_1",
          title: "ICEBERG Hardcore",
          image_url: "",
          status: "published",
          sku: "ICE-160",
          barcode: "BAR-160",
          price: "250000",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-4000-8000-000000000001",
          merchant_id: "merchant_a",
          store_id: "store_a",
          product_id: "prod_1",
          variant_id: "var_1",
          slug: "ice-160-abcd1234",
          public_url_path: "/scan/ice-160-abcd1234",
          payload_version: 1,
          print_version: 1,
          status: "active",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-4000-8000-000000000001",
          merchant_id: "merchant_a",
          store_id: "store_a",
          product_id: "prod_1",
          variant_id: "var_1",
          slug: "ice-160-abcd1234",
          public_url_path: "/s/merchant_a/store_a/p/ice-160-abcd1234",
          payload_version: 1,
          print_version: 1,
          status: "active",
        }],
      });

    const result = await ensureProductQrIdentity({ productId: "prod_1", scope });

    expect(db.client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE app.product_qr_codes"),
      ["00000000-0000-4000-8000-000000000001", "/s/merchant_a/store_a/p/ice-160-abcd1234"],
    );
    expect(result.data.publicUrlPath).toBe("/s/merchant_a/store_a/p/ice-160-abcd1234");
  });

  it("resolves a public product QR URL to one scoped variant for POS add-to-cart", async () => {
    db.client.query
      .mockResolvedValueOnce({
        rows: [{
          qr_code_id: "00000000-0000-4000-8000-000000000001",
          slug: "iceberg-black-abc123",
          public_url_path: "/s/merchant_a/store_a/p/iceberg-black-abc123",
          product_id: "prod_1",
          variant_id: "var_1",
          inventory_item_id: "iitem_1",
          title: "ICEBERG Hardcore",
          image_url: "",
          status: "published",
          sku: "ICE-160",
          barcode: "BAR-160",
          price: "250000",
          stock: "8",
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resolveProductScan({
      code: "https://snus.example/s/merchant_a/store_a/p/iceberg-black-abc123",
      context: "pos_add_to_cart",
    }, scope, { operatorId: "op_1", role: "staff" });

    expect(db.client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("q.slug = $1"),
      ["iceberg-black-abc123", "merchant_a", "store_a", "sloc_a"],
    );
    expect(result.data).toMatchObject({
      resolutionSource: "qr",
      productId: "prod_1",
      variantId: "var_1",
      inventoryItemId: "iitem_1",
      stock: 8,
    });
  });

  it("returns a print-safe product tag view model backed by the stable QR identity", async () => {
    const previousPublicAppUrl = process.env.PUBLIC_APP_URL;
    process.env.PUBLIC_APP_URL = "https://snus.example";
    db.client.query
      .mockResolvedValueOnce({
        rows: [{
          product_id: "prod_1",
          variant_id: "var_1",
          title: "ICEBERG Hardcore Black Fury 160mg",
          image_url: "",
          status: "published",
          sku: "ICE-160-SLIM",
          barcode: "BAR-160",
          price: "250000",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-4000-8000-000000000001",
          merchant_id: "merchant_a",
          store_id: "store_a",
          product_id: "prod_1",
          variant_id: "var_1",
          slug: "iceberg-black-abc123",
          public_url_path: "/s/merchant_a/store_a/p/iceberg-black-abc123",
          payload_version: 1,
          print_version: 2,
          status: "active",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          product_id: "prod_1",
          variant_id: "var_1",
          title: "ICEBERG Hardcore Black Fury 160mg",
          product_metadata: {},
          image_url: "",
          status: "published",
          sku: "ICE-160-SLIM",
          barcode: "BAR-160",
          price: "250000",
          category_names: ["Cooling"],
        }],
      });

    try {
      const result = await getProductTagViewModel({ productId: "prod_1", scope });

      expect(result.data).toMatchObject({
        brand: "ICEBERG",
        flavor: "Hardcore Black Fury",
        strengthLabel: "160mg/pouch",
        priceVnd: 250000,
        sku: "ICE-160-SLIM",
        barcode: "BAR-160",
        qr: {
          publicUrl: "https://snus.example/s/merchant_a/store_a/p/iceberg-black-abc123",
          printVersion: 2,
        },
      });
      expect(result.data.formatLabels).toContain("COOLING");
      expect(result.data.formatLabels).toContain("SLIM");
      expect(result.data).not.toHaveProperty("costPrice");
      expect(result.data).not.toHaveProperty("stock");
    } finally {
      if (previousPublicAppUrl === undefined) delete process.env.PUBLIC_APP_URL;
      else process.env.PUBLIC_APP_URL = previousPublicAppUrl;
    }
  });

  it("fails closed when a raw internal scan code is ambiguous", async () => {
    db.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { product_id: "prod_1", variant_id: "var_1", inventory_item_id: "iitem_1", title: "One", status: "published" },
          { product_id: "prod_2", variant_id: "var_2", inventory_item_id: "iitem_2", title: "Two", status: "published" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(resolveProductScan({ code: "DUP-SKU", context: "inventory_check" }, scope))
      .rejects.toMatchObject({ code: "ambiguous_scan_code" } satisfies Partial<PlatformError>);
  });
});
