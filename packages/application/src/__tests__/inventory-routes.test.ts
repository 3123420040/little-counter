import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  adjustStock: vi.fn(),
  cancelPurchaseOrder: vi.fn(),
  closeShortPurchaseOrder: vi.fn(),
  createPurchaseOrder: vi.fn(),
  createStockMovementHistoryExportCsv: vi.fn(),
  getPurchaseOrderDetail: vi.fn(),
  listPurchaseOrders: vi.fn(),
  listPurchaseOrderCatalog: vi.fn(),
  listStockMovements: vi.fn(),
  listInventoryItems: vi.fn(),
  receivePurchaseOrder: vi.fn(),
  sendPurchaseOrder: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  actorWithOperatingScopeMutation: vi.fn(),
  actorWithOperatingScopeAccess: vi.fn(),
  body: vi.fn(),
  headers: vi.fn((request) => request.headers),
  query: vi.fn(),
  csvDownloadRoute: vi.fn(async (_response, _filename, handler) => handler()),
  route: vi.fn(async (_response, handler) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { POST as adjustStockRoute } from "../../../../src/api/inventory/adjust/route";
import { GET as listPurchaseOrdersRoute, POST as createPurchaseOrderRoute } from "../../../../src/api/inventory/purchase-orders/route";
import { GET as getPurchaseOrderDetailRoute } from "../../../../src/api/inventory/purchase-orders/[id]/route";
import { GET as listPurchaseOrderCatalogRoute } from "../../../../src/api/inventory/purchase-orders/catalog/route";
import { POST as receivePurchaseOrderRoute } from "../../../../src/api/inventory/purchase-orders/[id]/receive/route";
import { POST as sendPurchaseOrderRoute } from "../../../../src/api/inventory/purchase-orders/[id]/send/route";
import { POST as cancelPurchaseOrderRoute } from "../../../../src/api/inventory/purchase-orders/[id]/cancel/route";
import { POST as closeShortPurchaseOrderRoute } from "../../../../src/api/inventory/purchase-orders/[id]/close-short/route";
import { GET as listStockMovementsRoute } from "../../../../src/api/inventory/movements/route";
import { GET as exportStockMovementsRoute } from "../../../../src/api/inventory/movements/export/route";
import { GET as listInventoryItemsRoute } from "../../../../src/api/admin/inventory-items/route";

const actor = { operatorId: "op_owner", role: "owner", displayName: "Owner", organizationId: "org_default" };
const operatingScope = { scopeKind: "operating", merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" };
const response = {
  status: vi.fn(() => response),
  json: vi.fn(),
} as never;

function request(body: Record<string, unknown> = {}, params: Record<string, string> = {}, reqQuery: Record<string, string> = {}) {
  return { headers: {}, body, params, query: reqQuery } as never;
}

function forbidden() {
  return Object.assign(new Error("forbidden"), { code: "forbidden" });
}

describe("inventory routes enforce explicit operating-scope authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.body.mockImplementation((req) => req.body);
    routeUtils.headers.mockImplementation((req) => req.headers);
    routeUtils.query.mockImplementation((req) => req.query || {});
    routeUtils.actorWithOperatingScopeMutation.mockResolvedValue({ actor, scope: operatingScope });
    routeUtils.actorWithOperatingScopeAccess.mockResolvedValue({ actor, scope: operatingScope });
    application.adjustStock.mockResolvedValue({ statusCode: 201, response: { data: { newLevel: 10 } } });
    application.createPurchaseOrder.mockResolvedValue({ statusCode: 201, response: { data: { id: "po_1" } } });
    application.createStockMovementHistoryExportCsv.mockResolvedValue("timestamp,sku\r\n");
    application.receivePurchaseOrder.mockResolvedValue({ statusCode: 201, response: { data: { id: "po_1", status: "received" } } });
    application.sendPurchaseOrder.mockResolvedValue({ statusCode: 201, response: { data: { id: "po_1", status: "sent" } } });
    application.cancelPurchaseOrder.mockResolvedValue({ statusCode: 201, response: { data: { id: "po_1", status: "cancelled" } } });
    application.closeShortPurchaseOrder.mockResolvedValue({ statusCode: 201, response: { data: { id: "po_1", status: "closed_short" } } });
    application.getPurchaseOrderDetail.mockResolvedValue({ data: { id: "po_1" } });
    application.listPurchaseOrders.mockResolvedValue({ data: [] });
    application.listPurchaseOrderCatalog.mockResolvedValue({ data: [], page: { total: 0, limit: 25, offset: 0 } });
    application.listStockMovements.mockResolvedValue({ data: [] });
    application.listInventoryItems.mockResolvedValue({ inventory_items: [] });
  });

  it("stock adjustment uses inventory:write and the resolved operating scope", async () => {
    await adjustStockRoute(request({ inventoryItemId: "var_mint_20", adjustment: 1 }), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.inventoryWrite);
    expect(routeUtils.actorWithOperatingScopeMutation).not.toHaveBeenCalledWith(expect.anything(), "manager", "inventory:read");
    expect(application.adjustStock).toHaveBeenCalledWith(expect.anything(), expect.anything(), actor, operatingScope);
  });

  it.each([
    { actorKind: "accountant (no inventory:write)" },
    { actorKind: "staff without inventory:write" },
    { actorKind: "platform read-only/all scope" },
    { actorKind: "actor with no operating store" },
  ])("denies stock adjustment by $actorKind before the service is called", async () => {
    routeUtils.actorWithOperatingScopeMutation.mockRejectedValue(forbidden());

    await expect(adjustStockRoute(request({ inventoryItemId: "var_mint_20", adjustment: 1 }), response)).rejects.toMatchObject({ code: "forbidden" });
    expect(application.adjustStock).not.toHaveBeenCalled();
  });

  it("purchase-order creation stamps merchant/store via inventory:write scope", async () => {
    await createPurchaseOrderRoute(request({ supplierName: "S", items: [{ variantId: "v", quantity: 1, unitCost: 1 }] }), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.inventoryWrite);
    expect(application.createPurchaseOrder).toHaveBeenCalledWith(expect.anything(), expect.anything(), actor, operatingScope);
  });

  it("purchase-order receive requires inventory:write scope and rejects cross-store", async () => {
    await receivePurchaseOrderRoute(request({ items: [{ purchaseOrderItemId: "poi_1", receivedQuantity: 1 }] }, { id: "po_1" }), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.inventoryWrite);
    expect(application.receivePurchaseOrder).toHaveBeenCalledWith(expect.anything(), "po_1", expect.anything(), actor, operatingScope);
  });

  it("purchase-order detail requires inventory:read operating scope", async () => {
    await getPurchaseOrderDetailRoute(request({}, { id: "po_1" }, { receiptLimit: "10", receiptOffset: "20" }), response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.inventoryRead);
    expect(application.getPurchaseOrderDetail).toHaveBeenCalledWith("po_1", operatingScope, { receiptLimit: "10", receiptOffset: "20" });
  });

  it("purchase-order catalog is server-filtered and scoped before listing variants", async () => {
    const filters = { q: "mint", limit: "25", offset: "100", selectedVariantIds: "var_1,var_2" };
    await listPurchaseOrderCatalogRoute(request({}, {}, filters), response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.inventoryRead);
    expect(application.listPurchaseOrderCatalog).toHaveBeenCalledWith(operatingScope, filters);
  });

  it.each([
    { name: "send", route: sendPurchaseOrderRoute, fn: application.sendPurchaseOrder, body: { note: "sent to supplier" } },
    { name: "cancel", route: cancelPurchaseOrderRoute, fn: application.cancelPurchaseOrder, body: { reason: "supplier changed" } },
    { name: "close short", route: closeShortPurchaseOrderRoute, fn: application.closeShortPurchaseOrder, body: { reason: "short shipment" } },
  ])("purchase-order $name uses inventory:write operating scope", async ({ route: handler, fn, body: routeBody }) => {
    await handler(request(routeBody, { id: "po_1" }), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.inventoryWrite);
    expect(fn).toHaveBeenCalledWith(expect.anything(), "po_1", expect.anything(), actor, operatingScope);
  });

  it.each([
    { actorKind: "accountant", route: "receive" as const },
    { actorKind: "platform all/read scope", route: "receive" as const },
  ])("denies purchase-order receive by $actorKind before the service is called", async () => {
    routeUtils.actorWithOperatingScopeMutation.mockRejectedValue(forbidden());

    await expect(receivePurchaseOrderRoute(request({ items: [] }, { id: "po_1" }), response)).rejects.toMatchObject({ code: "forbidden" });
    expect(application.receivePurchaseOrder).not.toHaveBeenCalled();
  });

  it("purchase-order list requires inventory:read and one operating scope (not platform read)", async () => {
    await listPurchaseOrdersRoute(request(), response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.inventoryRead);
    expect(application.listPurchaseOrders).toHaveBeenCalledWith(operatingScope);
  });

  it("stock-movement list requires inventory:read operating scope", async () => {
    await listStockMovementsRoute(request({}, {}, { inventoryItemId: "i_1", direction: "out" }), response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.inventoryRead);
    expect(application.listStockMovements).toHaveBeenCalledWith(operatingScope, { inventoryItemId: "i_1", direction: "out" });
  });

  it("stock-movement export requires inventory:read and streams filtered CSV", async () => {
    await exportStockMovementsRoute(request({}, {}, { inventoryItemId: "i_1", sourceAction: "pos_sale" }), response);

    expect(routeUtils.csvDownloadRoute).toHaveBeenCalledWith(response, "inventory-stock-history-export.csv", expect.any(Function));
    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.inventoryRead);
    expect(application.createStockMovementHistoryExportCsv).toHaveBeenCalledWith(operatingScope, { inventoryItemId: "i_1", sourceAction: "pos_sale" });
  });

  it("inventory-items list requires inventory:read operating scope", async () => {
    await listInventoryItemsRoute(request(), response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.inventoryRead);
    expect(application.listInventoryItems).toHaveBeenCalledWith(operatingScope);
  });

  it("denies inventory read without an explicit operating scope", async () => {
    routeUtils.actorWithOperatingScopeAccess.mockRejectedValue(forbidden());

    await expect(listPurchaseOrdersRoute(request(), response)).rejects.toMatchObject({ code: "forbidden" });
    expect(application.listPurchaseOrders).not.toHaveBeenCalled();
  });
});
