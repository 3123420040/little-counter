import { describe, expect, it } from "vitest";
import { shouldTriggerAlert, calculateReorderQuantity } from "../index.js";

describe("Inventory Alert Logic", () => {
  describe("shouldTriggerAlert", () => {
    it("triggers alert when stock below reorder level", () => {
      expect(shouldTriggerAlert(3, 5)).toBe(true);
      expect(shouldTriggerAlert(0, 5)).toBe(true);
      expect(shouldTriggerAlert(1, 2)).toBe(true);
    });

    it("does not trigger when stock equals reorder level", () => {
      expect(shouldTriggerAlert(5, 5)).toBe(false);
      expect(shouldTriggerAlert(0, 0)).toBe(false);
    });

    it("does not trigger when stock above reorder level", () => {
      expect(shouldTriggerAlert(10, 5)).toBe(false);
      expect(shouldTriggerAlert(100, 10)).toBe(false);
    });

    it("triggers when stock is 0 and reorder level is > 0", () => {
      expect(shouldTriggerAlert(0, 1)).toBe(true);
    });
  });

  describe("calculateReorderQuantity", () => {
    it("calculates suggested reorder based on sales velocity", () => {
      const quantity = calculateReorderQuantity({
        averageWeeklySales: 10,
        leadTimeWeeks: 2,
        safetyStock: 5,
        currentStock: 3,
      });
      // (10 * 2) + 5 - 3 = 22
      expect(quantity).toBe(22);
    });

    it("returns 0 when current stock covers demand", () => {
      const quantity = calculateReorderQuantity({
        averageWeeklySales: 5,
        leadTimeWeeks: 2,
        safetyStock: 5,
        currentStock: 20,
      });
      // (5 * 2) + 5 - 20 = -5 → max(0, -5) = 0
      expect(quantity).toBe(0);
    });

    it("covers exact demand + safety stock when stock is 0", () => {
      const quantity = calculateReorderQuantity({
        averageWeeklySales: 10,
        leadTimeWeeks: 1,
        safetyStock: 3,
        currentStock: 0,
      });
      // (10 * 1) + 3 - 0 = 13
      expect(quantity).toBe(13);
    });

    it("returns only safety stock when no regular weekly sales", () => {
      const quantity = calculateReorderQuantity({
        averageWeeklySales: 0,
        leadTimeWeeks: 2,
        safetyStock: 5,
        currentStock: 0,
      });
      expect(quantity).toBe(5);
    });

    it("handles zero lead time", () => {
      const quantity = calculateReorderQuantity({
        averageWeeklySales: 10,
        leadTimeWeeks: 0,
        safetyStock: 5,
        currentStock: 3,
      });
      // (10 * 0) + 5 - 3 = 2
      expect(quantity).toBe(2);
    });
  });
});
