import { describe, expect, it } from "vitest";
import { readPaymentFeeInput, resolvePaymentFee, vatRatePpmFromRate } from "../services/payment-fee-calculation";

describe("payment fee resolved from discounted merchandise only", () => {
  it.each([[0,0],[0.000123,123],[0.000001,1],[0.29,290_000],[1,1_000_000]])("converts VAT rate%s to integer ppm%i exactly",(rate,ppm)=>{
    expect(vatRatePpmFromRate(rate)).toBe(ppm);
  });
  it.each([0.0000001,0.10000001,NaN,Infinity,-1,1.1])("rejects unrepresentable VAT rate%s",rate=>{
    expect(()=>vatRatePpmFromRate(rate)).toThrow();
  });
  it("does not default or mutate an absent fee request", () => {
    const legacy = { discountPercent: 10, shippingFee: 20_000 };
    const before = JSON.stringify(legacy);
    expect(readPaymentFeeInput(legacy)).toBeUndefined();
    expect(JSON.stringify(legacy)).toBe(before);
    expect(readPaymentFeeInput({ ...legacy, paymentFeeType: "percent", paymentFeeValue: 0 }))
      .toEqual({ paymentFeeType: "percent", paymentFeeValue: 0 });
  });
  it.each([
    { paymentFeeType: "percent" }, { paymentFeeValue: 2 }, { paymentFeeType: "amount", paymentFeeValue: "10" },
    { paymentFeeMinor: 1 }, { paymentFeeBasisMinor: 100 }, { paymentFeeVatMinor: 1 }, { paymentFeeRevenueMinor: 1 },
    { paymentFeeType: "percent", paymentFeeValue: 2, total: 1 }, { paymentFeeTypo: 1 },
  ])("rejects malformed/client-resolved fee fields %j", (value) => {
    expect(() => readPaymentFeeInput(value)).toThrow();
  });
  it.each([
    ["inclusive", 100_000, 393, 3_927],
    ["exclusive", 100_000, 432, 4_320],
    ["inclusive", 0, 0, 4_320], ["exclusive", 0, 0, 4_320],
  ] as const)("resolves O1/O2/O7 %s VAT ppm=%i", (taxMode, vatRatePpm, paymentFeeVatMinor, revenueMinor) => {
    expect(resolvePaymentFee(216_000, { paymentFeeType: "percent", paymentFeeValue: 2 }, { taxMode, vatRatePpm }))
      .toEqual({ paymentFeeType: "percent", paymentFeeValue: 2, paymentFeeBasisMinor: 216_000,
        paymentFeeMinor: 4_320, paymentFeeVatMinor, paymentFeeRevenueMinor: revenueMinor });
  });
  it("allows fixed fee but no percentage fee after 100% discount", () => {
    const context = { taxMode: "inclusive" as const, vatRatePpm: 100_000 };
    expect(resolvePaymentFee(0, { paymentFeeType: "percent", paymentFeeValue: 2 }, context).paymentFeeMinor).toBe(0);
    expect(resolvePaymentFee(0, { paymentFeeType: "amount", paymentFeeValue: 10_000 }, context))
      .toMatchObject({ paymentFeeBasisMinor: 0, paymentFeeMinor: 10_000, paymentFeeVatMinor: 909 });
  });
  it("rounds percent half-up with integer basis points", () => {
    const context = { taxMode: "exclusive" as const, vatRatePpm: 0 };
    expect(resolvePaymentFee(90_001, { paymentFeeType: "percent", paymentFeeValue: 2.5 }, context).paymentFeeMinor).toBe(2_250);
    expect(resolvePaymentFee(25, { paymentFeeType: "percent", paymentFeeValue: 2 }, context).paymentFeeMinor).toBe(1);
    expect(resolvePaymentFee(24, { paymentFeeType: "percent", paymentFeeValue: 2 }, context).paymentFeeMinor).toBe(0);
    expect(resolvePaymentFee(10_000, { paymentFeeType: "percent", paymentFeeValue: 2.01 }, context).paymentFeeMinor).toBe(201);
  });
  it("does not lose safe-integer precision during multiplication", () => {
    expect(resolvePaymentFee(Number.MAX_SAFE_INTEGER, { paymentFeeType: "percent", paymentFeeValue: 99.99 },
      { taxMode: "inclusive", vatRatePpm: 0 }).paymentFeeMinor).toBe(9_006_298_534_815_517);
  });
  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe basis %s", (basis) => {
    expect(() => resolvePaymentFee(basis, { paymentFeeType: "amount", paymentFeeValue: 0 },
      { taxMode: "inclusive", vatRatePpm: 0 })).toThrow();
  });
  it.each([-1, 0.5, NaN, Infinity, 1_000_001])("rejects invalid VAT ppm %s", (vatRatePpm) => {
    expect(() => resolvePaymentFee(100, { paymentFeeType: "amount", paymentFeeValue: 0 },
      { taxMode: "inclusive", vatRatePpm })).toThrow();
  });
});
