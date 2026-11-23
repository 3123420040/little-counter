import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  calculateOrderTotals,
  normalizeCommercialAdjustment,
  totalsFromMetadata,
  COMMERCIAL_ADJUSTMENT_VERSION,
} from "../services/order-total-service";
import { PlatformError } from "../errors/platform-error";

describe("normalizeCommercialAdjustment", () => {
  it("derives a percent discount from legacy discountPercent", () => {
    const adj = normalizeCommercialAdjustment({ discountPercent: 10 }, 240000);
    expect(adj).toEqual({
      discountType: "percent",
      discountValue: 10,
      discountPercent: 10,
      discount: 24000,
    });
  });

  it("uses explicit discountType/discountValue as authoritative for amount", () => {
    const adj = normalizeCommercialAdjustment({ discountType: "amount", discountValue: 20000 }, 240000);
    expect(adj).toEqual({
      discountType: "amount",
      discountValue: 20000,
      discountPercent: 0,
      discount: 20000,
    });
  });

  it("uses explicit percent discountType with discountValue", () => {
    const adj = normalizeCommercialAdjustment({ discountType: "percent", discountValue: 10 }, 240000);
    expect(adj.discount).toBe(24000);
    expect(adj.discountPercent).toBe(10);
  });

  it("treats missing fields as no discount", () => {
    const adj = normalizeCommercialAdjustment({}, 240000);
    expect(adj.discount).toBe(0);
    expect(adj.discountType).toBe("percent");
  });

  it("rejects fixed discount exceeding subtotal", () => {
    expect(() => normalizeCommercialAdjustment({ discountType: "amount", discountValue: 300000 }, 240000))
      .toThrow(PlatformError);
  });

  it("rejects non-integer fixed discount", () => {
    expect(() => normalizeCommercialAdjustment({ discountType: "amount", discountValue: 20000.5 }, 240000))
      .toThrow(PlatformError);
  });

  it("rejects negative fixed discount", () => {
    expect(() => normalizeCommercialAdjustment({ discountType: "amount", discountValue: -100 }, 240000))
      .toThrow(PlatformError);
  });

  it("rejects percent discount above 100", () => {
    expect(() => normalizeCommercialAdjustment({ discountType: "percent", discountValue: 150 }, 240000))
      .toThrow(PlatformError);
  });
});

describe("calculateOrderTotals", () => {
  beforeEach(() => {
    process.env.VAT_RATE = "0.10";
    process.env.TAX_MODE = "inclusive";
  });
  afterEach(() => {
    delete process.env.VAT_RATE;
    delete process.env.TAX_MODE;
  });

  it("computes inclusive totals with percent discount", () => {
    const totals = calculateOrderTotals(240000, { discountPercent: 10 }, 20000);
    expect(totals.discount).toBe(24000);
    expect(totals.merchandisePayable).toBe(216000);
    expect(totals.shippingFee).toBe(20000);
    expect(totals.total).toBe(216000 + 20000);
    expect(totals.commercialAdjustmentVersion).toBe(COMMERCIAL_ADJUSTMENT_VERSION);
    expect(totals.loyaltyBase).toBe(216000);
    expect(totals.tax).toBeGreaterThan(0);
  });

  it("computes inclusive totals with fixed VND discount", () => {
    const totals = calculateOrderTotals(240000, { discountType: "amount", discountValue: 20000 }, 0);
    expect(totals.discount).toBe(20000);
    expect(totals.merchandisePayable).toBe(220000);
    expect(totals.total).toBe(220000);
    expect(totals.discountType).toBe("amount");
    expect(totals.discountValue).toBe(20000);
    expect(totals.discountPercent).toBe(0);
  });

  it("computes exclusive tax totals", () => {
    process.env.TAX_MODE = "exclusive";
    const totals = calculateOrderTotals(240000, { discountType: "amount", discountValue: 20000 }, 0);
    expect(totals.merchandisePayable).toBe(220000);
    expect(totals.total).toBe(220000 + totals.tax);
    expect(totals.tax).toBeGreaterThan(0);
  });

  it("rounds percent discount to integer VND", () => {
    const totals = calculateOrderTotals(245000, { discountPercent: 10 }, 0);
    expect(totals.discount).toBe(24500);
  });
});

describe("totalsFromMetadata", () => {
  it("reads normalized metadata including fixed discount semantics", () => {
    const totals = totalsFromMetadata({
      commercialAdjustmentVersion: 1,
      discountType: "amount",
      discountValue: 20000,
      discountPercent: 0,
      discount: 20000,
      subtotal: 240000,
      merchandisePayable: 220000,
      shippingFee: 20000,
      total: 240000,
      tax: 2000,
    });
    expect(totals.discountType).toBe("amount");
    expect(totals.discountValue).toBe(20000);
    expect(totals.discount).toBe(20000);
    expect(totals.subtotal).toBe(240000);
  });

  it("falls back to percent for legacy orders", () => {
    const totals = totalsFromMetadata({
      discount: 24000,
      subtotal: 240000,
      discountPercent: 10,
      total: 216000,
    });
    expect(totals.discountType).toBe("percent");
    expect(totals.discount).toBe(24000);
    expect(totals.discountPercent).toBe(10);
  });
});
