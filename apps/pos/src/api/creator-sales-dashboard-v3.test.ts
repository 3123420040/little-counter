import { beforeEach, describe, expect, it, vi } from "vitest";
import { creatorSalesDashboardV3Fixture } from "../../../../packages/application/src/__tests__/fixtures/creator-sales-dashboard";
const client = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./client", () => ({ api: client }));
import { fetchCreatorSalesDashboardV3 } from "./endpoints";
const value = creatorSalesDashboardV3Fixture("full"), scope = value.context.normalizedScope;
const input = { from: value.context.localDateRange.from, to: value.context.localDateRange.to, creatorOperatorIds: ["staff_a"] };
beforeEach(() => { client.get.mockReset(); client.get.mockResolvedValue(structuredClone(value)); });
describe("captured DashboardV3 API", () => {
  it("binds selected creators, exact report scope, operator and AbortSignal", async () => {
    const signal = new AbortController().signal;
    expect(await fetchCreatorSalesDashboardV3(input, scope, "staff_a", signal)).toEqual(value);
    expect(client.get).toHaveBeenCalledExactlyOnceWith("/api/platform/admin/dashboard/creator-sales-v3?from=2026-10-18&to=2026-10-18&creatorOperatorId=staff_a",
      { "x-report-merchant-id": scope.merchantId, "x-report-store-ids": scope.storeIds.join(",") }, signal);
  });
  it("accepts the server's fixed-self selection for a staff request with no selector", async () => {
    client.get.mockResolvedValue(creatorSalesDashboardV3Fixture());
    expect((await fetchCreatorSalesDashboardV3({ ...input, creatorOperatorIds: [] }, scope, "staff_a")).audience).toBe("self");
    await expect(fetchCreatorSalesDashboardV3(input, scope, "another-operator")).rejects.toThrow(/khớp/);
  });
  it.each(["merchant", "store", "date", "creator", "version", "self_leak"])("rejects %s response drift without downgrading to V2", async fault => {
    const changed = structuredClone(value);
    if (fault === "merchant") changed.context.normalizedScope.merchantId = "foreign";
    if (fault === "store") changed.context.normalizedScope.storeIds = ["foreign-store"];
    if (fault === "date") changed.context.localDateRange.from = "2026-10-17";
    if (fault === "creator") changed.creatorSelection = { mode: "all", creatorOperatorIds: [] };
    client.get.mockResolvedValue(fault === "version" ? { ...changed, schemaVersion: 2 } : fault === "self_leak" ? { ...changed, audience: "self" } : changed);
    await expect(fetchCreatorSalesDashboardV3(input, scope, "staff_a")).rejects.toThrow();
    expect(client.get).toHaveBeenCalledTimes(1);
  });
  it("rejects an empty creator identity before issuing any request", async () => {
    await expect(fetchCreatorSalesDashboardV3({ ...input, creatorOperatorIds: [""] }, scope, "staff_a")).rejects.toThrow();
    expect(client.get).not.toHaveBeenCalled();
  });
});
