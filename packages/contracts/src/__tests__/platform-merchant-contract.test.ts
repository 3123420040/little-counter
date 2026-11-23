import { describe, expect, it } from "vitest";
import { createPlatformMerchantSchema } from "../platform-merchant";

const input = {
  displayName: "Merchant mới", storeName: "Cửa hàng chính",
  timezone: "Asia/Ho_Chi_Minh", ownerOperatorId: "existing_owner",
};

describe("platform merchant creation contract", () => {
  it("normalizes bounded names and accepts a real explicit timezone", () => {
    expect(createPlatformMerchantSchema.parse({ ...input, displayName: "  Merchant mới  " }))
      .toEqual(input);
  });

  it.each([
    { timezone: "Mars/Olympus_Mons" }, { timezone: "" }, { timezone: undefined },
    { displayName: "A" }, { displayName: "a".repeat(121) }, { storeName: "a\nb" },
    { ownerOperatorId: "" }, { merchantId: "victim" }, { roleKey: "platform_admin" },
  ])("rejects invalid input and caller-controlled authority: %j", (invalid) => {
    expect(createPlatformMerchantSchema.safeParse({ ...input, ...invalid }).success).toBe(false);
  });
});
