import { describe, expect, it } from "vitest";
import { calculatePurchaseOrderSuggestion } from "../index.js";

describe("Purchase order recommendation logic", () => {
  it("uses the stronger recent velocity and adds reorder safety stock", () => {
    const suggested = calculatePurchaseOrderSuggestion({
      sold7Days: 14,
      sold30Days: 30,
      currentStock: 10,
      openPurchaseOrderQuantity: 0,
      reorderLevel: 5,
      preferredStock: 20,
      coverageDays: 30,
    });

    // max(14/7, 30/30) = 2/day; ceil(2 * 30) + 5 - 10 = 55
    expect(suggested).toBe(55);
  });

  it("subtracts current stock and open purchase-order quantities", () => {
    const suggested = calculatePurchaseOrderSuggestion({
      sold7Days: 7,
      sold30Days: 30,
      currentStock: 12,
      openPurchaseOrderQuantity: 8,
      reorderLevel: 5,
      preferredStock: 20,
      coverageDays: 30,
    });

    // 1/day * 30 + 5 - 12 - 8 = 15
    expect(suggested).toBe(15);
  });

  it("falls back to preferred stock when there are no 30-day sales", () => {
    const suggested = calculatePurchaseOrderSuggestion({
      sold7Days: 0,
      sold30Days: 0,
      currentStock: 6,
      openPurchaseOrderQuantity: 4,
      reorderLevel: 5,
      preferredStock: 20,
    });

    expect(suggested).toBe(10);
  });

  it("never returns a negative suggestion", () => {
    const suggested = calculatePurchaseOrderSuggestion({
      sold7Days: 1,
      sold30Days: 3,
      currentStock: 100,
      openPurchaseOrderQuantity: 20,
      reorderLevel: 5,
      preferredStock: 20,
      coverageDays: 30,
    });

    expect(suggested).toBe(0);
  });

  it("rounds fractional velocity coverage up to whole units", () => {
    const suggested = calculatePurchaseOrderSuggestion({
      sold7Days: 3,
      sold30Days: 5,
      currentStock: 1,
      openPurchaseOrderQuantity: 0,
      reorderLevel: 2,
      preferredStock: 20,
      coverageDays: 14,
    });

    // max(3/7, 5/30) * 14 = 6; +2 -1 = 7
    expect(suggested).toBe(7);
  });
});
