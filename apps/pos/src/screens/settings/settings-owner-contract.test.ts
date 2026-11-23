import { describe, expect, it } from "vitest";
import { resolveSettingsMerchantId } from "./settings-owner-contract";

describe("settings owner merchant resolution", () => {
  it("uses the authoritative merchant returned by /api/me", () => {
    expect(resolveSettingsMerchantId({
      merchant: {
        merchantId: "merchant_uat_b",
        displayName: "Merchant B",
        packageKey: "basic",
        subscriptionStatus: "active",
      },
    })).toBe("merchant_uat_b");
  });

  it("does not invent a merchant target while /api/me has none", () => {
    expect(resolveSettingsMerchantId({ merchant: null })).toBeNull();
    expect(resolveSettingsMerchantId(undefined)).toBeNull();
  });
});
