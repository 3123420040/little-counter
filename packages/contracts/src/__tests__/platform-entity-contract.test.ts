import { describe, expect, it } from "vitest";
import {
  PlatformMerchantDetailV1Schema,
  PlatformStoreDetailV1Schema,
} from "../platform-entity";

const at = "2026-10-26T00:00:00.000Z",
  audit = { data: [], offset: 0, limit: 20, hasMore: false };
const store = {
  storeId: "store-a",
  merchantId: "merchant-a",
  merchantName: "A",
  internalName: "Store A",
  isPrimary: true,
  stockLocationId: "stock-a",
  createdAt: at,
  status: "closed",
  statusVersion: 1,
  merchantStatus: "suspended",
  effectiveStatus: "closed",
  lifecycleAudit: audit,
};
const { lifecycleAudit, ...storeSummary } = store;
const merchant = {
  merchantId: "merchant-a",
  displayName: "A",
  packageKey: "basic",
  subscriptionStatus: "expired",
  storeCount: 1,
  ownerCount: 0,
  createdAt: at,
  status: "suspended",
  statusVersion: 1,
  stores: [storeSummary],
  owners: [],
  checkoutPolicy: {
    status: "ok",
    enabled: true,
    version: 0,
    source: "default",
    updatedAt: null,
    updatedBy: null,
  },
  lifecycleAudit: audit,
};
describe("platform entity detail whitelist and compatibility", () => {
  it("distinguishes lifecycle, subscription and parent/child states", () => {
    expect(PlatformMerchantDetailV1Schema.parse(merchant)).toEqual(merchant);
    expect(PlatformStoreDetailV1Schema.parse(store)).toEqual(store);
  });
  it.each([
    { ...merchant, metadata: { secret: "synthetic-canary" } },
    {
      ...merchant,
      owners: [{ operatorId: "a", password_hash: "synthetic-canary" }],
    },
    {
      ...merchant,
      stores: [{ ...storeSummary, secret_hash: "synthetic-canary" }],
    },
    { ...merchant, status: "expired" },
    { ...merchant, statusVersion: 0 },
    { ...merchant, lifecycleAudit: { ...audit, offset: -1 } },
    { ...merchant, lifecycleAudit: { ...audit, limit: 100 } },
    { ...merchant, lifecycleAudit: { ...audit, offset: 100_001 } },
  ])("rejects unknown/private fields and unsupported state: %j", (value) => {
    expect(PlatformMerchantDetailV1Schema.safeParse(value).success).toBe(false);
  });
  it("rejects an old summary as detail instead of silently rendering missing fields", () => {
    const { stores, owners, checkoutPolicy, lifecycleAudit, ...old } = merchant;
    expect(PlatformMerchantDetailV1Schema.safeParse(old).success).toBe(false);
    const { effectiveStatus, ...incomplete } = store;
    expect(PlatformStoreDetailV1Schema.safeParse(incomplete).success).toBe(
      false,
    );
  });
});
