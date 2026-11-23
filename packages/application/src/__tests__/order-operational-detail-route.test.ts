import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformError } from "../errors/platform-error";
const mocks = vi.hoisted(() => ({ read: vi.fn(), history: vi.fn(), operating: vi.fn() }));
vi.mock("@medusa-snus/application", async () => ({ ...await import("../errors/platform-error"), getOrderOperationalDetailV1: mocks.read, requireOperatingReadScope: mocks.operating }));
vi.mock("../../../../src/lib/route-utils", () => ({ actorWithOrderHistoryScope: mocks.history, headers: (req: { headers: unknown }) => req.headers,
  route: async (res: { json: (value: unknown) => void }, handler: () => Promise<unknown>) => res.json(await handler()) }));
import { GET } from "../../../../src/api/admin/orders/[id]/operational-v1/route";
import { GET as alias } from "../../../../src/api/platform/admin/orders/[id]/operational-v1/route";
const actor = { operatorId: "staff-a", role: "staff" }, scope = { scopeKind: "report", merchantId: "m-a", storeIds: ["s-a"] };
const operating = { scopeKind: "operating", merchantId: "m-a", storeId: "s-a", stockLocationId: "l-a" };
const request = { params: { id: "order-a" }, headers: { "x-report-store-ids": "s-a" } }, response = { json: vi.fn(), setHeader: vi.fn() };
beforeEach(() => { vi.clearAllMocks();mocks.history.mockResolvedValue({ actor, scope });mocks.operating.mockResolvedValue(operating);mocks.read.mockResolvedValue({ id: "order-a" }); });
describe("operational detail history authority", () => {
  it("shares the exact platform alias, binds scoped actor and prevents caching", async () => {
    expect(alias).toBe(GET);await GET(request, response as never);
    expect(mocks.history).toHaveBeenCalledWith(request, "staff", "orders:read");
    expect(mocks.read).toHaveBeenCalledWith("order-a", scope, { actor, scope: operating });
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(response.setHeader).toHaveBeenCalledWith("X-Order-Detail-Contract", "orders.operational.v1");
  });
  it.each(["scope_required", "forbidden", "resource_not_found"] as const)("keeps authorized history readable when operating scope is %s", async code => {
    mocks.operating.mockRejectedValue(new PlatformError(code, "Not an active operating scope", 403));
    await GET(request, response as never);expect(mocks.read).toHaveBeenCalledWith("order-a", scope, undefined);
  });
  it.each([401,403])("stops before reads for denied history authority (%i)", async status => {
    const error = new PlatformError("forbidden", "Denied", status);mocks.history.mockRejectedValue(error);
    await expect(GET(request, response as never)).rejects.toBe(error);expect(mocks.read).not.toHaveBeenCalled();expect(mocks.operating).not.toHaveBeenCalled();
  });
  it("does not mask an unexpected permission dependency failure", async () => {
    const error = new Error("database unavailable");mocks.operating.mockRejectedValue(error);
    await expect(GET(request, response as never)).rejects.toBe(error);expect(mocks.read).not.toHaveBeenCalled();
  });
});
