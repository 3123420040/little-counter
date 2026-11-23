import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAccessSnapshotV1 } from "../utils/appAccessSnapshot";

const mocks = vi.hoisted(() => ({
  access: null as AppAccessSnapshotV1 | null,
  fetchProducts: vi.fn(), fetchCustomers: vi.fn(), getBootstrapSnapshot: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => options }));
vi.mock("./useAppAccessSnapshot", () => ({ useAppAccessSnapshot: () => ({ operatingSnapshot: mocks.access }) }));
vi.mock("../api/endpoints", () => ({ fetchProducts: mocks.fetchProducts, fetchCustomers: mocks.fetchCustomers }));
vi.mock("../utils/offlineQueue", () => ({ getBootstrapSnapshot: mocks.getBootstrapSnapshot }));
import { ApiError } from "../api/client";
import { useProducts } from "./useProducts";
import { useCustomers } from "./useCustomers";

const access: AppAccessSnapshotV1 = {
  operatorId: "operator_a", merchantId: "merchant_a", storeIds: ["store_a"],
  permissionIds: [], accessEpoch: "session:1", capabilityPartition: "catalog:v1",
};
const cached = {
  products: [{ title: "Apple", variants: [{ sku: "OTHER" }, { sku: "SAMPLE-APPLE" }] }],
  customers: [{ first_name: "Apple" }],
};
type Query = { queryFn: () => Promise<unknown>; queryKey: readonly unknown[]; enabled: boolean };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access = access;
  mocks.getBootstrapSnapshot.mockResolvedValue(cached);
});

describe.each([
  ["products", () => useProducts({ q: "SAMPLE" }), mocks.fetchProducts, cached.products],
  ["customers", () => useCustomers("Apple"), mocks.fetchCustomers, cached.customers],
] as const)("%s offline reads", (_name, hook, fetch, expected) => {
  it.each([401, 403, 404, 422, 500])("does not bypass HTTP %s with stale offline data", async (status) => {
    const denied = new ApiError("Denied", status, "forbidden");
    fetch.mockRejectedValue(denied);
    await expect((hook() as unknown as Query).queryFn()).rejects.toBe(denied);
    expect(mocks.getBootstrapSnapshot).not.toHaveBeenCalled();
  });

  it("uses scoped offline data only on a network failure and keeps every variant searchable", async () => {
    fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const query = hook() as unknown as Query;
    await expect(query.queryFn()).resolves.toEqual(expected);
    expect(mocks.getBootstrapSnapshot).toHaveBeenCalledWith(access);
    expect(query.queryKey).toEqual(expect.arrayContaining(["operator:operator_a", "merchant:merchant_a", "stores:store_a"]));
    expect(query.enabled).toBe(true);
  });

  it("fails closed without a verified access snapshot or matching offline partition", async () => {
    const offline = new TypeError("Failed to fetch");
    fetch.mockRejectedValue(offline);
    mocks.access = null;
    mocks.getBootstrapSnapshot.mockResolvedValue(null);
    const query = hook() as unknown as Query;
    expect(query.enabled).toBe(false);
    await expect(query.queryFn()).rejects.toBe(offline);
  });
});
