import { afterEach, describe, expect, it, vi } from "vitest";
import { getBuildInfo } from "../services/build-info-service";
import { GET as getBuildInfoRoute } from "../../../../src/api/build-info/route";

const identity = {
  BUILD_SOURCE_COMMIT: "0123456789abcdef0123456789abcdef01234567",
  BUILD_RELEASE_ID: "1.9.0-foundation.1",
  BUILD_COMPATIBILITY_FAMILY: "snus-runtime-v1",
};

describe("CAP-02 public build identity readiness", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("advertises only the intersection of route, config and database/ACL attestations", () => {
    expect(getBuildInfo("medusa", {
      ...identity,
      BUILD_ROUTE_CAPABILITIES: "ordersRead:v2,ordersRead:v3,orderDetail:v1,checkoutWrite:v1,paymentWrite:v1,dashboardRead:v1",
      BUILD_CONFIG_CAPABILITIES: "ordersRead:v2,ordersRead:v3,orderDetail:v1,checkoutWrite:v1,paymentWrite:v1,dashboardRead:v1",
      BUILD_DATABASE_CAPABILITIES: "ordersRead:v2,orderDetail:v1,checkoutWrite:v1,paymentWrite:v1,dashboardRead:v1",
    })).toEqual({
      service: "medusa",
      sourceCommit: identity.BUILD_SOURCE_COMMIT,
      releaseId: identity.BUILD_RELEASE_ID,
      compatibilityFamily: "snus-runtime-v1",
      capabilities: {
        ordersRead: ["v2"],
        orderDetail: ["v1"],
        orderRecreate: [],
        checkoutWrite: ["v1"],
        paymentWrite: ["v1"],
        dashboardRead: ["v1"],
      },
    });
  });

  it("fails closed when any readiness layer is absent", () => {
    expect(getBuildInfo("medusa", identity)).toMatchObject({
      capabilities: {
        ordersRead: [],
        orderDetail: [],
        orderRecreate: [],
        checkoutWrite: [],
        paymentWrite: [],
        dashboardRead: [],
      },
    });
  });

  it("rejects missing or unsafe immutable identity and unknown capability tokens", () => {
    expect(() => getBuildInfo("medusa", {
      BUILD_RELEASE_ID: identity.BUILD_RELEASE_ID,
      BUILD_COMPATIBILITY_FAMILY: identity.BUILD_COMPATIBILITY_FAMILY,
    })).toThrow(/source commit/i);
    expect(() => getBuildInfo("medusa", {
      ...identity,
      BUILD_RELEASE_ID: "unknown",
    })).toThrow(/release/i);
    expect(() => getBuildInfo("medusa", {
      ...identity,
      BUILD_ROUTE_CAPABILITIES: "ordersRead:v5",
    })).toThrow(/capability/i);
  });

  it("serves the public contract with no-store caching", async () => {
    for (const [name, value] of Object.entries({
      ...identity,
      BUILD_ROUTE_CAPABILITIES: "ordersRead:v2",
      BUILD_CONFIG_CAPABILITIES: "ordersRead:v2",
      BUILD_DATABASE_CAPABILITIES: "ordersRead:v2",
    })) vi.stubEnv(name, value);
    const response = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await getBuildInfoRoute({} as never, response as never);

    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      service: "medusa",
      sourceCommit: identity.BUILD_SOURCE_COMMIT,
      capabilities: expect.objectContaining({ ordersRead: ["v2"] }),
    }));
  });
});
