import { afterEach, describe, expect, it, vi } from "vitest";
import { getBuildInfo, getBuildInfoV2 } from "../services/build-info-service";
import { GET as buildV2 } from "../../../../src/api/build-info/v2/route";
import { GET as detailV3 } from "../../../../src/api/admin/orders/[id]/effective-v3/route";
import { GET as detailAliasV3 } from "../../../../src/api/platform/admin/orders/[id]/effective-v3/route";
import { GET as dashboardV3 } from "../../../../src/api/admin/dashboard/creator-sales-v3/route";
import { GET as dashboardAliasV3 } from "../../../../src/api/platform/admin/dashboard/creator-sales-v3/route";
import { GET as recreateV3 } from "../../../../src/api/orders/[id]/effective-recreate-prefill-v3/route";
import { paymentFeeCapabilityRouteManifestV1 } from "../services/runtime-capability-route-manifest";
import { assertPaymentFeeWriteHttpContractV1, paymentFeeReadHttpContractV1 } from "../../../../src/lib/payment-fee-http-contract";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as schema from "../db/schema";
const identity = { BUILD_SOURCE_COMMIT: "0123456789abcdef0123456789abcdef01234567",
  BUILD_RELEASE_ID: "snus-2.3.0-candidate", BUILD_COMPATIBILITY_FAMILY: "snus-runtime-v1" };
