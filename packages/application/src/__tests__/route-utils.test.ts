import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformError } from "../errors/platform-error";
import { permissions } from "@medusa-snus/contracts";

const application = vi.hoisted(() => ({
  authenticateHeaders: vi.fn(),
  authenticateRequestActor: vi.fn(),
  assertNotReadOnlyImpersonation: vi.fn(),
  enforceRateLimit: vi.fn(),
  requireActorPermission: vi.fn(),
  requireActivePlatformMembership: vi.fn(),
  requireMerchantTargetScope: vi.fn(),
  requireMutationScope: vi.fn(),
  requireOperatingReadScope: vi.fn(),
  requirePlatformReadScope: vi.fn(),
  requireReadableReportScope: vi.fn(),
  requireScopedActorPermission: vi.fn(),
  resolveChannelActor: vi.fn(),
  sendPlatformError: vi.fn(),
}));

vi.mock("@medusa-snus/application", async () => ({ ...application, PlatformError: (await import("../errors/platform-error")).PlatformError }));

import {
  actorWithMerchantTargetAccess,
  actorWithCategoryReadAccess,
  actorWithMerchantTargetMutation,
  actorWithOperatingScopeAccess,
  actorWithOperatingScopeMutation,
  actorWithPlatformIntegrationConfigMutation,
  actorWithPlatformMutation,
  actorWithPlatformReadAccess,
  actorWithScopedPlatformPermissionAccess,
  actorWithReportScope,
  csvDownloadRoute,
  merchantTargetIdFromHeaders,
} from "../../../../src/lib/route-utils";

const actor = { operatorId: "op_owner", role: "owner", displayName: "Owner", organizationId: "org_default" };
const request = { headers: { authorization: "Bearer test" } } as never;

