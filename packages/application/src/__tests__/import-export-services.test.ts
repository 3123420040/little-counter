import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  client: { query: vi.fn() },
  ensurePlatformSchema: vi.fn(),
}));

vi.mock("../db/schema", () => ({
  ensurePlatformSchema: db.ensurePlatformSchema,
}));

vi.mock("../db/transaction", () => ({
  withConnectedClient: vi.fn(async (handler: (client: typeof db.client) => Promise<unknown>) => handler(db.client)),
}));

import {
  createProductExportCsv,
  createProductImportTemplateCsv,
} from "../services/catalog-import-export-service";
import {
  createCategoryExportCsv,
  createCategoryImportTemplateCsv,
} from "../services/category-import-export-service";
import {
  createInventoryAdjustmentExportCsv,
  createInventoryAdjustmentImportTemplateCsv,
} from "../services/inventory-import-export-service";
import {
  createPurchaseOrderDetailExportCsv,
  createPurchaseOrderExportCsv,
  createPurchaseOrderImportTemplateCsv,
  createPurchaseOrderRecommendationCsv,
  previewPurchaseOrderImport,
} from "../services/purchase-order-import-export-service";
import { createOrderExportCsv } from "../services/order-service";

const operatingScope = {
  scopeKind: "operating" as const,
  merchantId: "merchant_a",
  storeId: "store_a",
  stockLocationId: "sloc_a",
};
const reportScope = {
  scopeKind: "report" as const,
  merchantId: "merchant_a",
  storeIds: ["store_a"],
};

