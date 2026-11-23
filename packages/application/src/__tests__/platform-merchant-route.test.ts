import { beforeEach, describe, expect, it, vi } from "vitest";

const application = vi.hoisted(() => ({ createPlatformMerchant: vi.fn(), listPlatformMerchants: vi.fn() }));
const utils = vi.hoisted(() => ({
  actorWithPlatformMutation: vi.fn(), actorWithPlatformReadAccess: vi.fn(),
  body: vi.fn((req) => req.body), headers: vi.fn((req) => req.headers),
  query: vi.fn((req) => req.query || {}),
  route: vi.fn(async (_res, handler) => handler()),
}));
vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => utils);
import { GET, POST } from "../../../../src/api/platform/admin/merchants/route";

const actor = { operatorId: "actual_admin" };
const requestData = { body: { displayName: "Merchant" }, headers: { "idempotency-key": "request-1" } };
const request = requestData as never;
const response = { setHeader: vi.fn() } as never;

describe("Platform merchant collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    utils.actorWithPlatformMutation.mockResolvedValue({ actor });
    utils.actorWithPlatformReadAccess.mockResolvedValue({ scope: "read-scope" });
    application.createPlatformMerchant.mockResolvedValue({ data: { merchantId: "new" }, statusCode: 201 });
  });
  it("authenticates the platform writer before passing input and retry headers", async () => {
    await POST(request, response);
    expect(utils.actorWithPlatformMutation).toHaveBeenCalledWith(request);
    expect(application.createPlatformMerchant).toHaveBeenCalledWith(requestData.body, actor, requestData.headers);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });
  it("stops before provisioning when the platform guard rejects", async () => {
    utils.actorWithPlatformMutation.mockRejectedValue(new Error("forbidden"));
    await expect(POST(request,response)).rejects.toThrow("forbidden");
    expect(application.createPlatformMerchant).not.toHaveBeenCalled();
    expect(utils.body).not.toHaveBeenCalled();
  });
  it("keeps the existing merchant list on its platform read scope", async () => {
    await GET(request,response);
    expect(application.listPlatformMerchants).toHaveBeenCalledWith("read-scope", undefined);
    expect(application.createPlatformMerchant).not.toHaveBeenCalled();
  });
});