const feeTokens = ["ordersRead:v5", "orderDetail:v3", "orderRecreate:v3", "csvRead:v5", "dashboardRead:v3", "paymentFeeWrite:v1"];
const legacyWriteTokens = ["checkoutWrite:v1", "paymentWrite:v1"];
const feeLayers = ["BUILD_FEE_ROUTE_CAPABILITIES", "BUILD_FEE_CONFIG_CAPABILITIES", "BUILD_FEE_DATABASE_CAPABILITIES"] as const;
const legacyLayers = ["BUILD_ROUTE_CAPABILITIES", "BUILD_CONFIG_CAPABILITIES", "BUILD_DATABASE_CAPABILITIES"] as const;
// Unit inputs exercise the real compiled intersection; they do not attest any running deployment.
const completeEnvironment = { ...identity,
  ...Object.fromEntries(feeLayers.map(field => [field, feeTokens.join(",")])),
  ...Object.fromEntries(legacyLayers.map(field => [field, legacyWriteTokens.join(",")])),
};
describe("separate fee readiness attestation", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it("advertises compiled fee writes only with all fee and legacy writer prerequisites", () => {
    expect(getBuildInfoV2("medusa", completeEnvironment).paymentFeeCapabilities).toEqual({
      ordersRead: ["v5"], orderDetail: ["v3"], orderRecreate: ["v3"], csvRead: ["v5"], dashboardRead: ["v3"], paymentFeeWrite: ["v1"],
    });
    expect(getBuildInfoV2("medusa", identity).paymentFeeCapabilities.paymentFeeWrite).toEqual([]);
    expect(getBuildInfo("medusa", completeEnvironment)).toEqual(getBuildInfo("medusa", {
      ...identity, ...Object.fromEntries(legacyLayers.map(field => [field, legacyWriteTokens.join(",")])),
    }));
  });
  it.each(feeLayers.flatMap(field => feeTokens.map(token => ({ field, token }))))(
    "denies fee writes when $token is missing from $field", ({ field, token }) => {
      expect(getBuildInfoV2("medusa", { ...completeEnvironment, [field]: feeTokens.filter(value => value !== token).join(",") })
        .paymentFeeCapabilities.paymentFeeWrite).toEqual([]);
    },
  );
  it.each(legacyLayers.flatMap(field => legacyWriteTokens.map(token => ({ field, token }))))(
    "denies fee writes when legacy prerequisite $token is missing from $field", ({ field, token }) => {
      const build = getBuildInfoV2("medusa", { ...completeEnvironment, [field]: legacyWriteTokens.filter(value => value !== token).join(",") });
      expect(build.paymentFeeCapabilities.paymentFeeWrite).toEqual([]);
      expect(build.paymentFeeCapabilities.orderDetail).toEqual(["v3"]);
    },
  );
  it.each(["checkout", "payment_intent", "correction"] as const)(
    "uses actual compiled readiness for %s admission and preserves read recovery with admission off", family => {
      for (const [name, value] of Object.entries(completeEnvironment)) vi.stubEnv(name, value);
      const sale = { items: [{ variantId: "v-a", quantity: 1 }], paymentMethod: "cash", amountReceived: 2000,
        paymentFeeType: "percent", paymentFeeValue: 2, cartConfirmationToken: "a".repeat(64) };
      const body = Object.freeze(family === "payment_intent" ? { provider: "mock", order: sale }
        : family === "correction" ? { baseRevision: 0, reason: "Correct entered quantity", items: sale.items } : sale);
      const bytes = JSON.stringify(body), headers = { "x-order-financial-contract": "orders.payment-fee.v1" };
      const response = { setHeader: vi.fn() };
      expect(assertPaymentFeeWriteHttpContractV1({ body, headers }, response as never, family)).toBe("orders.payment-fee.v1");
      expect(JSON.stringify(body)).toBe(bytes);
      expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
      expect(response.setHeader).toHaveBeenCalledWith("x-order-financial-contract", "orders.payment-fee.v1");
      vi.stubEnv("BUILD_FEE_CONFIG_CAPABILITIES", feeTokens.filter(token => token !== "paymentFeeWrite:v1").join(","));
      response.setHeader.mockClear();
      let denial: unknown;
      try { assertPaymentFeeWriteHttpContractV1({ body, headers }, response as never, family); } catch (error) { denial = error; }
      expect(denial).toMatchObject({ code: "feature_unavailable", statusCode: 503 });
      expect(response.setHeader).not.toHaveBeenCalledWith("x-order-financial-contract", "orders.payment-fee.v1");
      expect(paymentFeeReadHttpContractV1({ headers }, response as never)).toBe("orders.payment-fee.v1");
      expect(JSON.stringify(body)).toBe(bytes);
      expect(assertPaymentFeeWriteHttpContractV1({ body: { items: [] }, headers: {} }, response as never, family)).toBe("legacy");
    },
  );
  it("advertises only physically compiled routes present in every fee layer without changing V1", () => {
    const environment = { ...identity, BUILD_FEE_ROUTE_CAPABILITIES: "orderDetail:v3,paymentFeeWrite:v1",
      BUILD_FEE_CONFIG_CAPABILITIES: "orderDetail:v3,paymentFeeWrite:v1",
      BUILD_FEE_DATABASE_CAPABILITIES: "orderDetail:v3,paymentFeeWrite:v1" };
    const legacy = getBuildInfo("medusa", identity);
    expect(getBuildInfo("medusa", environment)).toEqual(legacy);
    expect(getBuildInfoV2("medusa", environment)).toEqual({ ...legacy, schemaVersion: 2,
      paymentFeeCapabilities: { ordersRead: [], orderDetail: ["v3"], orderRecreate: [], csvRead: [], dashboardRead: [], paymentFeeWrite: [] } });
  });
  it("attests DashboardV3 reads independently and keeps fee writes unavailable without legacy writers", () => {
    const tokens = "ordersRead:v5,orderDetail:v3,orderRecreate:v3,csvRead:v5,dashboardRead:v3,paymentFeeWrite:v1";
    const environment = { ...identity, BUILD_FEE_ROUTE_CAPABILITIES: tokens,
      BUILD_FEE_CONFIG_CAPABILITIES: tokens, BUILD_FEE_DATABASE_CAPABILITIES: tokens };
    expect(getBuildInfoV2("medusa", environment).paymentFeeCapabilities).toEqual({
      ordersRead: ["v5"], orderDetail: ["v3"], csvRead: ["v5"], dashboardRead: ["v3"], orderRecreate: ["v3"], paymentFeeWrite: [],
    });
    expect(getBuildInfoV2("medusa", { ...environment, BUILD_FEE_DATABASE_CAPABILITIES: "ordersRead:v5,orderDetail:v3,csvRead:v5" })
      .paymentFeeCapabilities.dashboardRead).toEqual([]);
    expect(getBuildInfo("medusa", environment)).toEqual(getBuildInfo("medusa", identity));
  });
  it("shares the DashboardV3 platform handler and rejects unauthenticated access before data reads", async () => {
    vi.spyOn(schema, "ensurePlatformSchema").mockResolvedValue(undefined);
    expect(dashboardAliasV3).toBe(dashboardV3);
    const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    await dashboardV3({ headers: {}, query: {} } as never, response as never);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });
  it("rejects unauthenticated recreate V3 access and prevents response caching", async () => {
    vi.spyOn(schema, "ensurePlatformSchema").mockResolvedValue(undefined);
    const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    await recreateV3({ headers: {}, params: { id: "unowned-order" } } as never, response as never);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });
  it.each(["BUILD_FEE_ROUTE_CAPABILITIES", "BUILD_FEE_CONFIG_CAPABILITIES", "BUILD_FEE_DATABASE_CAPABILITIES"] as const)(
    "fails closed on absent/unknown/duplicate %s", (field) => {
      const ready = { ...identity, BUILD_FEE_ROUTE_CAPABILITIES: "orderDetail:v3",
        BUILD_FEE_CONFIG_CAPABILITIES: "orderDetail:v3", BUILD_FEE_DATABASE_CAPABILITIES: "orderDetail:v3" };
      expect(getBuildInfoV2("medusa", { ...ready, [field]: undefined }).paymentFeeCapabilities.orderDetail).toEqual([]);
      expect(() => getBuildInfoV2("medusa", { ...ready, [field]: "orderDetail:v3,orderDetail:v3" })).toThrow(/capability/i);
      expect(() => getBuildInfoV2("medusa", { ...ready, [field]: "unknown:v9" })).toThrow(/capability/i);
    },
  );
  it("serves no-store V2 and maps every advertised compiled fee route to a real implementation", async () => {
    for (const [name, value] of Object.entries({ ...identity, BUILD_FEE_ROUTE_CAPABILITIES: "orderDetail:v3",
      BUILD_FEE_CONFIG_CAPABILITIES: "orderDetail:v3", BUILD_FEE_DATABASE_CAPABILITIES: "orderDetail:v3" })) vi.stubEnv(name, value);
    const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    await buildV2({ headers: {} } as never, response as never);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 2,
      paymentFeeCapabilities: expect.objectContaining({ orderDetail: ["v3"], paymentFeeWrite: [] }) }));
    for (const path of Object.values(paymentFeeCapabilityRouteManifestV1)) expect(existsSync(resolve(process.cwd(), path))).toBe(true);
  });
  it("uses the same detail handler for the platform alias and rejects unauthenticated access", async () => {
    vi.spyOn(schema, "ensurePlatformSchema").mockResolvedValue(undefined);
    expect(detailAliasV3).toBe(detailV3);
    const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    await detailV3({ headers: {}, params: { id: "unowned-order" } } as never, response as never);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).not.toHaveBeenCalledWith(expect.objectContaining({ order: expect.anything() }));
  });
});
