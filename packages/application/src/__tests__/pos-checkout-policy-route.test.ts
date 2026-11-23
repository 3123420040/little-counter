import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  PlatformError: class PlatformError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  },
  readCheckoutSettlementPolicy: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  actorWithOperatingScopeAccess: vi.fn(),
  route: vi.fn(async (_response, handler) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { GET as getCheckoutPolicy } from "../../../../src/api/pos/checkout-policy/route";

const scope = { scopeKind: "operating", merchantId: "merchant_a", storeId: "store_a" };
const response = {
  status: vi.fn(() => response),
  json: vi.fn(),
} as never;

function request() {
  return { headers: {}, body: {}, params: {} } as never;
}

describe("POS checkout policy route (T01/PAY01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.actorWithOperatingScopeAccess.mockResolvedValue({ actor: { operatorId: "op_cashier" }, scope });
    application.readCheckoutSettlementPolicy.mockResolvedValue({
      data: {
        merchantId: "merchant_a",
        storeId: "store_a",
        mode: "manual_confirmation",
        policyVersion: 0,
        acknowledgmentVersion: 1,
        source: "default",
      },
    });
  });

  it("guards the read with the checkout capability, not settings permission", async () => {
    await getCheckoutPolicy(request(), response);

    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledWith(
      expect.anything(),
      permissions.remoteOrderCreate,
    );
    expect(routeUtils.actorWithOperatingScopeAccess).toHaveBeenCalledTimes(1);
  });

  it("resolves the policy from the operating merchant/store scope", async () => {
    await getCheckoutPolicy(request(), response);

    expect(application.readCheckoutSettlementPolicy).toHaveBeenCalledTimes(1);
    expect(application.readCheckoutSettlementPolicy).toHaveBeenCalledWith("merchant_a", "store_a");
  });

  it("surfaces guard rejection instead of reading the policy unauthenticated", async () => {
    routeUtils.actorWithOperatingScopeAccess.mockRejectedValue(
      new application.PlatformError("forbidden", "Actor lacks checkout capability", 403),
    );

    await expect(getCheckoutPolicy(request(), response)).rejects.toMatchObject({ code: "forbidden" });
    expect(application.readCheckoutSettlementPolicy).not.toHaveBeenCalled();
  });
});
