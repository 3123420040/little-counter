import { beforeEach, describe, expect, it, vi } from "vitest";

const application = vi.hoisted(() => ({
  PlatformError: class PlatformError extends Error {
    constructor(public code: string, message: string, public statusCode = 400) {
      super(message);
    }
  },
  verifySignupToken: vi.fn(),
}));
const routeUtils = vi.hoisted(() => ({
  body: vi.fn((request) => request.body),
  rateLimit: vi.fn(),
  route: vi.fn(async (_response, handler) => handler()),
}));

vi.mock("@medusa-snus/application", () => application);
vi.mock("../../../../src/lib/route-utils", () => routeUtils);

import * as verifyRoute from "../../../../src/api/public/verify/route";

describe("public signup verification route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    application.verifySignupToken.mockResolvedValue({ status: "verified" });
  });

  it("accepts tokens only in POST bodies and forwards the idempotency header", async () => {
    const request = {
      body: { token: "sur_request.secret" },
      headers: { "idempotency-key": "verify-once" },
      ip: "127.0.0.1",
    } as never;
    const response = { setHeader: vi.fn() } as never;
    await verifyRoute.POST(request, response);
    expect(application.verifySignupToken).toHaveBeenCalledWith("sur_request.secret", {
      "idempotency-key": "verify-once",
    });
    expect(verifyRoute).not.toHaveProperty("GET");
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(response.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
  });
});
