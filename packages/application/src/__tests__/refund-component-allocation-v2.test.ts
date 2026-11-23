import { describe, expect, it } from "vitest";
import {
  splitRefundComponentsV2,
  freezeRefundAllocationV2,
  readFrozenRefundAllocationV2,
  zeroRefundComponentsV2,
} from "../services/refund-component-allocation";

describe("bounded V2 refund component allocation", () => {
  const frozenFixture = () => {
    const capacities = {
      merchandiseRevenueMinor: 196_364,
      shippingRevenueMinor: 18_182,
      paymentFeeRevenueMinor: 3_927,
      vatMinor: 21_847,
    };
    const reversalComponents = {
      merchandiseRevenueMinor: 98_182,
      shippingRevenueMinor: 9_091,
      paymentFeeRevenueMinor: 1_963,
      vatMinor: 10_924,
    };
    return freezeRefundAllocationV2({
      schemaVersion: 2,
      amountMinor: 120_260,
      reversalComponents,
      settlementOnlyMinor: 100,
      payableAllocations: [
        {
          payableId: "00000000-0000-4000-8000-000000000001",
          payableKind: "negative_correction",
          commercialRevisionId: "00000000-0000-4000-8000-000000000003",
          componentVersion: 2,
          basisFingerprint: "a".repeat(64),
          sourceType: "correction",
          sourceId: "c1",
          amountMinor: 100,
          reversalComponents: zeroRefundComponentsV2(),
        },
        {
          payableId: "00000000-0000-4000-8000-000000000002",
          payableKind: "manual_refund",
          commercialRevisionId: "00000000-0000-4000-8000-000000000003",
          componentVersion: 2,
          basisFingerprint: "a".repeat(64),
          sourceType: "manual_refund",
          sourceId: "r1",
          amountMinor: 120_160,
          reversalComponents,
          basisCapacities: capacities,
          remainingBefore: capacities,
        },
      ],
      obligationAllocations: [
        {
          obligationId: "00000000-0000-4000-8000-000000000004",
          amountMinor: 120_260,
        },
      ],
    });
  };
  it("freezes a mixed settlement/reversal envelope and validates its immutable fingerprint", () => {
    const frozen = frozenFixture();
    expect(
      readFrozenRefundAllocationV2(JSON.parse(JSON.stringify(frozen))),
    ).toEqual(frozen);
    expect(() =>
      readFrozenRefundAllocationV2({ ...frozen, fingerprint: "b".repeat(64) }),
    ).toThrow();
    expect(() =>
      readFrozenRefundAllocationV2({ ...frozen, unexpected: true }),
    ).toThrow();
  });
  it("rejects unbalanced, altered split, unsafe lineage and settlement-only revenue", () => {
    const frozen = frozenFixture();
    const { fingerprint, ...body } = frozen;
    expect(() =>
      freezeRefundAllocationV2({ ...body, amountMinor: 120_261 }),
    ).toThrow();
    expect(() =>
      freezeRefundAllocationV2({
        ...body,
        reversalComponents: {
          ...body.reversalComponents,
          paymentFeeRevenueMinor: 1_964,
        },
      }),
    ).toThrow();
    expect(() =>
      freezeRefundAllocationV2({
        ...body,
        obligationAllocations: [
          ...body.obligationAllocations,
          ...body.obligationAllocations,
        ],
      }),
    ).toThrow();
    const parts = structuredClone(body.payableAllocations);
    parts[0]!.reversalComponents.paymentFeeRevenueMinor = 1;
    expect(() =>
      freezeRefundAllocationV2({ ...body, payableAllocations: parts }),
    ).toThrow();
    const changed = structuredClone(body.payableAllocations);
    changed[1]!.remainingBefore!.paymentFeeRevenueMinor = 4_000;
    expect(() =>
      freezeRefundAllocationV2({ ...body, payableAllocations: changed }),
    ).toThrow();
  });
  it("O6 assigns VAT first and the final payment takes every remaining unit", () => {
    const capacity = {
      merchandiseRevenueMinor: 196_364,
      shippingRevenueMinor: 18_182,
      paymentFeeRevenueMinor: 3_927,
      vatMinor: 21_847,
    };
    const first = splitRefundComponentsV2(120_160, capacity);
    expect(first).toEqual({
      merchandiseRevenueMinor: 98_182,
      shippingRevenueMinor: 9_091,
      paymentFeeRevenueMinor: 1_963,
      vatMinor: 10_924,
    });
    expect(
      splitRefundComponentsV2(120_160, {
        merchandiseRevenueMinor: 98_182,
        shippingRevenueMinor: 9_091,
        paymentFeeRevenueMinor: 1_964,
        vatMinor: 10_923,
      }),
    ).toEqual({
      merchandiseRevenueMinor: 98_182,
      shippingRevenueMinor: 9_091,
      paymentFeeRevenueMinor: 1_964,
      vatMinor: 10_923,
    });
    expect(Object.values(first).reduce((s, v) => s + v, 0)).toBe(120_160);
  });
  it("resolves fractional ties goods, then shipping, then fee", () => {
    const capacity = {
      merchandiseRevenueMinor: 1,
      shippingRevenueMinor: 1,
      paymentFeeRevenueMinor: 1,
      vatMinor: 0,
    };
    expect(splitRefundComponentsV2(1, capacity)).toEqual({
      merchandiseRevenueMinor: 1,
      shippingRevenueMinor: 0,
      paymentFeeRevenueMinor: 0,
      vatMinor: 0,
    });
    expect(splitRefundComponentsV2(2, capacity)).toEqual({
      merchandiseRevenueMinor: 1,
      shippingRevenueMinor: 1,
      paymentFeeRevenueMinor: 0,
      vatMinor: 0,
    });
  });
  it("handles tax-only, fee-only, zero and large safe capacities", () => {
    expect(
      splitRefundComponentsV2(1, {
        merchandiseRevenueMinor: 0,
        shippingRevenueMinor: 0,
        paymentFeeRevenueMinor: 0,
        vatMinor: 2,
      }),
    ).toEqual({
      merchandiseRevenueMinor: 0,
      shippingRevenueMinor: 0,
      paymentFeeRevenueMinor: 0,
      vatMinor: 1,
    });
    expect(
      splitRefundComponentsV2(1, {
        merchandiseRevenueMinor: 0,
        shippingRevenueMinor: 0,
        paymentFeeRevenueMinor: 2,
        vatMinor: 0,
      }).paymentFeeRevenueMinor,
    ).toBe(1);
    expect(
      splitRefundComponentsV2(0, {
        merchandiseRevenueMinor: 0,
        shippingRevenueMinor: 0,
        paymentFeeRevenueMinor: 0,
        vatMinor: 0,
      }),
    ).toEqual({
      merchandiseRevenueMinor: 0,
      shippingRevenueMinor: 0,
      paymentFeeRevenueMinor: 0,
      vatMinor: 0,
    });
    expect(
      splitRefundComponentsV2(4_503_599_627_370_496, {
        merchandiseRevenueMinor: 9_007_199_254_740_990,
        shippingRevenueMinor: 0,
        paymentFeeRevenueMinor: 0,
        vatMinor: 1,
      }),
    ).toEqual({
      merchandiseRevenueMinor: 4_503_599_627_370_495,
      shippingRevenueMinor: 0,
      paymentFeeRevenueMinor: 0,
      vatMinor: 1,
    });
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 11])(
    "rejects invalid payout%s",
    (amount) => {
      expect(() =>
        splitRefundComponentsV2(amount, {
          merchandiseRevenueMinor: 5,
          shippingRevenueMinor: 2,
          paymentFeeRevenueMinor: 2,
          vatMinor: 1,
        }),
      ).toThrow();
    },
  );
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects invalid/overflowing capacity%s",
    (paymentFeeRevenueMinor) => {
      expect(() =>
        splitRefundComponentsV2(1, {
          merchandiseRevenueMinor: 1,
          shippingRevenueMinor: 1,
          paymentFeeRevenueMinor,
          vatMinor: 1,
        }),
      ).toThrow();
    },
  );
  it("exhaustively conserves every small capacity and sequential remainder", () => {
    for (let goods = 0; goods <= 3; goods++)
      for (let shipping = 0; shipping <= 3; shipping++)
        for (let fee = 0; fee <= 3; fee++)
          for (let vat = 0; vat <= 3; vat++) {
            const capacity = {
              merchandiseRevenueMinor: goods,
              shippingRevenueMinor: shipping,
              paymentFeeRevenueMinor: fee,
              vatMinor: vat,
            };
            const total = goods + shipping + fee + vat;
            for (let amount = 0; amount <= total; amount++) {
              const result = splitRefundComponentsV2(amount, capacity);
              expect(Object.values(result).reduce((s, v) => s + v, 0)).toBe(
                amount,
              );
              const remaining = { ...capacity };
              for (const key of Object.keys(capacity) as Array<
                keyof typeof capacity
              >) {
                expect(Number.isSafeInteger(result[key])).toBe(true);
                expect(result[key]).toBeGreaterThanOrEqual(0);
                expect(result[key]).toBeLessThanOrEqual(capacity[key]);
                remaining[key] -= result[key];
              }
              expect(
                splitRefundComponentsV2(total - amount, remaining),
              ).toEqual(remaining);
              expect(splitRefundComponentsV2(amount, capacity)).toEqual(result);
            }
          }
  });
});
