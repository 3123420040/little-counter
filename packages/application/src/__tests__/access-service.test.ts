import { describe, expect, it, vi } from "vitest";
import { permissions, type RequestAccess } from "@medusa-snus/contracts";
import {
  hasPlatformReadAccess,
  hasStoreAccess,
  platformMembershipPermissionIds,
  platformRolePermissionIds,
  requireActorAccessPermission,
  requireMerchantTargetScope,
  requirePlatformReadScopeForAccess,
  requireSelectedOperatingScope,
  resolveRequestAccess,
} from "../services/access-service";
import { requireRole, signJwt, verifyJwt } from "../middleware/auth";
import { PlatformError } from "../errors/platform-error";
import { withConnectedClient } from "../db/transaction";

vi.mock("../db/schema", () => ({ ensurePlatformSchema: vi.fn() }));
vi.mock("../db/transaction", () => ({ withConnectedClient: vi.fn() }));

describe("explicit membership and permission access rules", () => {
  function access(overrides: Partial<RequestAccess> = {}): RequestAccess {
    return {
      actorId: "op_staff_a",
      isPlatformAdmin: false,
      legacyOrganizationId: "org_default",
      explicitPermissions: [],
      permissionIds: ["inventory:read", "orders:read"],
      memberships: [
        {
          membershipId: "mem_store_a",
          operatorId: "op_staff_a",
          scopeType: "store",
          merchantId: "merchant_a",
          storeId: "store_a",
          roleKey: "staff",
          status: "active",
          permissionIds: ["inventory:read", "orders:read"],
        },
      ],
      ...overrides,
    };
  }

  it("allows the exact merchant/store membership and denies merchant B / store B", () => {
    const requestAccess = access();
    expect(hasStoreAccess(requestAccess, "merchant_a", "store_a")).toBe(true);
    expect(hasStoreAccess(requestAccess, "merchant_a", "store_b")).toBe(false);
    expect(hasStoreAccess(requestAccess, "merchant_b", "store_a")).toBe(false);
  });

  it("does not keep expired business membership visibility alive in memory", () => {
    const expired = access({
      memberships: [{
        ...access().memberships[0]!,
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-08-31T00:00:00.000Z",
      }],
    } as never);

    expect(hasStoreAccess(expired, "merchant_a", "store_a")).toBe(false);
  });

  it("treats platform read as read-only: it grants broad read visibility but is not a mutation permission", () => {
    const platformAccess = access({
      isPlatformAdmin: true,
      permissionIds: ["platform:read"],
      memberships: [
        {
          membershipId: "mem_platform",
          operatorId: "op_platform",
          scopeType: "platform",
          merchantId: null,
          storeId: null,
          roleKey: null,
          platformRoleKey: "platform_admin",
          status: "active",
          permissionIds: ["platform:read"],
        },
      ],
    });

    expect(hasStoreAccess(platformAccess, "merchant_a", "store_a")).toBe(true);
    expect(platformAccess.permissionIds).toContain("platform:read");
    expect(platformAccess.permissionIds).not.toContain("remote_order:create");
    expect(platformAccess.permissionIds).not.toContain("order:cancel");
  });

  it("keeps platform membership grants narrow and purpose-specific", () => {
    expect(platformMembershipPermissionIds).toEqual([
      permissions.platformRead,
      permissions.platformWrite,
      permissions.integrationConfigRead,
      permissions.integrationConfigWrite,
    ]);
    expect(platformMembershipPermissionIds).not.toContain(permissions.orderWrite);
    expect(platformMembershipPermissionIds).not.toContain(permissions.accountingWrite);
    expect(platformMembershipPermissionIds).not.toContain(permissions.catalogWrite);
    expect(platformRolePermissionIds.platform_readonly).toEqual([
      permissions.platformRead,
      permissions.integrationConfigRead,
    ]);
    expect(platformRolePermissionIds.platform_readonly).not.toContain(permissions.integrationConfigWrite);
  });

  it("does not let accountant satisfy manager mutations through role order", () => {
    const payload = verifyJwt(signJwt({
      operatorId: "op_accountant",
      role: "accountant",
      displayName: "Accountant",
      organizationId: "org_default",
    }));

    expect(payload).toBeTruthy();
    expect(requireRole(payload!, "accountant")).toBe(true);
    expect(requireRole(payload!, "staff")).toBe(true);
    expect(requireRole(payload!, "manager")).toBe(false);
    expect(requireRole(payload!, "owner")).toBe(false);
  });

  it("denies accountant manager, catalog, and customer mutations by explicit permission", async () => {
    const accountantAccess = access({
      actorId: "op_accountant",
      permissionIds: [permissions.accountingRead, permissions.accountingWrite, permissions.reportsRead],
      memberships: [{
        membershipId: "mem_accountant",
        operatorId: "op_accountant",
        scopeType: "merchant",
        merchantId: "merchant_a",
        storeId: null,
        roleKey: "accountant",
        status: "active",
        permissionIds: [permissions.accountingRead, permissions.accountingWrite, permissions.reportsRead],
      }],
    });
    const accountant = { operatorId: "op_accountant", role: "accountant" as const, organizationId: "org_default", access: accountantAccess };

    await expect(requireActorAccessPermission(accountant, permissions.catalogWrite)).rejects.toMatchObject({ code: "forbidden" });
    await expect(requireActorAccessPermission(accountant, permissions.customerWrite)).rejects.toMatchObject({ code: "forbidden" });
    await expect(requireActorAccessPermission(accountant, permissions.inventoryWrite)).rejects.toMatchObject({ code: "forbidden" });
    await expect(requireActorAccessPermission(accountant, permissions.accountingWrite)).resolves.toBeUndefined();
  });

  it("allows staff customer write without granting broader operational writes", async () => {
    const staffAccess = access({
      permissionIds: [permissions.customerRead, permissions.customerWrite, permissions.ordersRead],
      memberships: [{
        membershipId: "mem_staff",
        operatorId: "op_staff_a",
        scopeType: "store",
        merchantId: "merchant_a",
        storeId: "store_a",
        roleKey: "staff",
        status: "active",
        permissionIds: [permissions.customerRead, permissions.customerWrite, permissions.ordersRead],
      }],
    });
    const staff = { operatorId: "op_staff_a", role: "staff" as const, organizationId: "org_default", access: staffAccess };

    await expect(requireActorAccessPermission(staff, permissions.customerWrite)).resolves.toBeUndefined();
    await expect(requireActorAccessPermission(staff, permissions.catalogWrite)).rejects.toMatchObject({ code: "forbidden" });
    await expect(requireActorAccessPermission(staff, permissions.accountingWrite)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("requires platform membership even if a merchant owner has platform:read in a supplied permission list", () => {
    const ownerAccess = access({
      actorId: "op_owner",
      isPlatformAdmin: true,
      permissionIds: [permissions.platformRead],
      memberships: [{
        membershipId: "mem_owner",
        operatorId: "op_owner",
        scopeType: "merchant",
        merchantId: "merchant_a",
        storeId: null,
        roleKey: "owner",
        status: "active",
        permissionIds: [permissions.platformRead],
      }],
    });

    expect(hasPlatformReadAccess(ownerAccess)).toBe(false);
    expect(() => requirePlatformReadScopeForAccess(ownerAccess, { scopeKind: "platform_read" })).toThrow("Platform read access required");
  });

  it("does not accept an expired platform membership as a visibility proof", () => {
    const expired = access({
      isPlatformAdmin: true,
      permissionIds: [permissions.platformRead],
      memberships: [{
        membershipId: "mem_platform_expired",
        operatorId: "op_staff_a",
        scopeType: "platform",
        merchantId: null,
        storeId: null,
        roleKey: null,
        platformRoleKey: "platform_readonly",
        status: "active",
        permissionIds: [permissions.platformRead],
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-08-31T00:00:00.000Z",
      }],
    } as never);

    expect(hasPlatformReadAccess(expired)).toBe(false);
  });

  it("requires one valid operating store and one accessible merchant target for mutations", () => {
    const ownerAccess = access({
      actorId: "op_owner",
      memberships: [{
        membershipId: "mem_owner",
        operatorId: "op_owner",
        scopeType: "merchant",
        merchantId: "merchant_a",
        storeId: null,
        roleKey: "owner",
        status: "active",
        permissionIds: [permissions.catalogWrite],
      }],
    });
    const stores = [
      { id: "store_a", merchantId: "merchant_a", displayName: "A", stockLocationId: "sloc_a", isPrimary: true, status: "active" },
      { id: "store_b", merchantId: "merchant_a", displayName: "B", stockLocationId: "sloc_b", isPrimary: false, status: "active" },
    ];

    expect(() => requireSelectedOperatingScope(ownerAccess, stores, {})).toThrow("One operating store is required");
    expect(() => requireSelectedOperatingScope(ownerAccess, stores, { "x-store-id": "all" })).toThrow("Operating scope is not accessible");
    expect(requireSelectedOperatingScope(ownerAccess, stores, { "x-store-id": "store_a" })).toMatchObject({
      scopeKind: "operating",
      merchantId: "merchant_a",
      storeId: "store_a",
    });
    expect(requireMerchantTargetScope(ownerAccess, "merchant_a")).toEqual({ scopeKind: "merchant_target", merchantId: "merchant_a" });
    expect(() => requireMerchantTargetScope(ownerAccess, "merchant_b")).toThrow("Merchant target is not accessible");
  });

  it("does not turn a legacy merchant owner into a platform reader", async () => {
    const fakeClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ exists: false }] }),
    };
    vi.mocked(withConnectedClient).mockImplementationOnce((callback) => callback(fakeClient as never));

    const ownerAccess = await resolveRequestAccess({
      operatorId: "op_owner",
      role: "owner",
      organizationId: "org_default",
    });

    expect(ownerAccess.isPlatformAdmin).toBe(false);
    expect(ownerAccess.permissionIds).not.toContain("platform:read");
  });

  it("fails closed when the membership table exists but no active membership remains", async () => {
    const fakeClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("information_schema.tables")) return { rows: [{ exists: true }] };
        if (sql.includes("FROM app.operator_memberships")) return { rows: [] };
        return { rows: [] };
      }),
    };
    vi.mocked(withConnectedClient).mockImplementationOnce((callback) => callback(fakeClient as never));

    await expect(resolveRequestAccess({
      operatorId: "op_revoked",
      role: "manager",
      organizationId: "org_default",
    })).rejects.toMatchObject({ code: "membership_required", statusCode: 403 });
  });

  it.each(["staff", "manager", "accountant", "owner"] as const)(
    "retains persisted %s permissions and adds mandatory customer/category defaults to its scoped proof",
    async (role) => {
      const fakeClient = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("information_schema.tables"))
            return { rows: [{ exists: true }] };
          if (sql.includes("FROM app.role_permissions"))
            return { rows: [{ permission_id: permissions.profileRead }] };
          if (sql.includes("FROM app.operator_memberships"))
            return {
              rows: [
                {
                  id: "mem_business",
                  scope_type: "store",
                  merchant_id: "merchant_a",
                  store_id: "store_a",
                  role_key: role,
                  status: "active",
                  merchant_status: "active",
                  store_status: "active",
                },
              ],
            };
          if (sql.includes("FROM app.merchants"))
            return {
              rows: [
                {
                  id: "merchant_a",
                  displayName: "Merchant A",
                  legacyOrganizationId: "org_a",
                  status: "active",
                },
              ],
            };
          if (sql.includes("FROM app.stores"))
            return {
              rows: [
                {
                  id: "store_a",
                  merchantId: "merchant_a",
                  displayName: "Store A",
                  stockLocationId: "sloc_a",
                  isPrimary: true,
                  status: "active",
                },
              ],
            };
          return { rows: [] };
        }),
      };
      vi.mocked(withConnectedClient).mockImplementationOnce((callback) =>
        callback(fakeClient as never),
      );
      const access = await resolveRequestAccess({
        operatorId: "op_business",
        role,
        organizationId: "org_a",
      });
      expect(access.memberships[0]?.permissionIds).toEqual(
        expect.arrayContaining([
          permissions.profileRead,
          permissions.customerRead,
          permissions.customerWrite,
          permissions.categoryRead,
        ]),
      );
      expect(access.permissionIds.includes(permissions.orderCancelOwn)).toBe(role === "staff");
      expect(access.permissionIds).not.toContain(permissions.orderCancel);
      expect(access.permissionIds).not.toContain(permissions.catalogWrite);
      expect(access.permissionIds).not.toContain(permissions.platformWrite);
    },
  );

  it("adds active explicit grants to resolved access without putting them in platform role defaults", async () => {
    const fakeClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        if (sql.includes("FROM app.role_permissions")) {
          return { rows: [] };
        }
        if (sql.includes("FROM app.operator_memberships")) {
          return {
            rows: [{
              id: "mem_platform",
              scope_type: "platform",
              merchant_id: null,
              store_id: null,
              role_key: "platform_admin",
              status: "active",
              merchant_status: null,
              store_status: null,
            }],
          };
        }
        if (sql.includes("FROM app.operator_explicit_permission_grants")) {
          return {
            rows: [{
              id: "grant_impersonation",
              permission_id: permissions.platformImpersonationStart,
              scope_type: "platform",
              merchant_id: null,
              store_id: null,
              granted_by: "op_bootstrap",
              valid_from: "2026-07-01T00:00:00.000Z",
              valid_to: null,
            }],
          };
        }
        if (sql.includes("FROM app.merchants") || sql.includes("FROM app.stores")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    vi.mocked(withConnectedClient).mockImplementationOnce((callback) => callback(fakeClient as never));

    const access = await resolveRequestAccess({
      operatorId: "op_platform",
      role: "owner",
      organizationId: "org_default",
    });

    expect(platformRolePermissionIds.platform_admin).not.toContain(permissions.platformImpersonationStart);
    expect(access.permissionIds).toContain(permissions.platformRead);
    expect(access.permissionIds).toContain(permissions.platformImpersonationStart);
    expect(access.explicitPermissions).toEqual([
      expect.objectContaining({
        grantId: "grant_impersonation",
        permissionId: permissions.platformImpersonationStart,
        scopeType: "platform",
      }),
    ]);
  });
});

