import { beforeEach, describe, expect, it, vi } from "vitest";
import { recreatePrefillV3Fixture } from "../../../../packages/application/src/__tests__/fixtures/recreate-prefill";
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./client", () => ({ api }));
import { fetchEffectiveOrderFeatureRecreatePrefillV3 } from "./endpoints";
const fixture = recreatePrefillV3Fixture(), scope = { merchantId: "merchant-a", storeId: "store-a" };
beforeEach(() => { api.get.mockReset(); api.get.mockResolvedValue({ prefill: fixture }); });
describe("captured fee-aware recreate API", () => {
  it("captures operating headers/signal and returns current pricing with scope bound to cart navigation", async () => {
    const signal = new AbortController().signal;
    const result = await fetchEffectiveOrderFeatureRecreatePrefillV3("order-a", scope, signal);
    expect(api.get).toHaveBeenCalledExactlyOnceWith("/api/orders/order-a/effective-recreate-prefill-v3", {
      "x-operating-merchant-id": "merchant-a", "x-operating-store-id": "store-a",
    }, signal);
    expect(result.prefill).toMatchObject({ sourceOrderId: "order-a", sourceScope: scope, customerAttribution: "walk_in", customer: null,
      items: [{ variantId: "variant-a", unitPrice: 1200, originalPrice: 1000, stockLevel: 5 }] });
    expect(JSON.stringify(result)).not.toMatch(/paymentFee|discountMinor|shippingMinor|totalMinor/);
  });
  it.each(["version", "identity", "customer", "source_fee"])("rejects %s drift without retrying V2", async fault => {
    const changed = structuredClone(fixture);
    if (fault === "identity") changed.commercialPrefill.sourceOrder.orderId = "another-order";
    if (fault === "customer") changed.customerAttribution = "linked";
    api.get.mockResolvedValue({ prefill: fault === "version" ? { ...changed, schemaVersion: 2 }
      : fault === "source_fee" ? { ...changed, paymentFeeMinor: 100 } : changed });
    await expect(fetchEffectiveOrderFeatureRecreatePrefillV3("order-a", scope)).rejects.toThrow();
    expect(api.get).toHaveBeenCalledTimes(1);
  });
  it("rejects an absent scope before making a request", async () => {
    await expect(fetchEffectiveOrderFeatureRecreatePrefillV3("order-a", { ...scope, storeId: "" })).rejects.toThrow();
    expect(api.get).not.toHaveBeenCalled();
  });
  it("retains the original scope if the caller changes its object while awaiting HTTP", async () => {
    const supplied = { ...scope };
    api.get.mockImplementation(async () => { supplied.storeId = "changed"; return { prefill: fixture }; });
    const result = await fetchEffectiveOrderFeatureRecreatePrefillV3("order-a", supplied);
    expect(result.prefill.sourceScope).toEqual(scope);
  });
});
