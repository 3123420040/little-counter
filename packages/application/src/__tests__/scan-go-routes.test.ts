import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  createScanGoCart: vi.fn(),
  createScanGoCheckoutToken: vi.fn(),
  redeemScanGoCartForStaff: vi.fn(),
  resolvePublicScanGoProduct: vi.fn(),
  resolveScanGoCartForStaff: vi.fn(),
  updateScanGoCart: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  actorWithOperatingScopeAccess: vi.fn(),
  actorWithOperatingScopeMutation: vi.fn(),
  body: vi.fn((request) => request.body || {}),
  rateLimit: vi.fn(),
  route: vi.fn(async (_response, handler: () => Promise<unknown>, _status?: number) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { GET as getPublicProduct } from "../../../../src/api/public/scan-go/products/[merchantSlug]/[storeSlug]/[qrSlug]/route";
import { POST as createCart } from "../../../../src/api/public/scan-go/carts/route";
import { PATCH as updateCart } from "../../../../src/api/public/scan-go/carts/[cartId]/route";
import { POST as createCheckoutToken } from "../../../../src/api/public/scan-go/carts/[cartId]/checkout-token/route";
import { POST as resolveStaffCart } from "../../../../src/api/pos/scan-go/resolve-cart/route";
import { POST as redeemStaffCart } from "../../../../src/api/pos/scan-go/redeem-cart/route";

const actor = { operatorId: "op_staff", role: "staff", displayName: "Staff", organizationId: "org_a" };
const scope = { scopeKind: "operating", merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" };
const response = { status: vi.fn(), json: vi.fn() } as never;

function request(options: { params?: Record<string, string>; body?: Record<string, unknown> } = {}) {
  return { headers: {}, query: {}, params: options.params || {}, body: options.body || {} } as never;
}

describe("Scan & Go routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.actorWithOperatingScopeAccess.mockResolvedValue({ actor, scope });
    routeUtils.actorWithOperatingScopeMutation.mockResolvedValue({ actor, scope });
    for (const service of Object.values(application)) service.mockResolvedValue({ data: {} });
  });

  it("resolves public product QR route without staff auth", async () => {
    await getPublicProduct(request({ params: { merchantSlug: "default", storeSlug: "main", qrSlug: "ice-160" } }), response);

    expect(routeUtils.rateLimit).toHaveBeenCalledWith(expect.anything(), "default");
    expect(routeUtils.actorWithOperatingScopeAccess).not.toHaveBeenCalled();
    expect(application.resolvePublicScanGoProduct).toHaveBeenCalledWith({
      merchantSlug: "default",
      storeSlug: "main",
      qrSlug: "ice-160",
    });
  });

  it("creates and updates public Scan & Go carts through checkout rate limit", async () => {
    const cartBody = { merchantSlug: "default", storeSlug: "main", lines: [{ productId: "prod_1", variantId: "var_1", quantity: 1 }] };

    await createCart(request({ body: cartBody }), response);
    await updateCart(request({ params: { cartId: "sgc_1" }, body: { editSecret: "sge_1", customerNickname: "Tommy" } }), response);
    await createCheckoutToken(request({ params: { cartId: "sgc_1" }, body: { editSecret: "sge_1" } }), response);

    expect(routeUtils.rateLimit).toHaveBeenCalledWith(expect.anything(), "checkout");
    expect(application.createScanGoCart).toHaveBeenCalledWith(cartBody);
    expect(application.updateScanGoCart).toHaveBeenCalledWith("sgc_1", { editSecret: "sge_1", customerNickname: "Tommy" });
    expect(application.createScanGoCheckoutToken).toHaveBeenCalledWith("sgc_1", { editSecret: "sge_1" });
  });

  it("uses scan_go:redeem permission for staff preview and redeem", async () => {
    const payload = { tokenOrPayload: "sgt_deadbeef" };

    await resolveStaffCart(request({ body: payload }), response);
    await redeemStaffCart(request({ body: payload }), response);

    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledTimes(2);
    expect(routeUtils.actorWithOperatingScopeMutation).toHaveBeenCalledWith(expect.anything(), permissions.scanGoRedeem, "checkout");
    expect(application.resolveScanGoCartForStaff).toHaveBeenCalledWith(payload, scope, actor);
    expect(application.redeemScanGoCartForStaff).toHaveBeenCalledWith(payload, scope, actor);
  });
});
