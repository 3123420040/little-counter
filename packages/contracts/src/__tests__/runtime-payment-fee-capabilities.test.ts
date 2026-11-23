import { describe, expect, it } from "vitest";
import {
  RuntimeBuildInfoV1Schema, RuntimeBuildInfoV2Schema,
  emptyRuntimeCapabilitySetV1, emptyPaymentFeeCapabilitySetV1,
  paymentFeeCapabilityTokensV1,
} from "../runtime-capabilities";

const legacy = { service: "medusa", sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  releaseId: "snus-2.3.0-candidate", compatibilityFamily: "snus-runtime-v1", capabilities: emptyRuntimeCapabilitySetV1() };

describe("additive fee-aware runtime handshake", () => {
  it("keeps strict V1 unchanged and carries fee versions only on the explicit V2 transport", () => {
    expect(RuntimeBuildInfoV1Schema.parse(legacy)).toEqual(legacy);
    const v2 = { ...legacy, schemaVersion: 2, paymentFeeCapabilities: { ...emptyPaymentFeeCapabilitySetV1(), orderDetail: ["v3"] } };
    expect(RuntimeBuildInfoV2Schema.parse(v2)).toEqual(v2);
    expect(RuntimeBuildInfoV1Schema.safeParse(v2).success).toBe(false);
    expect(RuntimeBuildInfoV2Schema.safeParse(legacy).success).toBe(false);
  });
  it.each([
    { orderDetail: ["v2"] }, { orderDetail: ["v3", "v3"] }, { csvRead: null },
    { orderDetail: ["v3"], unexpected: [] }, { paymentFeeWrite: ["v1"] },
  ])("rejects unsafe fee capability claims: %j", (patch) => {
    expect(RuntimeBuildInfoV2Schema.safeParse({ ...legacy, schemaVersion: 2,
      paymentFeeCapabilities: { ...emptyPaymentFeeCapabilitySetV1(), ...patch } }).success).toBe(false);
  });
  it("accepts write only alongside every read family and legacy checkout/payment readiness", () => {
    const paymentFeeCapabilities = Object.fromEntries(paymentFeeCapabilityTokensV1.map((token) => {
      const [name, version] = token.split(":"); return [name, [version]];
    }));
    const full = { ...legacy, schemaVersion: 2,
      capabilities: { ...legacy.capabilities, checkoutWrite: ["v1"], paymentWrite: ["v1"] }, paymentFeeCapabilities };
    expect(RuntimeBuildInfoV2Schema.safeParse(full).success).toBe(true);
    expect(RuntimeBuildInfoV2Schema.safeParse({ ...full, capabilities: legacy.capabilities }).success).toBe(false);
  });
});
