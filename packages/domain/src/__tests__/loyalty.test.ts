import { describe, expect, it } from "vitest";
import { calculateLoyaltyPoints, evaluateTier, pointsToNextTier } from "../index.js";
import type { LoyaltyTier } from "@medusa-snus/contracts";

const DEFAULT_TIERS: LoyaltyTier[] = [
  { name: "bronze", pointsThreshold: 0, discountPercent: 0 },
  { name: "silver", pointsThreshold: 100, discountPercent: 2 },
  { name: "gold", pointsThreshold: 500, discountPercent: 5 },
  { name: "platinum", pointsThreshold: 1000, discountPercent: 10 },
];

describe("Loyalty Calculations", () => {
  describe("calculateLoyaltyPoints", () => {
    it("calculates points based on order total at default rate", () => {
      expect(calculateLoyaltyPoints(250000)).toBe(25);
      expect(calculateLoyaltyPoints(10000)).toBe(1);
      expect(calculateLoyaltyPoints(5000)).toBe(0);
    });

    it("rounds down fractional points", () => {
      expect(calculateLoyaltyPoints(15999)).toBe(1);
      expect(calculateLoyaltyPoints(19999)).toBe(1);
      expect(calculateLoyaltyPoints(20000)).toBe(2);
    });

    it("supports custom points per VND rate", () => {
      expect(calculateLoyaltyPoints(200000, 5000)).toBe(40);
      expect(calculateLoyaltyPoints(200000, 100000)).toBe(2);
    });

    it("rejects negative order totals", () => {
      expect(() => calculateLoyaltyPoints(-1000)).toThrow("Order total must be non-negative");
    });

    it("returns 0 points for zero order total", () => {
      expect(calculateLoyaltyPoints(0)).toBe(0);
    });
  });

  describe("evaluateTier", () => {
    it("returns bronze for 0 points", () => {
      expect(evaluateTier(0, DEFAULT_TIERS)).toBe("bronze");
    });

    it("returns bronze just below silver threshold", () => {
      expect(evaluateTier(99, DEFAULT_TIERS)).toBe("bronze");
    });

    it("returns silver at threshold", () => {
      expect(evaluateTier(100, DEFAULT_TIERS)).toBe("silver");
    });

    it("returns silver just below gold threshold", () => {
      expect(evaluateTier(499, DEFAULT_TIERS)).toBe("silver");
    });

    it("returns gold at threshold", () => {
      expect(evaluateTier(500, DEFAULT_TIERS)).toBe("gold");
    });

    it("returns gold just below platinum threshold", () => {
      expect(evaluateTier(999, DEFAULT_TIERS)).toBe("gold");
    });

    it("returns platinum at threshold", () => {
      expect(evaluateTier(1000, DEFAULT_TIERS)).toBe("platinum");
    });

    it("returns platinum well above threshold", () => {
      expect(evaluateTier(5000, DEFAULT_TIERS)).toBe("platinum");
    });

    it("works with custom tier thresholds", () => {
      const customTiers: LoyaltyTier[] = [
        { name: "bronze", pointsThreshold: 0, discountPercent: 0 },
        { name: "silver", pointsThreshold: 50, discountPercent: 3 },
        { name: "gold", pointsThreshold: 200, discountPercent: 8 },
      ];
      expect(evaluateTier(30, customTiers)).toBe("bronze");
      expect(evaluateTier(60, customTiers)).toBe("silver");
      expect(evaluateTier(250, customTiers)).toBe("gold");
    });
  });

  describe("pointsToNextTier", () => {
    it("returns distance to next tier when one exists", () => {
      expect(pointsToNextTier(50, DEFAULT_TIERS)).toBe(50);
      expect(pointsToNextTier(400, DEFAULT_TIERS)).toBe(100);
      expect(pointsToNextTier(800, DEFAULT_TIERS)).toBe(200);
    });

    it("returns null when at max tier", () => {
      expect(pointsToNextTier(1500, DEFAULT_TIERS)).toBeNull();
    });

    it("returns null when above all thresholds", () => {
      expect(pointsToNextTier(10000, DEFAULT_TIERS)).toBeNull();
    });
  });
});
