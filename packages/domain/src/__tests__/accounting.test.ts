import { describe, expect, it } from "vitest";
import { calculateCogs, validateJournalEntry, assessRiskLevel } from "../index.js";

describe("Accounting Helpers", () => {
  describe("calculateCogs", () => {
    it("calculates total COGS from multiple items", () => {
      const cogs = calculateCogs([
        { quantity: 2, unitCost: 100000 },
        { quantity: 3, unitCost: 50000 },
      ]);
      expect(cogs).toBe(350000);
    });

    it("returns 0 for empty items array", () => {
      expect(calculateCogs([])).toBe(0);
    });

    it("handles single item", () => {
      expect(calculateCogs([{ quantity: 5, unitCost: 80000 }])).toBe(400000);
    });

    it("handles zero cost items", () => {
      expect(calculateCogs([{ quantity: 10, unitCost: 0 }])).toBe(0);
    });

    it("handles zero quantity items", () => {
      expect(calculateCogs([{ quantity: 0, unitCost: 100000 }])).toBe(0);
    });
  });

  describe("validateJournalEntry", () => {
    it("returns null for balanced entry", () => {
      expect(validateJournalEntry(500000, 500000)).toBeNull();
    });

    it("returns error when debits exceed credits", () => {
      const error = validateJournalEntry(500000, 400000);
      expect(error).toBeTruthy();
      expect(error).toContain("Debits (500000) must equal credits (400000)");
    });

    it("returns error when credits exceed debits", () => {
      const error = validateJournalEntry(300000, 500000);
      expect(error).toBeTruthy();
      expect(error).toContain("Debits (300000) must equal credits (500000)");
    });

    it("returns error for zero entry", () => {
      expect(validateJournalEntry(0, 0)).toBe("Entry cannot be zero");
    });

    it("accepts balanced entry with small amounts", () => {
      expect(validateJournalEntry(100, 100)).toBeNull();
    });

    it("accepts balanced entry with large amounts", () => {
      expect(validateJournalEntry(999999999, 999999999)).toBeNull();
    });
  });
});

describe("Risk Assessment", () => {
  describe("assessRiskLevel", () => {
    it("returns blocked when any blocked claims exist", () => {
      expect(assessRiskLevel({ blockedClaimsCount: 1, confidence: 0.95, isNewCustomer: false })).toBe("blocked");
      expect(assessRiskLevel({ blockedClaimsCount: 5, confidence: 1.0, isNewCustomer: false })).toBe("blocked");
    });

    it("returns high when confidence is very low", () => {
      expect(assessRiskLevel({ blockedClaimsCount: 0, confidence: 0.3, isNewCustomer: false })).toBe("high");
      expect(assessRiskLevel({ blockedClaimsCount: 0, confidence: 0.49, isNewCustomer: false })).toBe("high");
    });

    it("returns medium when confidence is moderate", () => {
      expect(assessRiskLevel({ blockedClaimsCount: 0, confidence: 0.5, isNewCustomer: false })).toBe("medium");
      expect(assessRiskLevel({ blockedClaimsCount: 0, confidence: 0.75, isNewCustomer: false })).toBe("medium");
    });

    it("returns medium for new customer regardless of confidence", () => {
      expect(assessRiskLevel({ blockedClaimsCount: 0, confidence: 0.95, isNewCustomer: true })).toBe("medium");
    });

    it("returns low when confidence is high and not new customer", () => {
      expect(assessRiskLevel({ blockedClaimsCount: 0, confidence: 0.8, isNewCustomer: false })).toBe("low");
      expect(assessRiskLevel({ blockedClaimsCount: 0, confidence: 0.95, isNewCustomer: false })).toBe("low");
      expect(assessRiskLevel({ blockedClaimsCount: 0, confidence: 1.0, isNewCustomer: false })).toBe("low");
    });

    it("blocked takes priority over other factors", () => {
      expect(assessRiskLevel({ blockedClaimsCount: 1, confidence: 1.0, isNewCustomer: false })).toBe("blocked");
    });
  });
});