describe("SUB-4 scoped CSV services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.client.query.mockResolvedValue({ rows: [] });
  });

  it("exports products only through the requested merchant predicate and neutralizes formulas", async () => {
    db.client.query.mockResolvedValueOnce({
      rows: [{
        product_id: "prod_1",
        title: "=HYPERLINK(\"https://bad.example\")",
        status: "published",
        sku: "+cmd",
        barcode: "@barcode",
        price: 99000,
        cost_price: 50000,
        reorder_level: 5,
        category_handles: ["mint", "premium"],
        image_url: "https://cdn.example/product.jpg",
      }],
    });

    const csv = await createProductExportCsv("merchant_a");

    expect(db.client.query).toHaveBeenCalledWith(expect.stringContaining("p.merchant_id = $1"), ["merchant_a"]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'@barcode");
    expect(csv).toContain("mint|premium");
    expect(csv).toContain("https://cdn.example/product.jpg");
  });

  it("exports categories only through the requested merchant predicate", async () => {
    db.client.query.mockResolvedValueOnce({
      rows: [{
        category_id: "cat_1",
        name: "Mint",
        handle: "mint",
        description: "Fresh",
        rank: 1,
        is_active: true,
      }],
    });

    const csv = await createCategoryExportCsv("merchant_a");

    expect(db.client.query).toHaveBeenCalledWith(expect.stringContaining("pc.merchant_id = $1"), ["merchant_a"]);
    expect(csv).toContain("update,cat_1,Mint,mint,Fresh,1,true");
  });

  it("exports inventory adjustment identifiers for the active merchant stock location", async () => {
    db.client.query.mockResolvedValueOnce({
      rows: [{
        sku: "MINT-20",
        variant_id: "var_1",
        inventory_item_id: "ii_1",
        stock_quantity: 12,
        product_name: "Mint Medium Pouch",
        category_names: ["Snus", "Premium"],
        status: "published",
      }],
    });

    const csv = await createInventoryAdjustmentExportCsv(operatingScope);

    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("il.location_id = $1"),
      ["sloc_a", "merchant_a"],
    );
    expect(csv.split("\r\n")[0]).toBe(
      "sku,variantId,inventoryItemId,adjustment,reason,movementType,stockQuantity,productName,categoryName,status",
    );
    expect(csv).toContain("MINT-20,var_1,ii_1,,,manual_adjustment,12,Mint Medium Pouch,Snus|Premium,published");
  });

  it("exports purchase-order lines only for the active merchant and store", async () => {
    db.client.query.mockResolvedValueOnce({
      rows: [{
        supplier_name: "Nordic",
        expected_date: "2026-07-01",
        sku: "MINT-20",
        variant_id: "var_1",
        quantity: 20,
        unit_cost: 50000,
        unit_cost_quality: "known",
      }],
    });

    const csv = await createPurchaseOrderExportCsv(operatingScope);

    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("po.store_id = $2"),
      ["merchant_a", "store_a"],
    );
    expect(csv).toContain("Nordic,2026-07-01,MINT-20,var_1,20,50000,known");
  });

  it("exports purchase-order detail reconciliation rows for one scoped PO", async () => {
    db.client.query
      .mockResolvedValueOnce({
        rows: [{
          id: "po_1",
          supplier_name: "Nordic",
          status: "partially_received",
          created_at: new Date("2026-07-05T01:02:03.000Z"),
          expected_date: "2026-07-10",
          metadata: {},
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "poi_1",
          variant_id: "var_1",
          sku: "MINT-20",
          product_name: "Mint Medium",
          category_names: ["Mint", "Medium"],
          quantity: 20,
          received_quantity: 8,
          unit_cost: 50000,
          last_received_at: new Date("2026-07-05T02:03:04.000Z"),
        }],
      });

    const csv = await createPurchaseOrderDetailExportCsv("po_1", operatingScope);

    expect(db.client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("WHERE id = $1 AND merchant_id = $2 AND store_id = $3"),
      ["po_1", "merchant_a", "store_a"],
    );
    expect(csv.split("\r\n")[0]).toContain("orderedQuantity,receivedQuantity,remainingQuantity");
    expect(csv).toContain("po_1,Nordic,partially_received,2026-07-05T01:02:03.000Z,2026-07-10,MINT-20,var_1,Mint Medium,Mint|Medium,20,8,12,50000,known,1000000,400000,true,partially_received,2026-07-05T02:03:04.000Z");
  });

  it("exports recommendation CSV with import-compatible quantity and scoped sales inputs", async () => {
    db.client.query.mockResolvedValueOnce({
      rows: [{
        variant_id: "var_1",
        sku: "+MINT-20",
        product_name: "=Mint Medium",
        category_names: ["Mint"],
        current_stock: 10,
        reorder_level: 5,
        preferred_stock: 20,
        unit_cost: 50000,
        sold_7_days: 14,
        sold_30_days: 30,
        open_purchase_order_quantity: 8,
      }],
    });

    const csv = await createPurchaseOrderRecommendationCsv(operatingScope, { coverageDays: 30 });

    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("sm.stock_location_id = $2"),
      ["merchant_a", "sloc_a", "store_a"],
    );
    expect(csv.split("\r\n")[0]).toContain("requestDate,supplierName,expectedDate,sku,variantId,productName");
    expect(csv).toContain("available,10,14,30,8,47,47,50000,known");
    expect(csv).toContain("'+MINT-20");
    expect(csv).toContain("'=Mint Medium");
  });

  it("exports order line insights through report scope and neutralizes formulas", async () => {
    db.client.query.mockResolvedValueOnce({
      rows: [{
        order_id: "order_1",
        display_id: "ORD-1",
        order_status: "completed",
        customer_id: "cus_1",
        order_email: "tommy@example.com",
        currency_code: "vnd",
        order_metadata: {
          subtotal: 250000,
          discount: 0,
          shippingFee: 0,
          tax: 0,
          total: 250000,
          change: 0,
          paymentMethod: "cash",
          salesChannel: "stash_dash",
          sourceFlow: "customer_scan_go",
          salesChannelLocked: true,
          scanGoCartId: "sgc_1",
          notes: "counter pickup",
        },
        created_at: new Date("2026-06-25T12:00:00.000Z"),
        updated_at: new Date("2026-06-25T12:00:00.000Z"),
        canceled_at: null,
        merchant_id: "merchant_a",
        store_id: "store_a",
        store_name: "Default Store",
        customer_first_name: "",
        customer_last_name: "=cmd",
        customer_phone: "+441234",
        creator_actor_id: "op_1",
        creator_display_name: "Owner",
        creator_role: "owner",
        payment_method: "cash",
        payment_amount: "250000",
        payment_status: "succeeded",
        payment_reference: "@ref",
        payment_metadata: {},
        paid_at: new Date("2026-06-25T12:00:00.000Z"),
        line_id: "line_1",
        product_id: "prod_1",
        variant_id: "var_1",
        sku: "+SKU",
        barcode: "BAR",
        product_title: "ICEBERG Hardcore",
        variant_title: "Slim",
        quantity: "1",
        unit_price: "250000",
        line_total: "250000",
        basket_size: "1",
        order_hour: 19,
        order_weekday: "Thursday",
        is_first_customer_order: true,
      }],
    });

    const csv = await createOrderExportCsv({ dateFrom: "2026-06-01", dateTo: "2026-06-25", status: "completed", search: "iceberg" }, reportScope);

    expect(db.client.query).toHaveBeenCalledWith(
      expect.stringContaining("o.store_id = ANY($2::text[])"),
      ["merchant_a", ["store_a"], "2026-06-01", "2026-06-25", "%iceberg%"],
    );
    expect(csv.split("\r\n")[0]).toContain("sales_channel,sales_channel_label,sales_channel_locked,source_flow,scan_go_cart_id");
    expect(csv).toContain("stash_dash,Stash Dash,true,customer_scan_go,sgc_1");
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'+SKU");
    expect(csv).toContain("'@ref");
  });

  it("returns the frozen required columns in every import template", () => {
    expect(createProductImportTemplateCsv().trim()).toBe(
      "action,productId,title,status,sku,barcode,price,costPrice,reorderLevel,categoryHandles,imageUrl",
    );
    expect(createCategoryImportTemplateCsv().trim()).toBe(
      "action,categoryId,name,handle,description,rank,isActive",
    );
    expect(createInventoryAdjustmentImportTemplateCsv().trim()).toBe(
      "sku,variantId,inventoryItemId,adjustment,reason,movementType",
    );
    expect(createPurchaseOrderImportTemplateCsv().trim()).toBe(
      "supplierName,expectedDate,sku,variantId,quantity,unitCost,unitCostQuality",
    );
  });

  it("fails closed for zero/unknown imported purchase cost and accepts explicit free", async () => {
    db.client.query.mockResolvedValue({ rows: [{ variant_id: "var_1", sku: "SKU-1" }] });
    const header = "supplierName,expectedDate,sku,variantId,quantity,unitCost,unitCostQuality";

    const unknown = await previewPurchaseOrderImport(
      `${header}\r\nNordic,,SKU-1,var_1,2,0,\r\n`,
      operatingScope,
    );
    const explicitFree = await previewPurchaseOrderImport(
      `${header}\r\nNordic,,SKU-1,var_1,2,0,free\r\n`,
      operatingScope,
    );

    expect(unknown.valid).toBe(false);
    expect(unknown.rows[0]?.errors).toContain("unitCost 0 phải được xác nhận bằng unitCostQuality=free");
    expect(explicitFree.valid).toBe(true);
    expect(explicitFree.rows[0]?.normalized).toMatchObject({ unitCost: 0, unitCostQuality: "free" });
  });
});
