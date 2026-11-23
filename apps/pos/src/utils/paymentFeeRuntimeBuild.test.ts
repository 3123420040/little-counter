import { describe, expect, it } from "vitest";
import { RuntimeBuildInfoV1Schema, emptyRuntimeCapabilitySetV1, emptyPaymentFeeCapabilitySetV1 } from "@medusa-snus/contracts/runtime-capabilities";
import { selectPaymentFeeRuntimeBuild } from "./paymentFeeRuntimeBuild";
const legacy = RuntimeBuildInfoV1Schema.parse({ service: "medusa", sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  releaseId: "snus-2.3.0-candidate", compatibilityFamily: "snus-runtime-v1", capabilities: emptyRuntimeCapabilitySetV1() });
const fee = { ...legacy, schemaVersion: 2, paymentFeeCapabilities: { ...emptyPaymentFeeCapabilitySetV1(), orderDetail: ["v3"] } };
describe("fee handshake remains bound to the immutable legacy handshake", () => {
  it("accepts the same build and leaves V1 untouched", () => {
    expect(selectPaymentFeeRuntimeBuild(legacy, fee)).toEqual(fee);
    expect(legacy).not.toHaveProperty("paymentFeeCapabilities");
  });
  it.each([null, {}, { ...fee, service: "partner-api" }, { ...fee, sourceCommit: "a".repeat(40) },
    { ...fee, releaseId: "other-release" }, { ...fee, compatibilityFamily: "another-family" },
    { ...fee, capabilities: { ...legacy.capabilities, orderDetail: ["v2"] } },
    { ...fee, paymentFeeCapabilities: { ...fee.paymentFeeCapabilities, paymentFeeWrite: ["v1"] } },
    { ...fee, secret: "not-part-of-a-public-build" },
  ])("does not trust unavailable, malformed or different-replica readiness: %j", (body) => {
    expect(selectPaymentFeeRuntimeBuild(legacy, body)).toBeNull();
  });
  it("cannot trust V2 without a valid V1 identity", () => {
    expect(selectPaymentFeeRuntimeBuild(null, fee)).toBeNull();
  });
});
