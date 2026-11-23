import { describe, expect, it } from "vitest";
import { reconcileAccessibleScope } from "./offlineBootstrapScope";

describe("offline bootstrap accessible scope", () => {
  it("preserves the current reference when bootstrap returns the same scope", () => {
    const current = {
      merchantIds: ["merchant_default"],
      storeIds: ["store_default", "store_uat_a2"],
    };

    expect(reconcileAccessibleScope(current, {
      merchantIds: ["merchant_default"],
      storeIds: ["store_default", "store_uat_a2"],
    })).toBe(current);
  });

  it("returns a new snapshot when bootstrap scope changes", () => {
    const current = {
      merchantIds: ["merchant_default"],
      storeIds: ["store_default"],
    };
    const next = reconcileAccessibleScope(current, {
      merchantIds: ["merchant_default", "merchant_uat_b"],
      storeIds: ["store_default", "store_uat_b"],
    });

    expect(next).not.toBe(current);
    expect(next).toEqual({
      merchantIds: ["merchant_default", "merchant_uat_b"],
      storeIds: ["store_default", "store_uat_b"],
    });
  });
});
