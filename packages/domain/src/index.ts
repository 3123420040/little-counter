import type { LoyaltyTier, LoyaltyTierName, RiskLevel } from "@medusa-snus/contracts";

/* ═══════════════════════════════════════════════════════
   @medusa-snus/domain — Pure domain logic, no I/O
   Ported patterns from snus-sale-system
   ═══════════════════════════════════════════════════════ */

// ── Sale Validation ────────────────────────────────────

export interface SaleValidationInput {
  items: Array<{ productId: string; variantId: string; quantity: number; stockLevel: number; unitPrice: number }>;
  paymentMethod: string;
}

export function validateSale(input: SaleValidationInput): string[] {
  const errors: string[] = [];
  if (input.items.length === 0) errors.push("missing_items");
  for (const item of input.items) {
    if (item.quantity <= 0) errors.push("invalid_quantity");
    if (item.quantity > item.stockLevel) errors.push("insufficient_stock");
    if (item.unitPrice < 0) errors.push("invalid_price");
  }
  const validMethods = ["cash", "bank_transfer", "cod"];
  if (!validMethods.includes(input.paymentMethod)) errors.push("invalid_payment_method");
  return [...new Set(errors)];
}

// ── Loyalty Calculations ──────────────────────────────

export function calculateLoyaltyPoints(orderTotal: number, pointsPerVnd: number = 10000): number {
  if (orderTotal < 0) throw new Error("Order total must be non-negative");
  return Math.floor(orderTotal / pointsPerVnd);
}

export function evaluateTier(totalPoints: number, tiers: LoyaltyTier[]): LoyaltyTierName {
  const eligible = tiers
    .filter(t => totalPoints >= t.pointsThreshold)
    .sort((a, b) => b.pointsThreshold - a.pointsThreshold);
  return (eligible[0]?.name ?? "bronze") as LoyaltyTierName;
}

export function pointsToNextTier(totalPoints: number, tiers: LoyaltyTier[]): number | null {
  const next = tiers
    .filter(t => t.pointsThreshold > totalPoints)
    .sort((a, b) => a.pointsThreshold - b.pointsThreshold)[0];
  return next ? next.pointsThreshold - totalPoints : null;
}

// ── Policy Engine — Blocked Claims ────────────────────

export interface BlockedPattern { pattern: RegExp; label: string }

export const DEFAULT_BLOCKED_PATTERNS: BlockedPattern[] = [
  { pattern: /quit smoking/i,        label: "cessation_claim" },
  { pattern: /health benefit/i,      label: "health_benefit_claim" },
  { pattern: /therapeutic/i,          label: "therapeutic_claim" },
  { pattern: /medical/i,              label: "medical_claim" },
  { pattern: /reduced risk/i,         label: "reduced_risk_claim" },
  { pattern: /help you quit/i,        label: "cessation_claim" },
  { pattern: /safer than/i,           label: "safer_than_claim" },
  { pattern: /less harmful/i,         label: "less_harmful_claim" },
];

export function filterBlockedClaims(text: string, patterns: BlockedPattern[] = DEFAULT_BLOCKED_PATTERNS): {
  blocked: boolean; matches: string[];
} {
  const matches: string[] = [];
  for (const { pattern, label } of patterns) {
    if (pattern.test(text)) matches.push(label);
  }
  return { blocked: matches.length > 0, matches };
}

// ── Inventory Alert ────────────────────────────────────

export function shouldTriggerAlert(currentStock: number, reorderLevel: number): boolean {
  return currentStock < reorderLevel;
}

export function calculateReorderQuantity(input: {
  averageWeeklySales: number; leadTimeWeeks: number; safetyStock: number; currentStock: number;
}): number {
  return Math.max(0, (input.averageWeeklySales * input.leadTimeWeeks) + input.safetyStock - input.currentStock);
}

export interface PurchaseOrderSuggestionInput {
  sold7Days: number;
  sold30Days: number;
  currentStock: number;
  openPurchaseOrderQuantity: number;
  reorderLevel: number;
  preferredStock: number;
  coverageDays?: number;
}

export function calculatePurchaseOrderSuggestion(input: PurchaseOrderSuggestionInput): number {
  const coverageDays = Number.isFinite(input.coverageDays) && input.coverageDays && input.coverageDays > 0
    ? input.coverageDays
    : 30;
  const sold7Days = Math.max(0, input.sold7Days);
  const sold30Days = Math.max(0, input.sold30Days);
  const currentStock = Math.max(0, input.currentStock);
  const openPurchaseOrderQuantity = Math.max(0, input.openPurchaseOrderQuantity);
  const reorderLevel = Math.max(0, input.reorderLevel);
  const preferredStock = Math.max(0, input.preferredStock);

  const dailyVelocity7 = sold7Days / 7;
  const dailyVelocity30 = sold30Days / 30;
  const effectiveDailyVelocity = Math.max(dailyVelocity7, dailyVelocity30);
  const targetFromVelocity = Math.ceil(effectiveDailyVelocity * coverageDays) + reorderLevel;
  const targetStock = sold30Days > 0 ? targetFromVelocity : preferredStock;

  return Math.max(0, Math.ceil(targetStock - currentStock - openPurchaseOrderQuantity));
}

// ── Accounting Helpers ─────────────────────────────────

export function calculateCogs(items: Array<{ quantity: number; unitCost: number }>): number {
  return items.reduce((sum, item) => sum + (item.quantity * item.unitCost), 0);
}

export function validateJournalEntry(debits: number, credits: number): string | null {
  if (debits !== credits) return `Debits (${debits}) must equal credits (${credits})`;
  if (debits === 0) return "Entry cannot be zero";
  return null;
}

// ── Risk Assessment ────────────────────────────────────

export function assessRiskLevel(input: { blockedClaimsCount: number; confidence: number; isNewCustomer: boolean }): RiskLevel {
  if (input.blockedClaimsCount > 0) return "blocked";
  if (input.confidence < 0.5) return "high";
  if (input.confidence < 0.8 || input.isNewCustomer) return "medium";
  return "low";
}