describe("explicit scoped route guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    application.authenticateHeaders.mockReturnValue(actor);
    application.authenticateRequestActor.mockResolvedValue(actor);
    application.assertNotReadOnlyImpersonation.mockReturnValue(undefined);
    application.requireMutationScope.mockResolvedValue({ scopeKind: "operating", merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" });
    application.requireOperatingReadScope.mockResolvedValue({ scopeKind: "operating", merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" });
    application.requireMerchantTargetScope.mockResolvedValue({ scopeKind: "merchant_target", merchantId: "merchant_a" });
    application.requirePlatformReadScope.mockResolvedValue({ scopeKind: "platform_read" });
    application.requireReadableReportScope.mockResolvedValue({ scopeKind: "report", merchantId: "merchant_a", storeIds: ["store_a", "store_b"] });
    application.requireActivePlatformMembership.mockResolvedValue({ isPlatformAdmin: true });
  });

  it("requires a typed permission before an operating-scope mutation", async () => {
    await expect(actorWithOperatingScopeMutation(request, permissions.inventoryWrite)).resolves.toMatchObject({
      actor,
      scope: { scopeKind: "operating", storeId: "store_a" },
    });
    expect(application.authenticateRequestActor).toHaveBeenCalledWith(request.headers);
    expect(application.requireActorPermission).toHaveBeenCalledWith(actor, permissions.inventoryWrite);
    expect(application.requireMutationScope).toHaveBeenCalledWith(actor, request.headers);
    expect(application.requireScopedActorPermission).toHaveBeenCalledWith(
      actor,
      permissions.inventoryWrite,
      { scopeType: "store", merchantId: "merchant_a", storeId: "store_a" },
    );
  });

  it("couples operating reads to the resolved store target", async () => {
    await actorWithOperatingScopeAccess(request, permissions.inventoryRead);

    expect(application.requireOperatingReadScope).toHaveBeenCalledWith(actor, request.headers);
    expect(application.requireMutationScope).not.toHaveBeenCalled();
    expect(application.assertNotReadOnlyImpersonation).not.toHaveBeenCalled();
    expect(application.requireScopedActorPermission).toHaveBeenCalledWith(
      actor,
      permissions.inventoryRead,
      { scopeType: "store", merchantId: "merchant_a", storeId: "store_a" },
    );
  });

  it("requires one coupled permission proof for every selected report store", async () => {
    await actorWithReportScope(request, "staff", permissions.reportsRead);

    expect(application.requireScopedActorPermission).toHaveBeenCalledTimes(2);
    expect(application.requireScopedActorPermission).toHaveBeenNthCalledWith(
      1,
      actor,
      permissions.reportsRead,
      { scopeType: "store", merchantId: "merchant_a", storeId: "store_a" },
    );
    expect(application.requireScopedActorPermission).toHaveBeenNthCalledWith(
      2,
      actor,
      permissions.reportsRead,
      { scopeType: "store", merchantId: "merchant_a", storeId: "store_b" },
    );
  });

  it("requires a named merchant target for merchant mutations", async () => {
    await expect(actorWithMerchantTargetMutation(request, permissions.catalogWrite, "merchant_a")).resolves.toMatchObject({
      actor,
      scope: { scopeKind: "merchant_target", merchantId: "merchant_a" },
    });
    expect(application.requireMerchantTargetScope).toHaveBeenCalledWith(actor, "merchant_a");
    expect(application.requireScopedActorPermission).toHaveBeenCalledWith(
      actor,
      permissions.catalogWrite,
      { scopeType: "merchant", merchantId: "merchant_a" },
    );
  });

  it("requires a named merchant target for merchant settings reads", async () => {
    await expect(actorWithMerchantTargetAccess(request, permissions.settingsRead, "merchant_a")).resolves.toMatchObject({
      actor,
      scope: { scopeKind: "merchant_target", merchantId: "merchant_a" },
    });
    expect(application.requireActorPermission).toHaveBeenCalledWith(actor, permissions.settingsRead);
    expect(application.requireMerchantTargetScope).toHaveBeenCalledWith(actor, "merchant_a");
    expect(application.requireScopedActorPermission).toHaveBeenCalledWith(
      actor,
      permissions.settingsRead,
      { scopeType: "merchant", merchantId: "merchant_a" },
    );
  });

  it("authorizes category defaults through the exact merchant proof", async () => {
    await actorWithCategoryReadAccess(request, "merchant_a");
    expect(application.requireScopedActorPermission).toHaveBeenCalledExactlyOnceWith(actor, permissions.categoryRead, { scopeType: "merchant", merchantId: "merchant_a" });
  });

  it.each(["permission", "scope"])("preserves catalog readers after category %s denial", async (stage) => {
    const check = stage === "permission" ? application.requireActorPermission : application.requireScopedActorPermission;
    check.mockRejectedValueOnce(new PlatformError("forbidden", "Missing category proof", 403));
    await expect(actorWithCategoryReadAccess(request, "merchant_a")).resolves.toMatchObject({ scope: { merchantId: "merchant_a" } });
    expect(application.requireScopedActorPermission).toHaveBeenLastCalledWith(actor, permissions.catalogRead, { scopeType: "merchant", merchantId: "merchant_a" });
  });

  it.each(["unauthorized", "password_change_required", "membership_required", "rate_limited", "internal_error"])("does not retry category %s failures as catalog reads", async (code) => {
    const error = new PlatformError(code, "Category check failed", code === "unauthorized" ? 401 : 403);
    application.requireActorPermission.mockRejectedValueOnce(error);
    await expect(actorWithCategoryReadAccess(request, "merchant_a")).rejects.toBe(error);
    expect(application.requireActorPermission).toHaveBeenCalledTimes(1);
  });

  it("propagates unexpected category infrastructure failures without retry", async () => {
    const error = new Error("Database unavailable");
    application.requireActorPermission.mockRejectedValueOnce(error);
    await expect(actorWithCategoryReadAccess(request, "merchant_a")).rejects.toBe(error);
    expect(application.requireActorPermission).toHaveBeenCalledTimes(1);
  });

  it("uses only the platform-read helper for platform read access", async () => {
    await expect(actorWithPlatformReadAccess(request)).resolves.toMatchObject({
      actor,
      scope: { scopeKind: "platform_read" },
    });
    expect(application.requireActorPermission).toHaveBeenCalledWith(actor, permissions.platformRead);
    expect(application.requirePlatformReadScope).toHaveBeenCalledWith(actor, request.headers);
    expect(application.requireScopedActorPermission).toHaveBeenCalledWith(
      actor,
      permissions.platformRead,
      { scopeType: "platform" },
    );
  });

  it("allows one platform-scoped read capability without requiring platform:read", async () => {
    await expect(actorWithScopedPlatformPermissionAccess(
      request,
      permissions.platformOperatorRead,
    )).resolves.toEqual({ actor });

    expect(application.requireScopedActorPermission).toHaveBeenCalledWith(
      actor,
      permissions.platformOperatorRead,
      { scopeType: "platform" },
    );
    expect(application.requirePlatformReadScope).not.toHaveBeenCalled();
    expect(application.assertNotReadOnlyImpersonation).not.toHaveBeenCalled();
  });

  it("requires integration config write permission and active platform membership for config mutation", async () => {
    await expect(actorWithPlatformIntegrationConfigMutation(request)).resolves.toEqual({ actor });
    expect(application.requireActorPermission).toHaveBeenCalledWith(actor, permissions.integrationConfigWrite);
    expect(application.requireActivePlatformMembership).toHaveBeenCalledWith(actor);
    expect(application.requirePlatformReadScope).not.toHaveBeenCalled();
  });

  it("requires platform write permission and active platform membership for platform mutations", async () => {
    await expect(actorWithPlatformMutation(request)).resolves.toEqual({ actor });
    expect(application.requireActorPermission).toHaveBeenCalledWith(actor, permissions.platformWrite);
    expect(application.requireActivePlatformMembership).toHaveBeenCalledWith(actor);
    expect(application.requirePlatformReadScope).not.toHaveBeenCalled();
  });

  it("blocks canonical mutations during read-only impersonation", async () => {
    application.assertNotReadOnlyImpersonation.mockImplementationOnce(() => {
      throw Object.assign(new Error("read only"), { code: "impersonation_read_only" });
    });

    await expect(actorWithPlatformMutation(request)).rejects.toMatchObject({ code: "impersonation_read_only" });
    expect(application.requireActivePlatformMembership).not.toHaveBeenCalled();
  });

  it("stops before membership resolution when platform write permission is missing", async () => {
    application.requireActorPermission.mockRejectedValueOnce(new Error("missing platform write permission"));

    await expect(actorWithPlatformMutation(request)).rejects.toThrow("missing platform write permission");
    expect(application.requireActivePlatformMembership).not.toHaveBeenCalled();
  });

  it("stops before membership resolution when integration config write permission is missing", async () => {
    application.requireActorPermission.mockRejectedValueOnce(new Error("missing write permission"));

    await expect(actorWithPlatformIntegrationConfigMutation(request)).rejects.toThrow("missing write permission");
    expect(application.requireActivePlatformMembership).not.toHaveBeenCalled();
  });

  it("sends CSV downloads with attachment and no-store headers", async () => {
    const response = {
      status: vi.fn(),
      json: vi.fn(),
      setHeader: vi.fn(),
      send: vi.fn(),
    };
    response.status.mockReturnValue(response);

    await csvDownloadRoute(response, "products export.csv", () => "title\r\nMint\r\n");

    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "text/csv; charset=utf-8");
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'attachment; filename="products_export.csv"',
    );
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith("title\r\nMint\r\n");
  });

  it("resolves merchant target from explicit merchant, then operating merchant, then legacy default", () => {
    expect(merchantTargetIdFromHeaders({
      headers: {
        "x-merchant-id": "merchant_explicit",
        "x-operating-merchant-id": "merchant_operating",
      },
    } as never)).toBe("merchant_explicit");

    expect(merchantTargetIdFromHeaders({
      headers: {
        "x-operating-merchant-id": "merchant_operating",
      },
    } as never)).toBe("merchant_operating");

    expect(merchantTargetIdFromHeaders({
      headers: {},
    } as never)).toBe("merchant_default");
  });

  it("trims merchant target headers and handles array header values", () => {
    expect(merchantTargetIdFromHeaders({
      headers: {
        "x-operating-merchant-id": [" merchant_from_array ", "ignored"],
      },
    } as never)).toBe("merchant_from_array");
  });
});
