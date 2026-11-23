import { describe, expect, it } from "vitest";
import {
  POS_RUNTIME_CAPABILITIES_V1,
  resolveCapabilityRequestFailure,
  selectRuntimeCapabilities,
} from "./runtimeCapabilitySelector";

const identity = {
  service: "medusa",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  releaseId: "1.9.0-candidate.1",
  compatibilityFamily: "snus-runtime-v1",
} as const;

function server(capabilities: Record<string, readonly string[]>) {
  return { status: "received" as const, body: { ...identity, capabilities } };
}

const allV3 = {
  ordersRead: ["v2", "v3"],
  orderDetail: ["v1", "v2"],
  orderRecreate: ["v1", "v2"],
  checkoutWrite: ["v1"],
  paymentWrite: ["v1"],
  dashboardRead: ["v1"],
} as const;

describe("CAP-03..09 per-capability negotiation", () => {
  it("keeps pending reads as skeletons and blocks online writes", () => {
    expect(selectRuntimeCapabilities({ status: "pending" }, POS_RUNTIME_CAPABILITIES_V1))
      .toMatchObject({
        handshakeState: "pending",
        trustedForOnlineWrites: false,
        surfaces: {
          ordersRead: "skeleton",
          checkoutWrite: "blocked",
          paymentWrite: "blocked",
          dashboardRead: "skeleton",
        },
      });
  });

  it("selects the highest common version independently for every capability", () => {
    expect(selectRuntimeCapabilities(server(allV3), POS_RUNTIME_CAPABILITIES_V1))
      .toMatchObject({
        handshakeState: "compatible",
        selected: {
          ordersRead: "v3",
          orderDetail: "v2",
          orderRecreate: "v2",
          checkoutWrite: "v1",
          paymentWrite: "v1",
          dashboardRead: "v1",
        },
        surfaces: {
          ordersRead: "v3",
          customerAttribution: "verified",
          customerDependentActions: "enabled",
          orderRecreateCustomerPrefill: "enabled",
          orderDetail: "enabled",
          orderRecreate: "enabled",
          checkoutWrite: "enabled",
          paymentWrite: "enabled",
          dashboardRead: "enabled",
        },
      });
  });

  it("treats common V2 as explicit compatibility and missing customer as unknown", () => {
    const result = selectRuntimeCapabilities(server({
      ...allV3,
      ordersRead: ["v2"],
      orderDetail: ["v1"],
      orderRecreate: ["v1"],
    }), POS_RUNTIME_CAPABILITIES_V1);
    expect(result).toMatchObject({
      handshakeState: "v2_compatibility",
      surfaces: {
        ordersRead: "v2_compatibility",
        customerAttribution: "unknown",
        customerDependentActions: "blocked",
        orderRecreateCustomerPrefill: "blocked",
        checkoutWrite: "enabled",
      },
    });
  });

  it("does not globally block a common checkout write when order read has no common version", () => {
    const result = selectRuntimeCapabilities(server({
      ...allV3,
      ordersRead: [],
    }), POS_RUNTIME_CAPABILITIES_V1);
    expect(result).toMatchObject({
      handshakeState: "partial",
      surfaces: {
        ordersRead: "unavailable",
        customerAttribution: "unavailable",
        customerDependentActions: "blocked",
        orderRecreateCustomerPrefill: "blocked",
        orderDetail: "enabled",
        checkoutWrite: "enabled",
        paymentWrite: "enabled",
        dashboardRead: "enabled",
      },
    });
  });

  it("blocks only the write capability with no common version on a trusted handshake", () => {
    const result = selectRuntimeCapabilities(server({
      ...allV3,
      checkoutWrite: [],
    }), POS_RUNTIME_CAPABILITIES_V1);
    expect(result.trustedForOnlineWrites).toBe(true);
    expect(result.surfaces).toMatchObject({
      ordersRead: "v3",
      checkoutWrite: "blocked",
      paymentWrite: "enabled",
      dashboardRead: "enabled",
    });
  });

  it.each([
    [{ status: "unreachable" as const }, "unreachable"],
    [{ status: "received" as const, body: { ...identity, capabilities: { ...allV3 }, extra: true } }, "invalid"],
    [{ status: "received" as const, body: { ...identity, compatibilityFamily: "other-family", capabilities: allV3 } }, "family_mismatch"],
  ])("fails closed for %s", (handshake, expectedState) => {
    const result = selectRuntimeCapabilities(handshake, POS_RUNTIME_CAPABILITIES_V1);
    expect(result.handshakeState).toBe(expectedState);
    expect(result.trustedForOnlineWrites).toBe(false);
    expect(result.surfaces.checkoutWrite).toBe("blocked");
    expect(result.surfaces.paymentWrite).toBe("blocked");
  });

  it("never turns an endpoint 404 into a version downgrade", () => {
    expect(resolveCapabilityRequestFailure({
      capability: "ordersRead",
      selectedVersion: "v3",
      httpStatus: 404,
    })).toEqual({
      action: "surface_error",
      downgradeTo: null,
      requiresFreshHandshake: true,
    });
  });
});