describe("queued sale replay protection", () => {
  it("requires a captured merchant/store snapshot to replay a queued sale", async () => {
    const { revalidateQueuedSaleAccess } = await import("../../../../apps/pos/src/utils/offlineQueue");
    const sale = {
      id: "idem_1",
      payload: { idempotencyKey: "idem_1", items: [], paymentMethod: "cash", amountReceived: 0 },
      status: "queued" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(revalidateQueuedSaleAccess(sale, { operatorId: "op", merchantIds: ["merchant_a"], storeIds: ["store_a"] })).toEqual({
      ok: false,
      reason: "missing_scope_snapshot",
    });
  });

  it("rejects replay into a store the actor no longer has", async () => {
    const { revalidateQueuedSaleAccess } = await import("../../../../apps/pos/src/utils/offlineQueue");
    const sale = {
      id: "idem_2",
      payload: { idempotencyKey: "idem_2", items: [], paymentMethod: "cash", amountReceived: 0 },
      status: "queued" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      scope: {
        operatorId: "op",
        accessEpoch: "session:4",
        capabilityVersion: "checkoutWrite:v1",
        merchantId: "merchant_a",
        storeId: "store_a",
        stockLocationId: "sloc_a",
      },
    };

    expect(revalidateQueuedSaleAccess(sale, { operatorId: "op", accessEpoch: "session:4", capabilityVersion: "checkoutWrite:v1", selectedMerchantId: "merchant_a", selectedStoreId: "store_a", merchantIds: ["merchant_a"], storeIds: ["store_b"] })).toEqual({
      ok: false,
      reason: "scope_no_longer_accessible",
    });
    expect(revalidateQueuedSaleAccess(sale, { operatorId: "op", accessEpoch: "session:5", capabilityVersion: "checkoutWrite:v1", selectedMerchantId: "merchant_a", selectedStoreId: "store_a", merchantIds: ["merchant_a"], storeIds: ["store_a"] })).toEqual({
      ok: false,
      reason: "access_epoch_changed",
    });
    expect(revalidateQueuedSaleAccess(sale, { operatorId: "op", accessEpoch: "session:4", capabilityVersion: "checkoutWrite:v1", selectedMerchantId: "merchant_a", selectedStoreId: "store_a", merchantIds: ["merchant_a"], storeIds: ["store_a"] })).toEqual({ ok: true });
  });
});

void PlatformError;
