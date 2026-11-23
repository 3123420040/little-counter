import { describe, expect, it } from "vitest";
import { assertMerchantMutationTarget, assertOperatingMutationTarget } from "../services/mutation-scope-service";

const merchantA = { scopeKind: "merchant_target" as const, merchantId: "merchant_a" };
const storeA = { scopeKind: "operating" as const, merchantId: "merchant_a", storeId: "store_a", stockLocationId: "sloc_a" };

describe("business mutation target scope assertions", () => {
  it("rejects merchant A writes to merchant B catalog and customer targets", () => {
    expect(() => assertMerchantMutationTarget(merchantA, { merchantId: "merchant_b" }, "Product")).toThrow(/outside the authorized mutation scope/);
    expect(() => assertMerchantMutationTarget(merchantA, { merchantId: "merchant_b" }, "Customer")).toThrow(/outside the authorized mutation scope/);
  });

  it("rejects store A writes to store B orders and journals", () => {
    expect(() => assertOperatingMutationTarget(storeA, { merchantId: "merchant_a", storeId: "store_b" }, "Order")).toThrow(/outside the authorized mutation scope/);
    expect(() => assertOperatingMutationTarget(storeA, { merchantId: "merchant_a", storeId: "store_b" }, "Journal entry")).toThrow(/outside the authorized mutation scope/);
  });

  it("allows a merchant-wide journal only inside the selected merchant", () => {
    expect(() => assertOperatingMutationTarget(storeA, { merchantId: "merchant_a", storeId: null }, "Journal entry")).not.toThrow();
    expect(() => assertOperatingMutationTarget(storeA, { merchantId: "merchant_b", storeId: null }, "Journal entry")).toThrow(/outside the authorized mutation scope/);
  });
});
