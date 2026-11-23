import { beforeEach, describe, expect, it, vi } from "vitest";
const services = vi.hoisted(() => ({ revokePlatformMcpKey: vi.fn(), issuePlatformMcpKey: vi.fn(), rotatePlatformMcpKey: vi.fn(),
  createPlatformMcpConnection: vi.fn(), changePlatformMcpConnectionStatus: vi.fn(), listPlatformMcpConnections: vi.fn(), getPlatformMcpConnection: vi.fn() }));
const routes = vi.hoisted(() => ({ actorWithPlatformMutation: vi.fn(), actorWithPlatformReadAccess: vi.fn(), body: vi.fn(), headers: vi.fn(), query: vi.fn(),
  route: vi.fn(async (_res, handler) => handler()) }));
vi.mock("@medusa-snus/application", () => services);
vi.mock("../../../../src/lib/route-utils", () => routes);
import { POST } from "../../../../src/api/platform/admin/merchants/[merchantId]/mcp-connections/[integrationId]/keys/[keyId]/revoke/route";
import { GET as list } from "../../../../src/api/platform/admin/merchants/[merchantId]/mcp-connections/route";
import { GET as detail } from "../../../../src/api/platform/admin/merchants/[merchantId]/mcp-connections/[integrationId]/route";
import { POST as issue } from "../../../../src/api/platform/admin/merchants/[merchantId]/mcp-connections/[integrationId]/keys/route";
import { POST as rotate } from "../../../../src/api/platform/admin/merchants/[merchantId]/mcp-connections/[integrationId]/keys/[keyId]/rotate/route";
import { POST as create } from "../../../../src/api/platform/admin/merchants/[merchantId]/mcp-connections/route";
import { POST as changeStatus } from "../../../../src/api/platform/admin/merchants/[merchantId]/mcp-connections/[integrationId]/status/route";
const actor = { operatorId: "platform-admin", role: "owner" };
const req = { params: { merchantId: "merchant-a", integrationId: "integration-a", keyId: "a".repeat(32) },
  body: { expectedKeyVersion: 1, reason: "security_incident" }, query: { limit: "1" }, headers: { "idempotency-key": "stable-platform-mcp-revoke" } } as never;
const res = { setHeader: vi.fn() } as never;
describe("platform MCP revoke HTTP wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks(); routes.actorWithPlatformMutation.mockResolvedValue({ actor });
    routes.actorWithPlatformReadAccess.mockResolvedValue({ actor, scope: { scopeKind: "platform_read" } });
    routes.body.mockImplementation(req => req.body); routes.headers.mockImplementation(req => req.headers);
    routes.query.mockImplementation(req => req.query);
    services.revokePlatformMcpKey.mockResolvedValue({ data: { integrationId: "integration-a" }, replayed: false });
  });
  it.each([create, changeStatus])("binds create/status to fresh platform mutation authority and the exact merchant route", async handler => {
    await handler(req, res);
    expect(routes.actorWithPlatformMutation).toHaveBeenCalledWith(req);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    if (handler === create) expect(services.createPlatformMcpConnection).toHaveBeenCalledWith(actor, "merchant-a", req.body, req.headers);
    else expect(services.changePlatformMcpConnectionStatus).toHaveBeenCalledWith(actor, "merchant-a", "integration-a", req.body, req.headers);
  });
  it.each([create, changeStatus])("does not create or change connection status after route authority denies", async handler => {
    routes.actorWithPlatformMutation.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { code: "forbidden" }));
    await expect(handler(req, res)).rejects.toMatchObject({ code: "forbidden" });
    expect(services.createPlatformMcpConnection).not.toHaveBeenCalled(); expect(services.changePlatformMcpConnectionStatus).not.toHaveBeenCalled();
  });
  it.each([issue, rotate])("uses fresh platform mutation authority and no-store for key issuance commands", async handler => {
    await handler(req, res);
    expect(routes.actorWithPlatformMutation).toHaveBeenCalledWith(req);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    if (handler === issue) expect(services.issuePlatformMcpKey).toHaveBeenCalledWith(actor, "merchant-a", "integration-a", req.body, req.headers);
    else expect(services.rotatePlatformMcpKey).toHaveBeenCalledWith(actor, "merchant-a", "integration-a", "a".repeat(32), req.body, req.headers);
  });
  it.each([issue, rotate])("never issues or rotates after route authority denies", async handler => {
    routes.actorWithPlatformMutation.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { code: "forbidden" }));
    await expect(handler(req, res)).rejects.toMatchObject({ code: "forbidden" });
    expect(services.issuePlatformMcpKey).not.toHaveBeenCalled(); expect(services.rotatePlatformMcpKey).not.toHaveBeenCalled();
  });
  it("uses platform mutation authority, exact path targets and no-store, ignoring operating-store headers", async () => {
    await POST(req, res);
    expect(routes.actorWithPlatformMutation).toHaveBeenCalledWith(req);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(services.revokePlatformMcpKey).toHaveBeenCalledWith(actor, "merchant-a", "integration-a", "a".repeat(32),
      { expectedKeyVersion: 1, reason: "security_incident" }, { "idempotency-key": "stable-platform-mcp-revoke" });
  });
  it("never calls the control command after route authorization denies", async () => {
    routes.actorWithPlatformMutation.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { code: "forbidden" }));
    await expect(POST(req, res)).rejects.toMatchObject({ code: "forbidden" });
    expect(services.revokePlatformMcpKey).not.toHaveBeenCalled();
  });
  it("uses platform read authority for merchant list/detail and preserves the independent query", async () => {
    await list(req, res); await detail(req, res);
    expect(routes.actorWithPlatformReadAccess).toHaveBeenCalledTimes(2);
    expect(routes.actorWithPlatformMutation).not.toHaveBeenCalled();
    expect(services.listPlatformMcpConnections).toHaveBeenCalledWith(actor, "merchant-a", { limit: "1" });
    expect(services.getPlatformMcpConnection).toHaveBeenCalledWith(actor, "merchant-a", "integration-a", { limit: "1" });
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });
  it("does not read metadata after platform read authorization denies", async () => {
    routes.actorWithPlatformReadAccess.mockRejectedValue(Object.assign(new Error("forbidden"), { code: "forbidden" }));
    await expect(list(req, res)).rejects.toMatchObject({ code: "forbidden" });
    await expect(detail(req, res)).rejects.toMatchObject({ code: "forbidden" });
    expect(services.listPlatformMcpConnections).not.toHaveBeenCalled();
    expect(services.getPlatformMcpConnection).not.toHaveBeenCalled();
  });
});
