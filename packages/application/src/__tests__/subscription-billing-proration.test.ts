import { describe, expect, it } from "vitest";
import {
  calculateAnnualProration,
  vndPackagePrices,
  makeVndAmount,
} from "@medusa-snus/contracts";

/**
 * Annual billing uses the following remaining-term proration rules.
 *  - Plus → AI Fan upgrade uses remaining-term proration
 *  - Extra store uses VND 1,188,000/year prorated to renewal
 *  - Rounding always favors an integer VND thousand (ceil-to-1000)
 */

const catalogSnapshot = {
  catalogVersionId: "pcv_1_1_2_annual_v1_ai_fan",
  catalogVersion: "1.1.2-annual-v1",
  packageKey: "ai_fan" as const,
  annualPrice: { currencyCode: "vnd" as const, amountVnd: vndPackagePrices.ai_fan },
  includedStores: 5,
  staffLimit: 30,
  researchRunsPerMonth: 500,
  telegramAiDraftsPerMonth: 2000,
  featureKeys: [
    "pos_core", "accounting_core", "telegram_runtime", "sepay_qr_payment", "crypto_payment",
    "smart_cross_sell", "product_research", "telegram_ai_ordering",
  ],
  effectiveFrom: "2026-06-20T00:00:00.000Z",
};

const policySnapshot = {
  policyVersion: "1.1.2-annual-v1",
  billingTerm: "annual",
  graceDays: 7,
  refundPolicy: "no_refund",
  voluntaryDowngradePolicy: "not_allowed",
  roundingMode: "ceil_to_1000_vnd",
};

describe("platform billing proration (frozen policy)", () => {
  it("rejects a downgrade / refund proration (no voluntary downgrade)", () => {
    expect(() =>
      calculateAnnualProration({
        prorationKind: "package_upgrade",
        currentAnnualPrice: makeVndAmount(vndPackagePrices.ai_fan),
        targetAnnualPrice: makeVndAmount(vndPackagePrices.plus),
        currentPeriodStart: "2026-06-20T00:00:00.000Z",
        currentPeriodEnd: "2027-06-20T00:00:00.000Z",
        quoteCreatedAt: "2026-09-20T00:00:00.000Z",
        currentPackageKey: "ai_fan",
        targetPackageKey: "plus",
        catalogSnapshot,
        policySnapshot,
      }),
    ).toThrow(/refund or voluntary downgrade/);
  });

  it("prorates Plus→AI Fan for half the term remaining", () => {
    // Annual delta: 7,188,000 − 3,588,000 = 3,600,000 VND
    // Half-year remaining → 1,800,000 VND (already multiple of 1000)
    const quote = calculateAnnualProration({
      prorationKind: "package_upgrade",
      currentAnnualPrice: makeVndAmount(vndPackagePrices.plus),
      targetAnnualPrice: makeVndAmount(vndPackagePrices.ai_fan),
      currentPeriodStart: "2028-01-01T00:00:00.000Z",
      currentPeriodEnd: "2029-01-01T00:00:00.000Z",
      quoteCreatedAt: "2028-07-02T00:00:00.000Z",
      currentPackageKey: "plus",
      targetPackageKey: "ai_fan",
      catalogSnapshot,
      policySnapshot,
    });
    expect(quote.amount.amountVnd).toBe("1800000");
    expect(quote.roundingIncrementVnd).toBe("1000");
  });

  it("ceil-rounds proration to the nearest VND thousand", () => {
    // Remaining ~1 day of a 365-day year: delta 3,600,000 × 1/365 = 9863.01 → 10000
    const quote = calculateAnnualProration({
      prorationKind: "package_upgrade",
      currentAnnualPrice: makeVndAmount(vndPackagePrices.plus),
      targetAnnualPrice: makeVndAmount(vndPackagePrices.ai_fan),
      currentPeriodStart: "2026-06-20T00:00:00.000Z",
      currentPeriodEnd: "2027-06-20T00:00:00.000Z",
      quoteCreatedAt: "2027-06-19T00:00:00.000Z",
      currentPackageKey: "plus",
      targetPackageKey: "ai_fan",
      catalogSnapshot,
      policySnapshot,
    });
    // 9863 → ceil to 1000 → 10000
    expect(quote.amount.amountVnd).toBe("10000");
  });

  it("prorates an extra store add-on at 1,188,000/year", () => {
    const quote = calculateAnnualProration({
      prorationKind: "store_addon",
      currentAnnualPrice: makeVndAmount("0"),
      targetAnnualPrice: makeVndAmount(vndPackagePrices.extra_store),
      currentPeriodStart: "2028-01-01T00:00:00.000Z",
      currentPeriodEnd: "2029-01-01T00:00:00.000Z",
      quoteCreatedAt: "2028-07-02T00:00:00.000Z",
      currentPackageKey: "plus",
      targetPackageKey: "plus",
      catalogSnapshot,
      policySnapshot,
    });
    // Half-year remaining → 594,000
    expect(quote.amount.amountVnd).toBe("594000");
  });

  it("returns zero proration when no time remains (renewal-only flow)", () => {
    const quote = calculateAnnualProration({
      prorationKind: "package_upgrade",
      currentAnnualPrice: makeVndAmount(vndPackagePrices.plus),
      targetAnnualPrice: makeVndAmount(vndPackagePrices.ai_fan),
      currentPeriodStart: "2026-06-20T00:00:00.000Z",
      currentPeriodEnd: "2027-06-20T00:00:00.000Z",
      quoteCreatedAt: "2027-06-20T00:00:00.000Z", // exactly at period end
      currentPackageKey: "plus",
      targetPackageKey: "ai_fan",
      catalogSnapshot,
      policySnapshot,
    });
    expect(quote.amount.amountVnd).toBe("0");
  });
});
