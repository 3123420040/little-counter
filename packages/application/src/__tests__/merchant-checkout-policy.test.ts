import { describe, expect, it } from "vitest";
import { describeFoundStockPolicy } from "../services/merchant-checkout-policy-service";

describe("merchant found-stock checkout policy", () => {
  it("defaults ON only when the namespace is absent", () => {
    expect(describeFoundStockPolicy({ ownerSettings: { name: "Store" } })).toMatchObject({
      status: "ok", enabled: true, version: 0, source: "default",
    });
  });
  it("preserves configured OFF and its version", () => {
    expect(describeFoundStockPolicy({ foundStockCheckout: {
      enabled: false, version: 2, updatedAt: "2026-10-14T10:00:00Z", updatedBy: "admin",
    } })).toMatchObject({ status: "ok", enabled: false, version: 2, source: "configured" });
  });
  it.each([null, true, [], {}, { enabled: "true" },
    { enabled: true, version: 0, updatedAt: "now", updatedBy: "admin" },
    { enabled: false, version: 1, updatedAt: "now", updatedBy: "admin", extra: true },
  ])("fails closed for a malformed namespace %j", (raw) => {
    expect(describeFoundStockPolicy({ foundStockCheckout: raw })).toMatchObject({
      status: "invalid", enabled: false,
    });
  });
});
