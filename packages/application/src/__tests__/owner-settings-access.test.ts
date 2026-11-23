import { describe, expect, it } from "vitest";
import type { RequestAccess } from "@medusa-snus/contracts";
import { permissions } from "@medusa-snus/contracts";
import {
  fallbackRolePermissions,
  requireActorAccessPermission,
  requireMerchantTargetScope,
} from "../services/access-service";

function merchantAccess(permissionIds: RequestAccess["permissionIds"]): RequestAccess {
  return {
    actorId: "op_manager",
    isPlatformAdmin: false,
    legacyOrganizationId: "org_a",
    memberships: [{
      membershipId: "membership_a",
      operatorId: "op_manager",
      scopeType: "merchant",
      merchantId: "merchant_a",
      storeId: null,
      roleKey: "manager",
      status: "active",
      permissionIds,
    }],
    explicitPermissions: [],
    permissionIds,
  };
}

describe("owner settings permission policy", () => {
  it("grants settings permissions to owners only by default", () => {
    expect(fallbackRolePermissions.owner).toEqual(expect.arrayContaining([permissions.settingsRead, permissions.settingsWrite]));
    expect(fallbackRolePermissions.manager).not.toContain(permissions.settingsRead);
    expect(fallbackRolePermissions.manager).not.toContain(permissions.settingsWrite);
    expect(fallbackRolePermissions.accountant).not.toContain(permissions.settingsRead);
    expect(fallbackRolePermissions.accountant).not.toContain(permissions.settingsWrite);
    expect(fallbackRolePermissions.staff).not.toContain(permissions.settingsRead);
    expect(fallbackRolePermissions.staff).not.toContain(permissions.settingsWrite);
  });

  it("allows a manager only when settings permissions are explicitly present", async () => {
    const access = merchantAccess([permissions.settingsRead, permissions.settingsWrite]);
    const actor = { operatorId: "op_manager", role: "manager" as const, organizationId: "org_a", access };

    await expect(requireActorAccessPermission(actor, permissions.settingsWrite)).resolves.toBeUndefined();
    expect(requireMerchantTargetScope(access, "merchant_a")).toEqual({
      scopeKind: "merchant_target",
      merchantId: "merchant_a",
    });
    expect(() => requireMerchantTargetScope(access, "merchant_b")).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  it("denies a platform-read-only actor settings mutation permission", async () => {
    const access: RequestAccess = {
      actorId: "op_platform",
      isPlatformAdmin: true,
      legacyOrganizationId: "org_platform",
      memberships: [{
        membershipId: "membership_platform",
        operatorId: "op_platform",
        scopeType: "platform",
        merchantId: null,
        storeId: null,
        roleKey: null,
        platformRoleKey: "platform_admin",
        status: "active",
        permissionIds: [permissions.platformRead],
      }],
      explicitPermissions: [],
      permissionIds: [permissions.platformRead],
    };
    const actor = { operatorId: "op_platform", role: "staff" as const, organizationId: "org_platform", access };

    await expect(requireActorAccessPermission(actor, permissions.settingsWrite)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("requires integration read permission and the exact merchant target", async () => {
    const access = merchantAccess([permissions.integrationConfigRead]);
    const actor = { operatorId: "op_manager", role: "manager" as const, organizationId: "org_a", access };

    await expect(requireActorAccessPermission(actor, permissions.integrationConfigRead)).resolves.toBeUndefined();
    expect(requireMerchantTargetScope(access, "merchant_a")).toEqual({
      scopeKind: "merchant_target",
      merchantId: "merchant_a",
    });
    expect(() => requireMerchantTargetScope(access, "merchant_b")).toThrow(expect.objectContaining({ code: "forbidden" }));

    const denied = { ...actor, access: merchantAccess([]) };
    await expect(requireActorAccessPermission(denied, permissions.integrationConfigRead)).rejects.toMatchObject({ code: "forbidden" });
  });
});
