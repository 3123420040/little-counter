import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe("legacy cart preview VAT compatibility", () => {
  it.each(["inclusive", "exclusive"])("preserves explicit zero VAT in %s mode", async mode => {
    vi.resetModules(); vi.stubEnv("VITE_TAX_MODE", mode); vi.stubEnv("VITE_VAT_RATE", "0");
    const { previewCartTotals } = await import("./cartTotals");
    expect(previewCartTotals(240000, { discountType: "percent", discountValue: 10, shippingFee: 20000 }).payable).toBe(236000);
  });
  it("rounds exclusive merchandise and shipping VAT separately like checkout", async () => {
    vi.resetModules(); vi.stubEnv("VITE_TAX_MODE", "exclusive"); vi.stubEnv("VITE_VAT_RATE", "0.1");
    const { previewCartTotals } = await import("./cartTotals");
    expect(previewCartTotals(5, { discountType: "percent", discountValue: 0, shippingFee: 5 }).payable).toBe(12);
  });
});
