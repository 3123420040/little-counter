import { describe, expect, it } from "vitest";
import { permissions } from "@medusa-snus/contracts";
import {
  buildAppAccessSnapshotV1,
  buildPartitionedQueryKeyV1,
  canAccessAppRouteV1,
  isAppAccessPartitionedQueryKeyV1,
  withOperatingScopeAccessSnapshotV1,
} from "./appAccessSnapshot";

const me = {
  operatorId: "operator_a",
  displayName: "Operator A",
  role: "staff",
  isPlatformAdmin: false,
  permissionVersion: "verified_memberships_a",
  permissionIds: [permissions.customerRead, permissions.ordersRead, permissions.reportsRead],
  security: {
    requiresPasswordChange: false,
    passwordChangedAt: null,
    globalStatus: "active" as const,
    sessionVersion: 7,
    forceLogoutAfter: null,
  },
  merchant: null,
  stores: [
    { storeId: "store_b", merchantId: "merchant_a", displayName: "B", isPrimary: false },
    { storeId: "store_a", merchantId: "merchant_a", displayName: "A", isPrimary: true },
  ],
};

describe("A2 app access snapshot", () => {
  it("accepts only sales read permissions from the separate historical permission list", () => {
    const snapshot = buildAppAccessSnapshotV1({ ...me, permissionIds: [],
      historicalPermissionIds: [permissions.ordersRead, permissions.reportsRead, permissions.ordersExport,
        permissions.orderWrite, permissions.customerRead, permissions.accountingRead],
    }, { merchantId: "merchant_a", storeIds: ["store_a"], capabilities: {} });
    expect(snapshot.permissionIds).toEqual([permissions.ordersRead, permissions.ordersExport, permissions.reportsRead].sort());
    expect(canAccessAppRouteV1(snapshot, "/orders")).toBe(true);
    expect(canAccessAppRouteV1(snapshot, "/dashboard")).toBe(true);
    expect(canAccessAppRouteV1(snapshot, "/customers")).toBe(false);
    expect(canAccessAppRouteV1(snapshot, "/accounting")).toBe(false);
  });
  it("partitions by operator, merchant, sorted stores, access epoch, and capability versions", () => {
    const snapshot = buildAppAccessSnapshotV1(me, {
      merchantId: "merchant_a",
      storeIds: ["store_b", "store_a"],
      capabilities: { ordersRead: "v3", orderDetail: "v2", orderRecreate: "v2", dashboardRead: "v1" },
    });

    expect(snapshot.storeIds).toEqual(["store_a", "store_b"]);
    expect(snapshot.accessEpoch).toContain("session:7");
    expect(snapshot.capabilityPartition).toBe("dashboardRead:v1|orderDetail:v2|orderRecreate:v2|ordersRead:v3");
    expect(buildPartitionedQueryKeyV1(snapshot, "orders", { from: "2026-09-01" })).toEqual([
      "orders",
      "operator:operator_a",
      "merchant:merchant_a",
      "stores:store_a,store_b",
      expect.stringContaining("epoch:session:7"),
      "capabilities:dashboardRead:v1|orderDetail:v2|orderRecreate:v2|ordersRead:v3",
      { from: "2026-09-01" },
    ]);
  });

  it("uses the same permission snapshot for navigation and direct routes", () => {
    const snapshot = buildAppAccessSnapshotV1(me, {
      merchantId: "merchant_a",
      storeIds: ["store_a"],
      capabilities: { ordersRead: "v3" },
    });

    expect(canAccessAppRouteV1(snapshot, "/orders")).toBe(true);
    expect(canAccessAppRouteV1(snapshot, "/customers/customer_a")).toBe(true);
    expect(canAccessAppRouteV1(snapshot, "/dashboard")).toBe(true);
    expect(canAccessAppRouteV1(snapshot, "/accounting")).toBe(false);
  });

  it("identifies only complete access partitions for scope-change cancellation and purge", () => {
    const snapshot = buildAppAccessSnapshotV1(me, {
      merchantId: "merchant_a",
      storeIds: ["store_a"],
      capabilities: { ordersRead: "v3" },
    });

    expect(isAppAccessPartitionedQueryKeyV1(buildPartitionedQueryKeyV1(snapshot, "orders"))).toBe(true);
    expect(isAppAccessPartitionedQueryKeyV1(["orders", "merchant:merchant_a"])).toBe(false);
    expect(isAppAccessPartitionedQueryKeyV1(["me", "operator_a"])).toBe(false);
  });

  it("derives catalog cache scope from the operating store without losing actor or epoch", () => {
    const reportSnapshot = buildAppAccessSnapshotV1(me, {
      merchantId: "merchant_report",
      storeIds: ["store_report_a", "store_report_b"],
      capabilities: { catalogRead: "v1" },
    });
    const operatingSnapshot = withOperatingScopeAccessSnapshotV1(reportSnapshot, {
      operatingMerchantId: "merchant_operating",
      operatingStoreId: "store_operating",
    }, [{ merchantId: "merchant_operating", storeId: "store_operating" }]);

    expect(operatingSnapshot).toMatchObject({
      operatorId: "operator_a",
      merchantId: "merchant_operating",
      storeIds: ["store_operating"],
      accessEpoch: reportSnapshot.accessEpoch,
    });
    expect(buildPartitionedQueryKeyV1(operatingSnapshot!, "inventory", { offset: 20 }))
      .toEqual(expect.arrayContaining([
        "operator:operator_a",
        "merchant:merchant_operating",
        "stores:store_operating",
        expect.stringContaining("epoch:session:7"),
        { offset: 20 },
      ]));
    expect(withOperatingScopeAccessSnapshotV1(reportSnapshot, {
      operatingMerchantId: "merchant_operating",
      operatingStoreId: "",
    }, [])).toBeNull();
    expect(withOperatingScopeAccessSnapshotV1(reportSnapshot, {
      operatingMerchantId: "merchant_revoked", operatingStoreId: "store_revoked",
    }, me.stores)).toBeNull();
  });
  it("changes the partition when memberships change with the same session and permission union", () => {
    const input = { merchantId: "merchant_a", storeIds: ["store_a"], capabilities: {} };
    const before = buildAppAccessSnapshotV1(me, input);
    const after = buildAppAccessSnapshotV1({ ...me, permissionVersion: "verified_memberships_b" }, input);
    expect(before.accessEpoch).not.toBe(after.accessEpoch);
    expect(buildPartitionedQueryKeyV1(before, "products")).not.toEqual(buildPartitionedQueryKeyV1(after, "products"));
  });
});
