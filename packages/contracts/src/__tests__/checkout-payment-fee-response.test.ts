import { describe, expect, it } from "vitest";
import { CheckoutPaymentFeeResponseV1Schema } from "../checkout-payment-fee";
const receipt = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: {
  orderId: "o-a", orderNumber: "ORD-A", merchantId: "m-a", storeId: "s-a", status: "completed", subtotal: 1200, merchandisePayable: 1200,
  tax: 120, discount: 0, shippingFee: 0, total: 1320, change: 680, paymentMethod: "cash", createdAt: "2026-10-28T10:00:00.000Z",
  items: [{ productId: "p-a", variantId: "v-a", name: "Item", quantity: 1, unitPrice: 1200, lineTotal: 1200 }],
  financial: { schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
    paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200, vatRatePpm: 100_000 },
    components: { taxMode: "inclusive", merchandiseGrossMinor: 1200, discountMinor: 0, merchandiseNetMinor: 1200, shippingMinor: 0,
      merchandiseVatMinor: 109, shippingVatMinor: 0, paymentFeeMinor: 120, paymentFeeVatMinor: 11, vatMinor: 120, unclassifiedMinor: 0, totalMinor: 1320 } },
} };
describe("strict fee-aware checkout receipt", () => {
  it("keeps paid fee amounts explicit and consistent with printed lines", () => {
    expect(CheckoutPaymentFeeResponseV1Schema.parse(receipt)).toEqual(receipt);
  });
  it.each([
    { ...receipt, schemaVersion: 2 }, { ...receipt, data: { ...receipt.data, total: 1200 } },
    { ...receipt, data: { ...receipt.data, financial: undefined } }, { ...receipt, data: { ...receipt.data, metadata: {} } },
    { ...receipt, data: { ...receipt.data, paymentMethod: "bank_transfer" } },
    { ...receipt, data: { ...receipt.data, items: [{ ...receipt.data.items[0], quantity: 2 }] } },
    { ...receipt, data: { ...receipt.data, items: [{ ...receipt.data.items[0], cost: 1 }] } },
    ...["subtotal", "merchandisePayable", "shippingFee", "discount", "tax"].map(key => ({ ...receipt, data: { ...receipt.data, [key]: 1 } })),
  ])("refuses inconsistent, hidden or unversioned amounts: %j", value => {
    expect(CheckoutPaymentFeeResponseV1Schema.safeParse(value).success).toBe(false);
  });
});
