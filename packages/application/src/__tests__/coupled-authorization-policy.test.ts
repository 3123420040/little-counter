import { describe, expect, it } from "vitest";
import { permissions, type RequestAccess } from "@medusa-snus/contracts";
import {
  decideScopeCoupledAuthorization,
  requireScopeCoupledAuthorization,
} from "../services/coupled-authorization-policy";
import { requireScopedActorPermission } from "../services/permission-service";

const now = new Date("2026-09-01T06:00:00.000Z");

function access(): RequestAccess {
  return {
    actorId: "operator_multi",
    isPlatformAdmin: true,
    legacyOrganizationId: "org_a",
    permissionIds: [permissions.catalogWrite, permissions.customerWrite, permissions.platformRead],
    explicitPermissions: [],
    memberships: [
      {
        membershipId: "manager_store_a",
        operatorId: "operator_multi",
        scopeType: "store",
        merchantId: "merchant_a",
        storeId: "store_a",
        roleKey: "manager",
        status: "active",
        permissionIds: [permissions.catalogWrite, permissions.customerWrite],
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: null,
      },
      {
        membershipId: "staff_store_b",
        operatorId: "operator_multi",
        scopeType: "store",
        merchantId: "merchant_a",
        storeId: "store_b",
        roleKey: "staff",
        status: "active",
        permissionIds: [permissions.customerWrite],
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: null,
      },
      {
        membershipId: "platform_read",
        operatorId: "operator_multi",
        scopeType: "platform",
        merchantId: null,
        storeId: null,
        roleKey: null,
        platformRoleKey: "platform_readonly",
        status: "active",
        permissionIds: [permissions.platformRead],
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: null,
      },
    ],
  } as RequestAccess;
}

