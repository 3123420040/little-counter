import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  listAdminProducts: vi.fn(),
  listCustomers: vi.fn(),
  listProductCategories: vi.fn(),
  getProduct: vi.fn(),
  getProductMutationTarget: vi.fn(),
  PlatformError: class extends Error {},
}));

const routeUtils = vi.hoisted(() => ({
  actorWithMerchantTargetAccess: vi.fn(),
  actorWithCategoryReadAccess: vi.fn(),
  actorWithOperatingScopeAccess: vi.fn(),
  merchantTargetIdFromHeaders: vi.fn((request) => request.headers["x-merchant-id"] || request.headers["x-operating-merchant-id"] || "merchant_default"),
  query: vi.fn((request) => request.query || {}),
  route: vi.fn(async (_response, handler) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { GET as listProducts } from "../../../../src/api/admin/products/route";
import { GET as listCategories } from "../../../../src/api/admin/product-categories/route";
import { GET as listCustomers } from "../../../../src/api/admin/customers/route";
import { GET as getProduct } from "../../../../src/api/admin/products/[id]/route";

const response = {
  status: vi.fn(() => response),
  json: vi.fn(),
} as never;

const merchantScope = { scopeKind: "merchant_target", merchantId: "merchant_smoke" };

function request(headers: Record<string, string>, query: Record<string, string> = {}) {
  return { headers, query, params: {} } as never;
}

describe("merchant-target list routes resolve non-default operating merchant scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.merchantTargetIdFromHeaders.mockImplementation((req) => req.headers["x-merchant-id"] || req.headers["x-operating-merchant-id"] || "merchant_default");
    routeUtils.actorWithMerchantTargetAccess.mockResolvedValue({ scope: merchantScope });
    routeUtils.actorWithCategoryReadAccess.mockResolvedValue({ scope: merchantScope });
    application.listAdminProducts.mockResolvedValue({ products: [] });
    application.listProductCategories.mockResolvedValue({ product_categories: [] });
    application.listCustomers.mockResolvedValue({ customers: [] });
    application.getProductMutationTarget.mockResolvedValue({ merchantId: "merchant_smoke" });
    routeUtils.actorWithOperatingScopeAccess.mockResolvedValue({ scope: {
      merchantId: "merchant_smoke", storeId: "store_selected", stockLocationId: "location_selected",
    } });
  });

  it("uses x-operating-merchant-id for product, category, and customer list reads when x-merchant-id is absent", async () => {
    const req = request({ "x-operating-merchant-id": "merchant_smoke" }, { limit: "5" });

    await listProducts(req, response);
    await listCategories(req, response);
    await listCustomers(req, response);

    expect(routeUtils.merchantTargetIdFromHeaders).toHaveBeenCalledTimes(3);
    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenNthCalledWith(1, expect.anything(), permissions.catalogRead, "merchant_smoke");
    expect(routeUtils.actorWithCategoryReadAccess).toHaveBeenCalledWith(expect.anything(), "merchant_smoke");
    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenNthCalledWith(2, expect.anything(), permissions.customerRead, "merchant_smoke");
    expect(application.listAdminProducts).toHaveBeenCalledWith({ limit: "5", merchantId: "merchant_smoke", stockLocationId: undefined });
    expect(application.listProductCategories).toHaveBeenCalledWith("merchant_smoke", { limit: "5" });
    expect(application.listCustomers).toHaveBeenCalledWith({ limit: "5", merchantId: "merchant_smoke" });
  });

  it("keeps explicit x-merchant-id authoritative when both merchant headers are present", async () => {
    routeUtils.actorWithMerchantTargetAccess.mockResolvedValueOnce({ scope: { scopeKind: "merchant_target", merchantId: "merchant_explicit" } });

    await listProducts(request({
      "x-merchant-id": "merchant_explicit",
      "x-operating-merchant-id": "merchant_smoke",
    }), response);

    expect(routeUtils.actorWithMerchantTargetAccess).toHaveBeenCalledWith(expect.anything(), permissions.catalogRead, "merchant_explicit");
    expect(application.listAdminProducts).toHaveBeenCalledWith({ merchantId: "merchant_explicit", stockLocationId: undefined });
  });

  it("uses only the verified selected store's stock location for list and detail", async () => {
    const req = request({ "x-operating-merchant-id": "merchant_smoke", "x-operating-store-id": "store_selected" }, { stockLocationId: "untrusted" });
    await listProducts(req, response);
    await getProduct(req, response);
    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(req, permissions.catalogRead);
    expect(application.listAdminProducts).toHaveBeenCalledWith({ merchantId: "merchant_smoke", stockLocationId: "location_selected" });
    expect(application.getProduct).toHaveBeenCalledWith(undefined, { merchantId: "merchant_smoke", stockLocationId: "location_selected" });
  });

  it("rejects a selected store from a different merchant for list and detail", async () => {
    routeUtils.actorWithOperatingScopeAccess.mockResolvedValue({ scope: { merchantId: "merchant_other" } });
    const req = request({ "x-operating-store-id": "store_other" });
    await expect(listProducts(req, response)).rejects.toThrow("forbidden");
    await expect(getProduct(req, response)).rejects.toThrow("forbidden");
    expect(application.listAdminProducts).not.toHaveBeenCalled();
    expect(application.getProduct).not.toHaveBeenCalled();
  });

  it("does not accept a caller-provided stock location without verified operating scope", async () => {
    await listProducts(request({}, { stockLocationId: "untrusted" }), response);
    expect(application.listAdminProducts).toHaveBeenCalledWith({ merchantId: "merchant_smoke", stockLocationId: undefined });
    expect(routeUtils.actorWithOperatingScopeAccess).not.toHaveBeenCalled();
  });
});
