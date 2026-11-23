import { describe, expect, it } from "vitest";
import {
  RuntimeBuildInfoV1Schema,
  RuntimeCapabilitySetV1Schema,
} from "../runtime-capabilities";

const capabilities = {
  ordersRead: ["v2", "v3"],
  orderDetail: ["v1", "v2"],
  orderRecreate: ["v1", "v2"],
  checkoutWrite: ["v1"],
  paymentWrite: ["v1"],
  dashboardRead: ["v1"],
} as const;

describe("CAP-01 runtime capability contract", () => {
  it("accepts the exact non-secret per-capability build identity", () => {
    expect(RuntimeBuildInfoV1Schema.parse({
      service: "medusa",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      releaseId: "1.9.0-candidate.1",
      compatibilityFamily: "snus-runtime-v1",
      capabilities,
    })).toEqual({
      service: "medusa",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      releaseId: "1.9.0-candidate.1",
      compatibilityFamily: "snus-runtime-v1",
      capabilities,
    });
  });

  it("allows an empty fail-closed set but rejects unknown, duplicate and non-canonical versions", () => {
    expect(RuntimeCapabilitySetV1Schema.parse({
      ordersRead: [],
      orderDetail: [],
      orderRecreate: [],
      checkoutWrite: [],
      paymentWrite: [],
      dashboardRead: [],
    })).toBeTruthy();
    expect(RuntimeCapabilitySetV1Schema.parse({
      ...capabilities,
      ordersRead: ["v3"],
      orderDetail: ["v2"],
      orderRecreate: ["v2"],
    })).toMatchObject({
      ordersRead: ["v3"],
      orderDetail: ["v2"],
      orderRecreate: ["v2"],
    });

    for (const invalid of [
      { ...capabilities, ordersRead: ["v3", "v2"] },
      { ...capabilities, ordersRead: ["v2", "v2"] },
      { ...capabilities, ordersRead: ["v2", "v5"] },
      { ...capabilities, globalVersion: "v3" },
    ]) {
      expect(RuntimeCapabilitySetV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects fallback identity, control characters and extra response fields", () => {
    const valid = {
      service: "medusa",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      releaseId: "1.9.0-candidate.1",
      compatibilityFamily: "snus-runtime-v1",
      capabilities,
    };
    expect(RuntimeBuildInfoV1Schema.safeParse({ ...valid, sourceCommit: "unknown" }).success)
      .toBe(false);
    expect(RuntimeBuildInfoV1Schema.safeParse({ ...valid, releaseId: "candidate\nspoof" }).success)
      .toBe(false);
    expect(RuntimeBuildInfoV1Schema.safeParse({ ...valid, token: "secret" }).success)
      .toBe(false);
  });
});