describe("AUTH-02..07 pure scope-coupled authorization", () => {
  it.each([permissions.customerRead, permissions.customerWrite, permissions.categoryRead])(
    "allows %s at the assigned merchant from a store proof only",
    (permissionId) => {
      const requestAccess = access();
      requestAccess.memberships = [
        {
          ...requestAccess.memberships[1]!,
          permissionIds: [permissionId, permissions.catalogRead, permissions.catalogWrite],
        },
      ];
      const target = {
        scopeType: "merchant" as const,
        merchantId: "merchant_a",
      };
      expect(
        decideScopeCoupledAuthorization(
          requestAccess,
          permissionId,
          target,
          now,
        ),
      ).toMatchObject({
        allowed: true,
        proof: { sourceId: "staff_store_b", scopeType: "store" },
      });
      expect(
        decideScopeCoupledAuthorization(
          requestAccess,
          permissionId,
          {
            scopeType: "merchant",
            merchantId: "merchant_other",
          },
          now,
        ).allowed,
      ).toBe(false);
      expect(
        decideScopeCoupledAuthorization(
          requestAccess,
          permissions.catalogWrite,
          target,
          now,
        ).allowed,
      ).toBe(false);
      expect(
        decideScopeCoupledAuthorization(
          requestAccess,
          permissionId,
          {
            scopeType: "store",
            merchantId: "merchant_a",
            storeId: "store_a",
          },
          now,
        ).allowed,
      ).toBe(false);
      expect(decideScopeCoupledAuthorization(requestAccess, permissions.catalogRead, target, now).allowed).toBe(false);
      requestAccess.memberships[0]!.storeId = null;
      expect(
        decideScopeCoupledAuthorization(
          requestAccess,
          permissionId,
          target,
          now,
        ).allowed,
      ).toBe(false);
    },
  );

  it.each([
    "revoked",
    "expired",
    "future",
    "malformed",
    "platform",
    "missing_permission",
  ])("rejects %s customer merchant proofs", (invalid) => {
    const requestAccess = access();
    requestAccess.memberships = [{ ...requestAccess.memberships[1]! }];
    const membership = requestAccess.memberships[0]!;
    if (invalid === "revoked") membership.status = "revoked";
    if (invalid === "expired") membership.validTo = now.toISOString();
    if (invalid === "future") membership.validFrom = "2026-09-02T00:00:00.000Z";
    if (invalid === "malformed") membership.validFrom = "not-a-date";
    if (invalid === "platform") membership.scopeType = "platform";
    if (invalid === "missing_permission")
      membership.permissionIds = [permissions.customerRead];
    expect(
      decideScopeCoupledAuthorization(
        requestAccess,
        permissions.customerWrite,
        {
          scopeType: "merchant",
          merchantId: "merchant_a",
        },
        now,
      ).allowed,
    ).toBe(false);
  });

  it("keeps explicit customer grants store-scoped and prefers a merchant membership proof", () => {
    const requestAccess = access();
    requestAccess.memberships = [];
    requestAccess.explicitPermissions = [
      {
        grantId: "customer_store_b",
        operatorId: requestAccess.actorId,
        permissionId: permissions.customerWrite,
        scopeType: "store",
        merchantId: "merchant_a",
        storeId: "store_b",
        grantedBy: "owner_a",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: null,
      },
    ];
    const target = { scopeType: "merchant" as const, merchantId: "merchant_a" };
    expect(
      decideScopeCoupledAuthorization(
        requestAccess,
        permissions.customerWrite,
        target,
        now,
      ).allowed,
    ).toBe(false);
    requestAccess.memberships = [
      access().memberships[1]!,
      {
        ...access().memberships[0]!,
        scopeType: "merchant",
        storeId: null,
      },
    ];
    expect(
      decideScopeCoupledAuthorization(
        requestAccess,
        permissions.customerWrite,
        target,
        now,
      ),
    ).toMatchObject({
      proof: { sourceType: "membership", scopeType: "merchant" },
    });
  });

  it.each(["revoked", "expired", "future", "malformed", "platform", "missing_permission"])("rejects %s category merchant proofs", (invalid) => {
    const permissionId = permissions.categoryRead;
    const requestAccess = access();
    requestAccess.memberships = [{ ...requestAccess.memberships[1]!, permissionIds: [permissionId] }];
    const membership = requestAccess.memberships[0]!;
    if (invalid === "revoked") membership.status = "revoked";
    if (invalid === "expired") membership.validTo = now.toISOString();
    if (invalid === "future") membership.validFrom = "2026-09-02T00:00:00.000Z";
    if (invalid === "malformed") membership.validFrom = "not-a-date";
    if (invalid === "platform") membership.scopeType = "platform";
    if (invalid === "missing_permission") membership.permissionIds = [permissions.catalogRead];
    expect(decideScopeCoupledAuthorization(requestAccess, permissionId, { scopeType: "merchant", merchantId: "merchant_a" }, now).allowed).toBe(false);
  });

  it("keeps explicit category grants store-scoped", () => {
    const requestAccess = access();
    requestAccess.memberships = [];
    requestAccess.explicitPermissions = [{ grantId: "category_store", operatorId: requestAccess.actorId, permissionId: permissions.categoryRead, scopeType: "store", merchantId: "merchant_a", storeId: "store_b", grantedBy: "owner_a", validFrom: "2026-01-01T00:00:00.000Z", validTo: null }];
    expect(decideScopeCoupledAuthorization(requestAccess, permissions.categoryRead, { scopeType: "merchant", merchantId: "merchant_a" }, now).allowed).toBe(false);
  });

  it("binds a permission to the same exact store membership", () => {
    expect(decideScopeCoupledAuthorization(access(), permissions.catalogWrite, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_a",
    }, now)).toMatchObject({ allowed: true, proof: { sourceId: "manager_store_a" } });
    expect(decideScopeCoupledAuthorization(access(), permissions.catalogWrite, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_b",
    }, now)).toMatchObject({ allowed: false, proof: null });
    expect(decideScopeCoupledAuthorization(access(), permissions.customerWrite, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_b",
    }, now)).toMatchObject({ allowed: true, proof: { sourceId: "staff_store_b" } });
  });

  it("never combines platform visibility or top-level permission union with a business target", () => {
    const requestAccess = access();
    expect(requestAccess.permissionIds).toContain(permissions.catalogWrite);
    expect(decideScopeCoupledAuthorization(requestAccess, permissions.catalogWrite, {
      scopeType: "store", merchantId: "merchant_b", storeId: "store_b1",
    }, now).allowed).toBe(false);
    expect(decideScopeCoupledAuthorization(requestAccess, permissions.platformRead, {
      scopeType: "platform",
    }, now).allowed).toBe(true);
  });

  it("prefers an exact store proof over a merchant-wide proof deterministically", () => {
    const requestAccess = access();
    requestAccess.memberships.unshift({
      ...requestAccess.memberships[0]!,
      membershipId: "manager_merchant_a",
      scopeType: "merchant",
      storeId: null,
    });
    expect(decideScopeCoupledAuthorization(requestAccess, permissions.catalogWrite, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_a",
    }, now)).toMatchObject({ proof: { sourceId: "manager_store_a", scopeType: "store" } });
    expect(decideScopeCoupledAuthorization(requestAccess, permissions.catalogWrite, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_c",
    }, now)).toMatchObject({ proof: { sourceId: "manager_merchant_a", scopeType: "merchant" } });
  });

  it("rejects revoked, expired, future and malformed validity windows", () => {
    const requestAccess = access();
    const membership = requestAccess.memberships[0]! as typeof requestAccess.memberships[number] & {
      validFrom?: string;
      validTo?: string | null;
    };
    membership.status = "revoked";
    expect(decideScopeCoupledAuthorization(requestAccess, permissions.catalogWrite, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_a",
    }, now).allowed).toBe(false);
    membership.status = "active";
    membership.validTo = "2026-08-31T00:00:00.000Z";
    expect(decideScopeCoupledAuthorization(requestAccess, permissions.catalogWrite, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_a",
    }, now).allowed).toBe(false);
    membership.validFrom = "2026-09-02T00:00:00.000Z";
    membership.validTo = null;
    expect(decideScopeCoupledAuthorization(requestAccess, permissions.catalogWrite, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_a",
    }, now).allowed).toBe(false);
    membership.validFrom = "not-a-date";
    expect(decideScopeCoupledAuthorization(requestAccess, permissions.catalogWrite, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_a",
    }, now).allowed).toBe(false);
  });

  it("accepts an effective explicit grant only at the matching target", () => {
    const requestAccess = access();
    requestAccess.explicitPermissions.push({
      grantId: "refund_store_b",
      operatorId: requestAccess.actorId,
      permissionId: permissions.orderRefund,
      scopeType: "store",
      merchantId: "merchant_a",
      storeId: "store_b",
      grantedBy: "owner_a",
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2026-12-31T00:00:00.000Z",
    });
    expect(decideScopeCoupledAuthorization(requestAccess, permissions.orderRefund, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_b",
    }, now)).toMatchObject({ allowed: true, proof: { sourceType: "explicit_grant" } });
    expect(decideScopeCoupledAuthorization(requestAccess, permissions.orderRefund, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_a",
    }, now).allowed).toBe(false);
  });

  it("throws a payload-free 403 decision without mutating the access snapshot", () => {
    const requestAccess = access();
    const before = structuredClone(requestAccess);
    expect(() => requireScopeCoupledAuthorization(requestAccess, permissions.orderWrite, {
      scopeType: "store", merchantId: "merchant_b", storeId: "store_b1",
    }, now)).toThrow(expect.objectContaining({ code: "forbidden", statusCode: 403 }));
    expect(requestAccess).toEqual(before);
  });

  it("exposes one reusable application guard without reconstructing global permission union", async () => {
    const actor = {
      operatorId: "operator_multi",
      role: "manager" as const,
      organizationId: "org_a",
      access: access(),
    };
    await expect(requireScopedActorPermission(actor, permissions.catalogWrite, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_a",
    })).resolves.toMatchObject({ allowed: true, proof: { sourceId: "manager_store_a" } });
    await expect(requireScopedActorPermission(actor, permissions.catalogWrite, {
      scopeType: "store", merchantId: "merchant_a", storeId: "store_b",
    })).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
  });
});
