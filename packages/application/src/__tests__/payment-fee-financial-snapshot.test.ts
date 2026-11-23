import { describe, expect, it } from "vitest";
import { calculateOrderTotals, calculateOrderTotalsV2, paymentFeeFinancialSnapshotV1 } from "../services/order-total-service";

describe("authoritative public payment fee snapshot serializer", () => {
  it("leaves fee-free legacy responses without a new financial property", () => {
    expect(paymentFeeFinancialSnapshotV1(calculateOrderTotals(1000, {}, 0))).toBeUndefined();
  });
  it.each(["inclusive", "exclusive"] as const)("serializes %s from frozen context, independent of current VAT", taxMode => {
    const totals = calculateOrderTotalsV2(240_000, { discountPercent: 10, paymentFeeType: "percent", paymentFeeValue: 2 }, 20_000,
      { taxMode, vatRatePpm: 100_000 });
    const previous = process.env.VAT_RATE;
    try {
      process.env.VAT_RATE = "0";
      const result = paymentFeeFinancialSnapshotV1(totals)!;
      expect(result).toMatchObject({ schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
        paymentFee: { paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 216_000, vatRatePpm: 100_000 },
        components: { taxMode, merchandiseGrossMinor: 240_000, discountMinor: 24_000, merchandiseNetMinor: 216_000,
          shippingMinor: 20_000, paymentFeeMinor: 4320, totalMinor: taxMode === "inclusive" ? 240_320 : 264_352 } });
      for (const privateField of ["loyaltyBase", "merchandiseRevenue", "shippingRevenue", "paymentFeeRevenueMinor"]) {
        expect(JSON.stringify(result)).not.toContain(privateField);
      }
    } finally { if (previous === undefined) delete process.env.VAT_RATE; else process.env.VAT_RATE = previous; }
  });
  it("retains explicit zero fee and VAT as a V2 snapshot", () => {
    const result = paymentFeeFinancialSnapshotV1(calculateOrderTotalsV2(1000, { paymentFeeType: "amount", paymentFeeValue: 0 }, 0,
      { taxMode: "inclusive", vatRatePpm: 0 }));
    expect(result).toMatchObject({ calculationVersion: 2, paymentFee: { paymentFeeType: "amount", paymentFeeValue: 0, vatRatePpm: 0 },
      components: { paymentFeeMinor: 0, paymentFeeVatMinor: 0, vatMinor: 0, totalMinor: 1000 } });
  });
  it("refuses a corrupt frozen snapshot instead of recalculating or dropping the surcharge", () => {
    const totals = calculateOrderTotalsV2(1000, { paymentFeeType: "percent", paymentFeeValue: 10 }, 0,
      { taxMode: "inclusive", vatRatePpm: 100_000 });
    for (const invalid of [{ ...totals, total: 1000 }, { ...totals, paymentFeeMinor: 0 }, { ...totals, paymentFeeRevenueMinor: 0 }]) {
      expect(() => paymentFeeFinancialSnapshotV1(invalid)).toThrow("Frozen fee-aware");
    }
  });
});
