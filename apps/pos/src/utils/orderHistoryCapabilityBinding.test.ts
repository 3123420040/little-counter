import { describe, expect, it } from "vitest";
import { selectRuntimeCapabilities } from "./runtimeCapabilitySelector";
import { bindOrderHistoryCapabilities } from "./orderHistoryCapabilityBinding";

const identity = {
  service: "medusa" as const,
  sourceCommit: "1234567890abcdef1234567890abcdef12345678",
  releaseId: "release-v1.9",
  compatibilityFamily: "snus-runtime-v1" as const,
};

const fullCapabilities = {
  ordersRead: ["v2", "v3", "v4"] as const,
  orderDetail: ["v1", "v2"] as const,
  orderRecreate: ["v1", "v2"] as const,
  checkoutWrite: ["v1"] as const,
  paymentWrite: ["v1"] as const,
  dashboardRead: ["v1"] as const,
};

describe("API-08 order history capability binding", () => {
  it("uses a trusted fee-aware V5 read without falling back to legacy page versions", () => {
    const runtime = selectRuntimeCapabilities({ status: "received", body: { ...identity,
      capabilities: { ...fullCapabilities, ordersRead: [] } } });
    expect(bindOrderHistoryCapabilities(runtime, true)).toMatchObject({ effectivePageEnabled: true,
      legacyOrdersEnabled: false, explicitUnavailable: false });
  });
  it("uses V4 only for a trusted V4 handshake", () => {
    const runtime = selectRuntimeCapabilities({
      status: "received",
      body: { ...identity, capabilities: fullCapabilities },
    });
    expect(bindOrderHistoryCapabilities(runtime)).toEqual({
      effectivePageEnabled: true,
      legacyOrdersEnabled: false,
      capabilityPending: false,
      v2Compatibility: false,
      explicitUnavailable: false,
    });
  });

  it("uses V2 only as explicit compatibility mode", () => {
    const runtime = selectRuntimeCapabilities({
      status: "received",
      body: {
        ...identity,
        capabilities: { ...fullCapabilities, ordersRead: ["v2"] },
      },
    });
    expect(bindOrderHistoryCapabilities(runtime)).toEqual({
      effectivePageEnabled: false,
      legacyOrdersEnabled: true,
      capabilityPending: false,
      v2Compatibility: true,
      explicitUnavailable: false,
    });
  });

  it.each([
    ["V3 without creator-filter contract", selectRuntimeCapabilities({ status: "received", body: { ...identity, capabilities: { ...fullCapabilities, ordersRead: ["v2", "v3"] } } })],
    ["unreachable", selectRuntimeCapabilities({ status: "unreachable" })],
    ["invalid", selectRuntimeCapabilities({ status: "received", body: { ...identity, extra: true } })],
    ["family mismatch", selectRuntimeCapabilities({
      status: "received",
      body: { ...identity, compatibilityFamily: "wrong-family", capabilities: fullCapabilities },
    })],
  ])("blocks both V3 and legacy reads for %s handshakes", (_label, runtime) => {
    expect(bindOrderHistoryCapabilities(runtime)).toMatchObject({
      effectivePageEnabled: false,
      legacyOrdersEnabled: false,
      capabilityPending: false,
      v2Compatibility: false,
      explicitUnavailable: true,
    });
  });
});
