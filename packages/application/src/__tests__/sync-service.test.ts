import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions, type RequestAccess } from "@medusa-snus/contracts";

const mocks = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  listLoyaltyTiers: vi.fn(),
  listProducts: vi.fn(),
  resolvePackageEntitlements: vi.fn(),
  resolvePaymentProviderAvailability: vi.fn(),
  resolveScopeBootstrap: vi.fn(),
}));
const membershipExpiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
const sessionExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();

vi.mock("../services/customer-service", () => ({
  listCustomers: mocks.listCustomers,
  listLoyaltyTiers: mocks.listLoyaltyTiers,
}));
vi.mock("../services/product-service", () => ({
  listProducts: mocks.listProducts,
}));
vi.mock("../services/feature-entitlement-service", () => ({
  getPackageEntitlements: () => ({ data: { packageKey: "basic", features: [] } }),
  resolvePackageEntitlements: mocks.resolvePackageEntitlements,
}));
vi.mock("../services/payment-provider-service", () => ({
  getPaymentProviderAvailability: () => ({}),
  resolvePaymentProviderAvailability: mocks.resolvePaymentProviderAvailability,
}));
vi.mock("../services/access-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/access-service")>();
  return {
    ...original,
    resolveScopeBootstrap: mocks.resolveScopeBootstrap,
  };
});

import { getSyncBootstrap } from "../services/sync-service";

function scopedAccess(): RequestAccess {
  return {
    actorId: "operator_scoped",
    isPlatformAdmin: false,
    legacyOrganizationId: "org_scoped",
    permissionIds: [permissions.catalogRead, permissions.customerRead],
    explicitPermissions: [],
    memberships: [
      {
        membershipId: "membership_store_a",
        operatorId: "operator_scoped",
        scopeType: "store",
        merchantId: "merchant_a",
        storeId: "store_a",
        roleKey: "staff",
        status: "active",
        validTo: membershipExpiresAt,
        permissionIds: [permissions.catalogRead],
      },
      {
        membershipId: "membership_store_b",
        operatorId: "operator_scoped",
        scopeType: "store",
        merchantId: "merchant_b",
        storeId: "store_b",
        roleKey: "staff",
        status: "active",
        permissionIds: [permissions.customerRead],
      },
    ],
  };
}

describe("sync bootstrap snapshot authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProducts.mockResolvedValue([{ id: "product_a" }]);
    mocks.listCustomers.mockResolvedValue({
      customers: [{ id: "customer_a" }],
      count: 1,
      limit: 100,
      offset: 0,
    });
    mocks.listLoyaltyTiers.mockResolvedValue({ data: [{ id: "tier_a" }] });
    mocks.resolvePackageEntitlements.mockResolvedValue({
      packageKey: "basic",
      features: [],
    });
    mocks.resolvePaymentProviderAvailability.mockResolvedValue({
      sepay_va: { enabled: false, mode: "mock", reason: "integration_config_inactive" },
      nowpayments: { enabled: true, mode: "mock" },
    });
    mocks.resolveScopeBootstrap.mockResolvedValue({
      access: scopedAccess(),
      permissionVersion: "pv1:scoped-access",
      merchants: [{ id: "merchant_a", displayName: "Merchant A", status: "active" }],
      stores: [{
        id: "store_a",
        merchantId: "merchant_a",
        displayName: "Store A",
        stockLocationId: "stock_a",
        isPrimary: true,
        status: "active",
      }],
      activeOperatingScope: {
        scopeKind: "operating",
        merchantId: "merchant_a",
        storeId: "store_a",
        stockLocationId: "stock_a",
      },
      reportOptions: [],
      platformReadScope: null,
    });
  });

  it("does not borrow aggregate customer permission from another store", async () => {
    const result = await getSyncBootstrap({
      operatorId: "operator_scoped",
      role: "staff",
      organizationId: "org_scoped",
      sessionVersion: 9,
      sessionExpiresAt,
    });

    expect(mocks.listProducts).toHaveBeenCalledWith({
      merchantId: "merchant_a",
      stockLocationId: "stock_a",
      limit: 500,
    });
    expect(mocks.listCustomers).not.toHaveBeenCalled();
    expect(mocks.listLoyaltyTiers).not.toHaveBeenCalled();
    expect(mocks.resolvePaymentProviderAvailability).toHaveBeenCalledWith({
      merchantId: "merchant_a",
      storeId: "store_a",
    });
    expect(result.data).toMatchObject({
      operatorId: "operator_scoped",
      sessionVersion: 9,
      permissionVersion: "pv1:scoped-access",
      permissionIds: [permissions.catalogRead, permissions.customerRead],
      snapshotPermissionIds: [permissions.catalogRead],
      snapshotAuthorizationExpiresAt: membershipExpiresAt,
      products: [{ id: "product_a" }],
      customers: [],
      loyaltyTiers: [],
      paymentProviders: {
        sepay_va: { enabled: false, mode: "mock", reason: "integration_config_inactive" },
        nowpayments: { enabled: true, mode: "mock" },
      },
    });
  });
});
