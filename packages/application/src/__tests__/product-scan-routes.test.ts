import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  getProductTagViewModel: vi.fn(),
  resolveProductScan: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  actorWithOperatingScopeAccess: vi.fn(),
  actorWithOperatingScopeMutation: vi.fn(),
  body: vi.fn((request) => request.body || {}),
  route: vi.fn(async (_response, handler: () => Promise<unknown>) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { POST as resolveScan } from "../../../../src/api/pos/scan/resolve/route";
import { GET as getProductTag } from "../../../../src/api/platform/admin/products/[id]/tag/route";

const actor = { operatorId: "op_staff", role: "staff", displayName: "Staff", organizationId: "org_a" };
const scope = { scopeKind: "operating", merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" };
const response = { status: vi.fn(), json: vi.fn() } as never;

function request(body: Record<string, unknown>) {
  return { headers: {}, body, params: {}, query: {} } as never;
}

function requestWithParams(params: Record<string, string>) {
  return { headers: {}, body: {}, params, query: {} } as never;
}

describe("product scan resolver route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.actorWithOperatingScopeAccess.mockResolvedValue({ actor, scope });
    routeUtils.actorWithOperatingScopeMutation.mockResolvedValue({ actor, scope });
    application.resolveProductScan.mockResolvedValue({ data: { productId: "prod_1" } });
    application.getProductTagViewModel.mockResolvedValue({ data: { productId: "prod_1" } });
  });

  it("uses catalog:read for POS add-to-cart scan context", async () => {
    const payload = { code: "https://snus.example/scan/qr_1", context: "pos_add_to_cart" };

    await resolveScan(request(payload), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.catalogRead);
    expect(application.resolveProductScan).toHaveBeenCalledWith(payload, scope, {
      operatorId: "op_staff",
      type: "staff",
      role: "staff",
    });
  });

  it("uses inventory:read for inventory check scan context", async () => {
    const payload = { code: "SKU-1", context: "inventory_check" };

    await resolveScan(request(payload), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.inventoryRead);
    expect(application.resolveProductScan).toHaveBeenCalledWith(payload, scope, expect.objectContaining({ operatorId: "op_staff" }));
  });

  it("uses catalog:read and operating scope for product tag view data", async () => {
    await getProductTag(requestWithParams({ id: "prod_1" }), response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(expect.anything(), permissions.catalogRead);
    expect(application.getProductTagViewModel).toHaveBeenCalledWith({ productId: "prod_1", scope });
  });
});
