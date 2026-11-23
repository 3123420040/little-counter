// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAccessSnapshotV1 } from "./appAccessSnapshot";
import { getBootstrapSnapshot, saveBootstrapSnapshot, type BootstrapSnapshot } from "./offlineQueue";
import { buildAppAccessSnapshotV1 } from "./appAccessSnapshot";

const selected = vi.hoisted(() => ({ operatingMerchantId: "merchant_a", operatingStoreId: "store_a" }));
vi.mock("../api/client", () => ({ getClientScopeSnapshot: () => selected }));

const access: AppAccessSnapshotV1 = {
  operatorId: "operator_a", merchantId: "merchant_a", storeIds: ["store_a"],
  permissionIds: [], accessEpoch: "session:1", capabilityPartition: "catalog:v1",
  permissionVersion: "verified_a", sessionVersion: 1,
};
const scope = { merchantId: "merchant_a", storeId: "store_a" };
const bootstrap: BootstrapSnapshot = {
  generatedAt: "2026-10-18T00:00:00Z", products: [], customers: [], loyaltyTiers: [],
  permissionVersion: "verified_a", operatorId: "operator_a", sessionVersion: 1,
  snapshotAuthorizationExpiresAt: "2099-01-01T00:00:00.000Z",
};
const rows = new Map<string, unknown>();

beforeEach(() => {
  rows.clear();
  selected.operatingMerchantId = "merchant_a";
  selected.operatingStoreId = "store_a";
  const store = {
    put(row: { key: string }) {
      rows.set(row.key, row);
      return request(row.key);
    },
    get(key: string) { return request(rows.get(key)); },
  };
  const database = {
    transaction: () => ({ objectStore: () => store }),
    close: vi.fn(),
  };
  function request(result: unknown) {
    const pending = { result, onsuccess: undefined as undefined | (() => void) };
    queueMicrotask(() => pending.onsuccess?.());
    return pending;
  }
  vi.stubGlobal("indexedDB", { open: () => request(database) });
});
afterEach(() => vi.unstubAllGlobals());

describe("offline bootstrap storage", () => {
  it("reads only the exact operator, merchant, store, permission epoch and capability partition", async () => {
    await saveBootstrapSnapshot(bootstrap, access, scope);
    await expect(getBootstrapSnapshot(access)).resolves.toEqual(bootstrap);
    for (const changed of [
      { ...access, operatorId: "operator_b" },
      { ...access, merchantId: "merchant_b" },
      { ...access, storeIds: ["store_b"] },
      { ...access, accessEpoch: "session:2" },
      { ...access, capabilityPartition: "catalog:v2" },
    ]) {
      await expect(getBootstrapSnapshot(changed)).resolves.toBeNull();
    }
  });

  it("never upgrades a legacy global snapshot or reads without verified access", async () => {
    rows.set("bootstrap", { key: "bootstrap", ...bootstrap });
    await expect(getBootstrapSnapshot(access)).resolves.toBeNull();
    await expect(getBootstrapSnapshot(null)).resolves.toBeNull();
    await expect(getBootstrapSnapshot({ ...access, storeIds: [] })).resolves.toBeNull();
    await expect(getBootstrapSnapshot({ ...access, storeIds: ["store_a", "store_b"] })).resolves.toBeNull();
  });
  it("does not return the old store cache after the selected scope changes during an online request", async () => {
    await saveBootstrapSnapshot(bootstrap, access, scope);
    selected.operatingStoreId = "store_b";
    await expect(getBootstrapSnapshot(access)).resolves.toBeNull();
  });

  it("rejects unverified, mismatched and late responses after store selection changes", async () => {
    await saveBootstrapSnapshot(bootstrap, null, scope);
    await saveBootstrapSnapshot(bootstrap, access, undefined);
    await saveBootstrapSnapshot(bootstrap, access, { ...scope, storeId: "store_b" });
    await saveBootstrapSnapshot(bootstrap, access, { ...scope, merchantId: "merchant_b" });
    selected.operatingStoreId = "store_b";
    await saveBootstrapSnapshot(bootstrap, access, scope);
    await expect(getBootstrapSnapshot(access)).resolves.toBeNull();
    expect(rows.size).toBe(0);
  });
  it("misses the old cache after verified membership changes without a permission union or session change", async () => {
    const me = { operatorId: "operator_a", displayName: "A", role: "staff", isPlatformAdmin: false,
      permissionIds: [], merchant: null, stores: [], permissionVersion: "verified_a",
      security: { sessionVersion: 1, requiresPasswordChange: false, passwordChangedAt: null,
        globalStatus: "active" as const, forceLogoutAfter: null } };
    const input = { merchantId: "merchant_a", storeIds: ["store_a"], capabilities: {} };
    const previous = buildAppAccessSnapshotV1(me, input);
    await saveBootstrapSnapshot(bootstrap, previous, scope);
    await expect(getBootstrapSnapshot(previous)).resolves.toEqual(bootstrap);
    const refreshed = buildAppAccessSnapshotV1({ ...me, permissionVersion: "verified_b" }, input);
    await expect(getBootstrapSnapshot(refreshed)).resolves.toBeNull();
    await saveBootstrapSnapshot(bootstrap, refreshed, scope);
    await expect(getBootstrapSnapshot(refreshed)).resolves.toBeNull();
  });
  it("rejects absent or mismatched authorization evidence and expired snapshots", async () => {
    for (const changed of [
      { ...bootstrap, permissionVersion: null }, { ...bootstrap, operatorId: "operator_b" },
      { ...bootstrap, sessionVersion: 2 }, { ...bootstrap, snapshotAuthorizationExpiresAt: "2000-01-01T00:00:00Z" },
    ]) await saveBootstrapSnapshot(changed, access, scope);
    expect(rows.size).toBe(0);
    await saveBootstrapSnapshot(bootstrap, access, scope);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2100-01-01"));
    try { await expect(getBootstrapSnapshot(access)).resolves.toBeNull(); } finally { vi.useRealTimers(); }
  });
});
