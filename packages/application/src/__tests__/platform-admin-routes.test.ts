import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  createPlatformStore: vi.fn(),
  getPlatformMerchantDetail: vi.fn(),
  readMerchantCheckoutPolicy: vi.fn(),
  updateMerchantCheckoutPolicy: vi.fn(),
  getPlatformStoreDetail: vi.fn(),
  grantPlatformMembership: vi.fn(),
  listPlatformAudit: vi.fn(),
  listPlatformBillingOrders: vi.fn(),
  listPlatformIntegrations: vi.fn(),
  listPlatformMemberships: vi.fn(),
  listPlatformMerchants: vi.fn(),
  listPlatformOperators: vi.fn(),
  listPlatformPaymentExceptions: vi.fn(),
  listPlatformSignupIdentities: vi.fn(),
  listPlatformStores: vi.fn(),
  mutatePlatformIntegrationConfig: vi.fn(),
  revokePlatformMembership: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  actorWithPlatformIntegrationConfigMutation: vi.fn(),
  actorWithPlatformMutation: vi.fn(),
  actorWithPlatformReadAccess: vi.fn(),
  actorWithScopedPlatformPermissionAccess: vi.fn(),
  body: vi.fn(),
  query: vi.fn(),
  route: vi.fn(async (_response, handler) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { GET as readPolicy, PATCH as writePolicy } from "../../../../src/api/platform/admin/merchants/[merchantId]/checkout-policy/route";
import { GET as getMerchants } from "../../../../src/api/platform/admin/merchants/route";
import { GET as getMerchant } from "../../../../src/api/platform/admin/merchants/[merchantId]/route";
import { GET as getStores } from "../../../../src/api/platform/admin/stores/route";
import { POST as createStore } from "../../../../src/api/platform/admin/stores/route";
import { GET as getStore } from "../../../../src/api/platform/admin/stores/[storeId]/route";
import { GET as getMemberships, POST as grantMembership } from "../../../../src/api/platform/admin/memberships/route";
import { POST as revokeMembership } from "../../../../src/api/platform/admin/memberships/[membershipId]/revoke/route";
import { GET as getBillingOrders } from "../../../../src/api/platform/admin/billing-orders/route";
import { GET as getIntegrations } from "../../../../src/api/platform/admin/integrations/route";
import { POST as mutateIntegration } from "../../../../src/api/platform/admin/integrations/config/route";
import { GET as getPaymentExceptions } from "../../../../src/api/platform/admin/payment-exceptions/route";
import { GET as getSignupIdentities } from "../../../../src/api/platform/admin/signup-identities/route";
import { GET as getAudit } from "../../../../src/api/platform/admin/audit/route";
import { GET as getOperators } from "../../../../src/api/platform/admin/operators/route";

const actor = { operatorId: "op_platform", role: "owner", displayName: "Platform", organizationId: "org_platform" };
const platformScope = { scopeKind: "platform_read", merchantIds: ["merchant_a", "merchant_b"], storeIds: ["store_a", "store_b"] };
const response = { status: vi.fn(() => response), json: vi.fn() } as never;

function request(input: { body?: Record<string, unknown>; params?: Record<string, string>; query?: Record<string, string> } = {}) {
  return { headers: {}, body: input.body || {}, params: input.params || {}, query: input.query || {} } as never;
}

function writeOnlyTestValue(): string {
  return randomBytes(24).toString("base64url");
}

describe("platform admin routes use platform-only authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUtils.body.mockImplementation((req) => req.body);
    routeUtils.query.mockImplementation((req) => req.query);
    routeUtils.actorWithPlatformReadAccess.mockResolvedValue({ actor, scope: platformScope });
    routeUtils.actorWithScopedPlatformPermissionAccess.mockResolvedValue({ actor });
    routeUtils.actorWithPlatformIntegrationConfigMutation.mockResolvedValue({ actor });
    routeUtils.actorWithPlatformMutation.mockResolvedValue({ actor });
    for (const service of Object.values(application)) service.mockResolvedValue({ data: [] });
    application.mutatePlatformIntegrationConfig.mockResolvedValue({ data: { configId: "cfg_1", status: "active" } });
  });

  it("guards merchant checkout policy read/write separately and passes the selected merchant", async () => {
    const req = request({ params: { merchantId: "merchant_b" }, body: { enabled: false, expectedVersion: 0 } });
    await readPolicy(req, response);
    expect(application.readMerchantCheckoutPolicy).toHaveBeenCalledWith(platformScope, "merchant_b");
    await writePolicy(req, response);
    expect(routeUtils.actorWithPlatformMutation).toHaveBeenCalledWith(req);
    expect(application.updateMerchantCheckoutPolicy).toHaveBeenCalledWith("merchant_b", req.body, actor);
    routeUtils.actorWithPlatformMutation.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { code: "forbidden" }));
    await expect(writePolicy(req, response)).rejects.toMatchObject({ code: "forbidden" });
    expect(application.updateMerchantCheckoutPolicy).toHaveBeenCalledTimes(1);
  });

  it("uses broad platform:read for console reads and the narrow explicit capability for operators", async () => {
    await getMerchants(request(), response);
    await getMerchant(request({ params: { merchantId: "merchant_a" } }), response);
    await getStores(request({ query: { merchantId: "merchant_a" } }), response);
    await getStore(request({ params: { storeId: "store_a" } }), response);
    await getMemberships(request(), response);
    await getBillingOrders(request(), response);
    await getIntegrations(request(), response);
    await getPaymentExceptions(request(), response);
    await getSignupIdentities(request(), response);
    await getAudit(request(), response);
    await getOperators(request(), response);

    expect(routeUtils.actorWithPlatformReadAccess).toHaveBeenCalledTimes(10);
    expect(routeUtils.actorWithScopedPlatformPermissionAccess).toHaveBeenCalledWith(
      expect.anything(),
      permissions.platformOperatorRead,
    );
    expect(application.listPlatformOperators).toHaveBeenCalledTimes(1);
    expect(application.listPlatformStores).toHaveBeenCalledWith(platformScope, "merchant_a", undefined);
    expect(application.getPlatformMerchantDetail).toHaveBeenCalledWith(platformScope, "merchant_a", 0);
    expect(application.getPlatformStoreDetail).toHaveBeenCalledWith(platformScope, "store_a", 0);
  });

  it("guards store and membership mutations with platform:write", async () => {
    const storeInput = { merchantId: "merchant_a", displayName: "Store Two", isPrimary: false };
    const membershipInput = {
      operatorId: "op_manager",
      scopeType: "store",
      merchantId: "merchant_a",
      storeId: "store_a",
      roleKey: "manager",
    };
    const revokeInput = { reason: "Access no longer required" };

    await createStore(request({ body: storeInput }), response);
    await grantMembership(request({ body: membershipInput }), response);
    await revokeMembership(request({
      params: { membershipId: "10000000-0000-4000-8000-000000000001" },
      body: revokeInput,
    }), response);

    expect(routeUtils.actorWithPlatformMutation).toHaveBeenCalledTimes(3);
    expect(application.createPlatformStore).toHaveBeenCalledWith(storeInput, actor);
    expect(application.grantPlatformMembership).toHaveBeenCalledWith(membershipInput, actor);
    expect(application.revokePlatformMembership).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      actor,
      revokeInput,
    );
    expect(routeUtils.actorWithPlatformReadAccess).not.toHaveBeenCalled();
  });

  it("denies platform mutations before their services when platform:write is missing", async () => {
    routeUtils.actorWithPlatformMutation.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { code: "forbidden" }),
    );

    await expect(createStore(request({ body: {
      merchantId: "merchant_a",
      displayName: "Blocked Store",
    } }), response)).rejects.toMatchObject({ code: "forbidden" });

    expect(application.createPlatformStore).not.toHaveBeenCalled();
  });

  it.each(["merchant owner without platform membership", "platform read-only actor", "actor missing integration_config:write"])(
    "denies %s before the config mutation service",
    async () => {
      routeUtils.actorWithPlatformIntegrationConfigMutation.mockRejectedValueOnce(
        Object.assign(new Error("forbidden"), { code: "forbidden" }),
      );

      await expect(mutateIntegration(request({ body: {
        action: "set",
        providerKey: "nowpayments",
        purpose: "platform_billing",
        scope: "platform",
        secret: writeOnlyTestValue(),
      } }), response)).rejects.toMatchObject({ code: "forbidden" });

      expect(application.mutatePlatformIntegrationConfig).not.toHaveBeenCalled();
    },
  );

  it("passes a purpose-bound and target-bound write to the config service", async () => {
    const input = {
      action: "rotate",
      providerKey: "nowpayments",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: "merchant_a",
      secret: writeOnlyTestValue(),
    };

    await mutateIntegration(request({ body: input }), response);

    expect(routeUtils.actorWithPlatformIntegrationConfigMutation).toHaveBeenCalledTimes(1);
    expect(application.mutatePlatformIntegrationConfig).toHaveBeenCalledWith(input, actor);
    expect(routeUtils.actorWithPlatformReadAccess).not.toHaveBeenCalled();
  });

  it("passes an explicit store target without deriving mutation authority from platform read scope", async () => {
    const input = {
      action: "set",
      providerKey: "sepay_va",
      purpose: "retail_order",
      scope: "store",
      merchantId: "merchant_a",
      storeId: "store_a",
      secret: writeOnlyTestValue(),
    };

    await mutateIntegration(request({ body: input }), response);

    expect(application.mutatePlatformIntegrationConfig).toHaveBeenCalledWith(input, actor);
    expect(routeUtils.actorWithPlatformReadAccess).not.toHaveBeenCalled();
  });
});
