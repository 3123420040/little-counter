import { describe, expect, it } from "vitest";
import { calculateOrderTotalsV2, frozenPaymentFeeQuoteContext, totalsFromMetadataV2 } from "../services/order-total-service";
const fee = { paymentFeeType: "percent" as const, paymentFeeValue: 2 };
const inclusive = { taxMode: "inclusive" as const, vatRatePpm: 100_000 };

describe("canonical fee-aware totals, independent O1–O7 oracle", () => {
  it("reads every frozen V2 total without current runtime VAT or a zero fallback",()=>{
    const totals=calculateOrderTotalsV2(240_000,{discountPercent:10,...fee},20_000,inclusive);
    const previous=process.env.VAT_RATE;
    try{
      process.env.VAT_RATE="0";
      expect(totalsFromMetadataV2({...totals,unrelatedOrderMetadata:true})).toEqual(totals);
      for(const invalid of [{...totals,commercialCalculationVersion:1},{...totals,paymentFeeMinor:0},
        {...totals,paymentFeeRevenueMinor:0},{...totals,total:236_000},{...totals,vatRatePpm:0}]){
        expect(()=>totalsFromMetadataV2(invalid)).toThrow("Frozen fee-aware");
      }
    }finally{if(previous===undefined)delete process.env.VAT_RATE;else process.env.VAT_RATE=previous;}
  });
  it("restores only validated frozen V2 context from a persisted quote", () => {
    const input = { discountPercent: 10, shippingFee: 20_000, ...fee };
    const totals = calculateOrderTotalsV2(240_000,input,20_000,inclusive);
    expect(frozenPaymentFeeQuoteContext({quote:{totals}},input)).toEqual({vatRate:0.1,vatRatePpm:100_000,taxMode:"inclusive"});
    expect(frozenPaymentFeeQuoteContext({quote:{totals:{commercialAdjustmentVersion:1}}},{})).toBeUndefined();
    for (const tampered of [{...totals,vatRatePpm:0},{...totals,paymentFeeValue:3},{...totals,commercialCalculationVersion:1},
      {...totals,paymentFeeMinor:4321},{...totals,loyaltyBase:240320}]) {
      expect(()=>frozenPaymentFeeQuoteContext({quote:{totals:tampered}},input)).toThrow();
    }
    expect(()=>frozenPaymentFeeQuoteContext({},input)).toThrow();
    expect(()=>frozenPaymentFeeQuoteContext({quote:{totals}},{...input,paymentFeeValue:3})).toThrow();
    expect(()=>frozenPaymentFeeQuoteContext({quote:{totals}},{...input,shippingFee:1})).toThrow();
    expect(()=>frozenPaymentFeeQuoteContext({quote:{totals}},{...input,discountPercent:20})).toThrow();
  });
  it("keeps integer ppm123 without a floating-point roundtrip",()=>{
    const input={...fee,shippingFee:0},context={taxMode:"inclusive" as const,vatRatePpm:123};
    const totals=calculateOrderTotalsV2(100_000,input,0,context);
    const frozen=frozenPaymentFeeQuoteContext({quote:{totals}},input)!;
    expect(frozen.vatRatePpm).toBe(123);
    expect(calculateOrderTotalsV2(100_000,input,0,{taxMode:frozen.taxMode,vatRatePpm:frozen.vatRatePpm!})).toEqual(totals);
  });
  it.each([{ discountPercent: 10 }, { discountType: "amount" as const, discountValue: 24_000 }])("O1 discount %j", (discount) => {
    expect(calculateOrderTotalsV2(240_000, { ...discount, ...fee }, 20_000, inclusive)).toMatchObject({
      commercialAdjustmentVersion: 2, commercialCalculationVersion: 2, taxMode: "inclusive", vatRatePpm: 100_000,
      discount: 24_000, merchandisePayable: 216_000, paymentFeeBasisMinor: 216_000,
      paymentFeeMinor: 4_320, merchandiseTax: 19_636, shippingTax: 1_818, paymentFeeVatMinor: 393,
      tax: 21_847, total: 240_320, merchandiseRevenue: 196_364, shippingRevenue: 18_182,
      paymentFeeRevenueMinor: 3_927, loyaltyBase: 216_000 });
  });
  it("O2 exclusive VAT", () => {
    expect(calculateOrderTotalsV2(240_000, { discountPercent: 10, ...fee }, 20_000, { ...inclusive, taxMode: "exclusive" }))
      .toMatchObject({ paymentFeeMinor: 4_320, merchandiseTax: 21_600, shippingTax: 2_000,
        paymentFeeVatMinor: 432, tax: 24_032, total: 264_352, loyaltyBase: 216_000 });
  });
  it("O3 rounds each VAT component, not the aggregate", () => {
    expect(calculateOrderTotalsV2(5, { paymentFeeType: "amount", paymentFeeValue: 5 }, 5, { ...inclusive, taxMode: "exclusive" }))
      .toMatchObject({ merchandiseTax: 1, shippingTax: 1, paymentFeeVatMinor: 1, tax: 3, total: 18 });
  });
  it("O4 discount/percent boundaries", () => {
    expect(calculateOrderTotalsV2(100_001, { discountPercent: 10, paymentFeeType: "percent", paymentFeeValue: 2.5 }, 7_000, inclusive))
      .toMatchObject({ discount: 10_000, merchandisePayable: 90_001, paymentFeeMinor: 2_250,
        merchandiseTax: 8_182, shippingTax: 636, paymentFeeVatMinor: 205, tax: 9_023, total: 99_251 });
  });
  it.each([["percent", 2, 0, 20_000], ["amount", 10_000, 10_000, 30_000]] as const)("O5 %s after full discount", (paymentFeeType, paymentFeeValue, paymentFeeMinor, total) => {
    expect(calculateOrderTotalsV2(240_000, { discountPercent: 100, paymentFeeType, paymentFeeValue }, 20_000, inclusive))
      .toMatchObject({ paymentFeeMinor, total, loyaltyBase: 0, paymentFeeBasisMinor: 0 });
  });
  it.each(["inclusive", "exclusive"] as const)("O7 %s VAT0", (taxMode) => {
    expect(calculateOrderTotalsV2(240_000, { discountPercent: 10, ...fee }, 20_000, { taxMode, vatRatePpm: 0 }))
      .toMatchObject({ merchandiseTax: 0, shippingTax: 0, paymentFeeVatMinor: 0, tax: 0, total: 240_320 });
  });
  it.each([[0, 0], [100, 10_000], [0.29, 29], [2.55, 255], [2.01, 201]] as const)("integer basis points %s", (paymentFeeValue, paymentFeeMinor) => {
    expect(calculateOrderTotalsV2(10_000, { paymentFeeType: "percent", paymentFeeValue }, 0, inclusive).paymentFeeMinor).toBe(paymentFeeMinor);
  });
  it("shipping cannot affect the fee basis", () => {
    const first = calculateOrderTotalsV2(240_000, { discountPercent: 10, ...fee }, 20_000, inclusive);
    const second = calculateOrderTotalsV2(240_000, { discountPercent: 10, ...fee }, 1_000, inclusive);
    expect([second.paymentFeeBasisMinor, second.paymentFeeMinor]).toEqual([first.paymentFeeBasisMinor, first.paymentFeeMinor]);
  });
  it.each([-1, 0.5, NaN, Infinity, "1"])("rejects malformed shipping %s", (shipping) => {
    expect(() => calculateOrderTotalsV2(100, fee, shipping, inclusive)).toThrow();
  });
  it("rejects grand total overflow", () => {
    expect(() => calculateOrderTotalsV2(Number.MAX_SAFE_INTEGER, { paymentFeeType: "amount", paymentFeeValue: 0 }, 1, inclusive)).toThrow(/overflow/);
  });
});
