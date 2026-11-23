import { describe, expect, it } from "vitest";
import type { PlatformOperatorDto } from "../../api/settings-endpoints";
import { isEffectivePlatformOperatorGrant } from "./platform-operator-grant-state";

const now = new Date("2026-07-29T10:00:00.000Z");

function grant(overrides: Partial<PlatformOperatorDto["explicitGrants"][number]> = {}) {
  return {
    grantId: "grant-1",
    permissionId: "platform_operator:read",
    scopeType: "platform" as const,
    merchantId: null,
    storeId: null,
    status: "active",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    ...overrides,
  };
}

describe("platform operator explicit grant state", () => {
  it("only treats current active grants as effective", () => {
    expect(isEffectivePlatformOperatorGrant(grant(), now)).toBe(true);
    expect(isEffectivePlatformOperatorGrant(grant({ status: "revoked" }), now)).toBe(false);
    expect(isEffectivePlatformOperatorGrant(grant({ validFrom: "2026-08-01T00:00:00.000Z" }), now)).toBe(false);
    expect(isEffectivePlatformOperatorGrant(grant({ validTo: "2026-07-29T10:00:00.000Z" }), now)).toBe(false);
  });

  it("fails closed for malformed validity", () => {
    expect(isEffectivePlatformOperatorGrant(grant({ validFrom: "invalid" }), now)).toBe(false);
    expect(isEffectivePlatformOperatorGrant(grant({ validTo: "invalid" }), now)).toBe(false);
  });
});
