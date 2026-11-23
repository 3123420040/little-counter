import { describe, expect, it } from "vitest";
import { OrderPaymentFeeFinancialSnapshotV1Schema } from "../order-payment-fee";

const snapshot = {
  schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
  paymentFee: { paymentFeeType: "percent", paymentFeeValue: 2.5, paymentFeeBasisMinor: 900, vatRatePpm: 100_000 },
  components: { taxMode: "inclusive", merchandiseGrossMinor: 1000, discountMinor: 100, merchandiseNetMinor: 900,
    shippingMinor: 100, merchandiseVatMinor: 82, shippingVatMinor: 9, paymentFeeMinor: 23, paymentFeeVatMinor: 2,
    vatMinor: 93, unclassifiedMinor: 0, totalMinor: 1023 },
};
describe("public frozen payment fee financial snapshot", () => {
  it("retains exact discounted-goods basis and independently rounded inclusive VAT", () => {
    expect(OrderPaymentFeeFinancialSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
  });
  it("accepts exclusive VAT and an explicit zero-VAT rate", () => {
    expect(OrderPaymentFeeFinancialSnapshotV1Schema.parse({ ...snapshot, components: { ...snapshot.components,
      taxMode: "exclusive", merchandiseVatMinor: 90, shippingVatMinor: 10, vatMinor: 102, totalMinor: 1125 } }).components.totalMinor).toBe(1125);
    expect(OrderPaymentFeeFinancialSnapshotV1Schema.parse({ ...snapshot,
      paymentFee: { ...snapshot.paymentFee, vatRatePpm: 0 }, components: { ...snapshot.components,
        merchandiseVatMinor: 0, shippingVatMinor: 0, paymentFeeVatMinor: 0, vatMinor: 0 } }).paymentFee.vatRatePpm).toBe(0);
  });
  it("accepts a fixed fee when discount exhausts the goods basis", () => {
    const zero = { ...snapshot, paymentFee: { ...snapshot.paymentFee, paymentFeeType: "amount", paymentFeeValue: 11, paymentFeeBasisMinor: 0 },
      components: { ...snapshot.components, discountMinor: 1000, merchandiseNetMinor: 0, merchandiseVatMinor: 0,
        shippingMinor: 0, shippingVatMinor: 0, paymentFeeMinor: 11, paymentFeeVatMinor: 1, vatMinor: 1, totalMinor: 11 } };
    expect(OrderPaymentFeeFinancialSnapshotV1Schema.parse(zero)).toEqual(zero);
  });
  it.each([
    { ...snapshot, schemaVersion: 2 }, { ...snapshot, calculationVersion: 1 }, { ...snapshot, currencyCode: "USD" },
    { ...snapshot, minorUnitExponent: 2 }, { ...snapshot, providerSecret: "must-not-leak" },
    { ...snapshot, paymentFee: { ...snapshot.paymentFee, paymentFeeRevenueMinor: 21 } },
    { ...snapshot, paymentFee: { ...snapshot.paymentFee, paymentFeeBasisMinor: 1000 } },
    { ...snapshot, paymentFee: { ...snapshot.paymentFee, paymentFeeValue: 2.501 } },
    { ...snapshot, paymentFee: { ...snapshot.paymentFee, vatRatePpm: 0 } },
    { ...snapshot, components: { ...snapshot.components, paymentFeeMinor: 22, totalMinor: 1022 } },
    { ...snapshot, components: { ...snapshot.components, merchandiseVatMinor: 81, vatMinor: 92 } },
    { ...snapshot, components: { ...snapshot.components, shippingVatMinor: 8, vatMinor: 92 } },
    { ...snapshot, components: { ...snapshot.components, unclassifiedMinor: 1, totalMinor: 1024 } },
    { ...snapshot, components: { ...snapshot.components, totalMinor: Number.MAX_SAFE_INTEGER + 1 } },
  ])("rejects incomplete, internal or inconsistent financial snapshots: %j", invalid => {
    expect(OrderPaymentFeeFinancialSnapshotV1Schema.safeParse(invalid).success).toBe(false);
  });
});
