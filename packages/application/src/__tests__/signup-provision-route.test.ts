import { beforeEach, describe, expect, it, vi } from "vitest";

const application = vi.hoisted(() => ({
  PlatformError: class PlatformError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  },
  provisionSignupTenant: vi.fn(),
}));

const routeUtils = vi.hoisted(() => ({
  body: vi.fn((request) => request.body),
  rateLimit: vi.fn(),
  route: vi.fn(async (_response, handler) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import { POST as provision } from "../../../../src/api/public/provision/route";

const response = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() } as never;

function request(body: Record<string, unknown>) {
  return { body, headers: {}, ip: "127.0.0.1" } as never;
}

describe("DASH-00 public signup timezone boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    application.provisionSignupTenant.mockResolvedValue({
      merchantId: "merchant-a",
      storeId: "store-a",
      operatorId: "operator-a",
      loginUrl: "/login",
    });
  });

  it("rejects a missing timezone before the provisioning service is called", async () => {
    await expect(provision(request({
      token: "request.token",
      merchantName: "Merchant A",
      storeName: "Store A",
    }), response)).rejects.toMatchObject({
      code: "validation_error",
      statusCode: 400,
    });
    expect(application.provisionSignupTenant).not.toHaveBeenCalled();
  });

  it("passes the explicit store timezone unchanged to the provisioning service", async () => {
    await provision(request({
      token: "request.token",
      merchantName: "Merchant A",
      storeName: "Store A",
      timezone: "America/New_York",
    }), response);

    expect(application.provisionSignupTenant).toHaveBeenCalledWith(
      {
        token: "request.token",
        merchantName: "Merchant A",
        storeName: "Store A",
        timezone: "America/New_York",
      },
      {},
    );
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(response.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
  });
});
