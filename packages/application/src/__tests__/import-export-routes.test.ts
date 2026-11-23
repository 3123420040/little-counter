import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  createProductExportCsv: vi.fn(),
  createProductImportTemplateCsv: vi.fn(),
  createCategoryExportCsv: vi.fn(),
  createCategoryImportTemplateCsv: vi.fn(),
  createInventoryAdjustmentExportCsv: vi.fn(),
  createInventoryAdjustmentImportTemplateCsv: vi.fn(),
  createPurchaseOrderDetailExportCsv: vi.fn(),
  createPurchaseOrderExportCsv: vi.fn(),
  createPurchaseOrderImportTemplateCsv: vi.fn(),
  createPurchaseOrderRecommendationCsv: vi.fn(),
  createOrderExportCsv: vi.fn(),
}));

const routeState = vi.hoisted(() => ({
  filenames: [] as string[],
}));

const routeUtils = vi.hoisted(() => ({
  actorWithMerchantTargetAccess: vi.fn(),
  actorWithOperatingScopeAccess: vi.fn(),
  actorWithOrderHistoryScope: vi.fn(),
  csvDownloadRoute: vi.fn(async (_response, filename: string | (() => Promise<string> | string), handler: () => Promise<string> | string) => {
    const resolvedFilename = typeof filename === "function" ? await filename() : filename;
    routeState.filenames.push(resolvedFilename);
    return handler();
  }),
  merchantTargetIdFromHeaders: vi.fn((request) => request.headers["x-merchant-id"] || request.headers["x-operating-merchant-id"] || "merchant_default"),
  query: vi.fn((request) => request.query || {}),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { GET as exportProducts } from "../../../../src/api/platform/admin/products/export/route";
import { GET as templateProducts } from "../../../../src/api/platform/admin/products/import-template/route";
import { GET as exportCategories } from "../../../../src/api/platform/admin/product-categories/export/route";
import { GET as templateCategories } from "../../../../src/api/platform/admin/product-categories/import-template/route";
import { GET as exportInventory } from "../../../../src/api/inventory/export/route";
import { GET as templateInventory } from "../../../../src/api/inventory/import-template/route";
import { GET as exportPurchaseOrders } from "../../../../src/api/inventory/purchase-orders/export/route";
import { GET as exportPurchaseOrderDetail } from "../../../../src/api/inventory/purchase-orders/[id]/export/route";
import { GET as exportPurchaseOrderRecommendation } from "../../../../src/api/inventory/purchase-orders/recommendation/export/route";
import { GET as templatePurchaseOrders } from "../../../../src/api/inventory/purchase-orders/import-template/route";
import { GET as exportOrders } from "../../../../src/api/platform/admin/orders/export/route";

const actor = { operatorId: "op_owner", role: "owner", displayName: "Owner", organizationId: "org_a" };
const merchantScope = { scopeKind: "merchant_target", merchantId: "merchant_a" };
const operatingScope = { scopeKind: "operating", merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" };
const reportScope = { scopeKind: "report", merchantId: "merchant_a", storeIds: ["store_a", "store_b"] };
const response = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), send: vi.fn() } as never;

function request() {
  return { headers: { "x-merchant-id": "merchant_a" }, query: { dateFrom: "2026-06-01", dateTo: "2026-06-25" }, params: {} } as never;
}

function forbidden() {
  return Object.assign(new Error("forbidden"), { code: "forbidden", statusCode: 403 });
}

describe("SUB-4 export/template routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeState.filenames = [];
    routeUtils.merchantTargetIdFromHeaders.mockImplementation((req) => req.headers["x-merchant-id"] || req.headers["x-operating-merchant-id"] || "merchant_default");
    routeUtils.actorWithMerchantTargetAccess.mockResolvedValue({ actor, scope: merchantScope });
    routeUtils.actorWithOperatingScopeAccess.mockResolvedValue({ actor, scope: operatingScope });
    routeUtils.actorWithOrderHistoryScope.mockResolvedValue({ actor, scope: reportScope });
    for (const service of Object.values(application)) service.mockReturnValue("header\r\n");
  });

  it("uses catalog:read and merchant scope for product export and template", async () => {
    await exportProducts(request(), response);
    await templateProducts(request(), response);

    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenNthCalledWith(1, expect.anything(), permissions.catalogRead, "merchant_a");
    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenNthCalledWith(2, expect.anything(), permissions.catalogRead, "merchant_a");
    expect(application.createProductExportCsv).toHaveBeenCalledWith("merchant_a");
    expect(application.createProductImportTemplateCsv).toHaveBeenCalledTimes(1);
  });

  it("accepts operating merchant scope for catalog downloads when explicit merchant header is absent", async () => {
    const operatingOnlyRequest = { headers: { "x-operating-merchant-id": "merchant_a" }, query: {}, params: {} } as never;

    await exportProducts(operatingOnlyRequest, response);
    await exportCategories(operatingOnlyRequest, response);

    expect(routeUtils.merchantTargetIdFromHeaders).toHaveBeenCalledWith(operatingOnlyRequest);
    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenNthCalledWith(1, expect.anything(), permissions.catalogRead, "merchant_a");
    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenNthCalledWith(2, expect.anything(), permissions.catalogRead, "merchant_a");
    expect(application.createProductExportCsv).toHaveBeenCalledWith("merchant_a");
    expect(application.createCategoryExportCsv).toHaveBeenCalledWith("merchant_a");
  });

  it("uses catalog:read and merchant scope for category export and template", async () => {
    await exportCategories(request(), response);
    await templateCategories(request(), response);

    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.catalogRead, "merchant_a");
    expect(application.createCategoryExportCsv).toHaveBeenCalledWith("merchant_a");
    expect(application.createCategoryImportTemplateCsv).toHaveBeenCalledTimes(1);
  });

  it("uses inventory:read and operating scope for inventory export and template", async () => {
    await exportInventory(request(), response);
    await templateInventory(request(), response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.inventoryRead);
    expect(application.createInventoryAdjustmentExportCsv).toHaveBeenCalledWith(operatingScope);
    expect(application.createInventoryAdjustmentImportTemplateCsv).toHaveBeenCalledTimes(1);
  });

  it("uses inventory:read and operating scope for purchase-order export and template", async () => {
    await exportPurchaseOrders(request(), response);
    await templatePurchaseOrders(request(), response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.inventoryRead);
    expect(application.createPurchaseOrderExportCsv).toHaveBeenCalledWith(operatingScope);
    expect(application.createPurchaseOrderImportTemplateCsv).toHaveBeenCalledTimes(1);
  });

  it("uses inventory:read and operating scope for purchase-order detail export", async () => {
    await exportPurchaseOrderDetail({ ...request(), params: { id: "po_1" } } as never, response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.inventoryRead);
    expect(application.createPurchaseOrderDetailExportCsv).toHaveBeenCalledWith("po_1", operatingScope);
  });

  it("uses inventory:read and operating scope for purchase-order recommendation export", async () => {
    await exportPurchaseOrderRecommendation({
      ...request(),
      query: { coverageDays: "45", includeZeroSuggestion: "false" },
    } as never, response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.inventoryRead);
    expect(application.createPurchaseOrderRecommendationCsv).toHaveBeenCalledWith(operatingScope, {
      coverageDays: 45,
      includeZeroSuggestion: false,
    });
    expect(routeState.filenames.at(-1)).toMatch(/^purchase-order-recommendation-store_a-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("uses orders:export and report scope for order export", async () => {
    await exportOrders(request(), response);

    expect(routeUtils.actorWithOrderHistoryScope).toHaveBeenCalledWith(expect.anything(), "staff", permissions.ordersExport);
    expect(application.createOrderExportCsv).toHaveBeenCalledWith({ dateFrom: "2026-06-01", dateTo: "2026-06-25" }, reportScope);
  });

  it("denies catalog downloads before export data is read", async () => {
    routeUtils.actorWithMerchantTargetAccess.mockRejectedValue(forbidden());

    await expect(exportProducts(request(), response)).rejects.toMatchObject({ code: "forbidden" });
    expect(application.createProductExportCsv).not.toHaveBeenCalled();
  });

  it("denies inventory downloads before export data is read", async () => {
    routeUtils.actorWithOperatingScopeAccess.mockRejectedValue(forbidden());

    await expect(exportInventory(request(), response)).rejects.toMatchObject({ code: "forbidden" });
    expect(application.createInventoryAdjustmentExportCsv).not.toHaveBeenCalled();
  });

  it("denies order export before export data is read", async () => {
    routeUtils.actorWithOrderHistoryScope.mockRejectedValue(forbidden());

    await expect(exportOrders(request(), response)).rejects.toMatchObject({ code: "forbidden" });
    expect(application.createOrderExportCsv).not.toHaveBeenCalled();
  });
});
