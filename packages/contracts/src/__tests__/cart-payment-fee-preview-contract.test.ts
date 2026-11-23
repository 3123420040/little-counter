import { describe, expect, it } from "vitest";
import { CartPaymentFeePreviewInputV1Schema, CartPaymentFeePreviewV1Schema } from "../cart-payment-fee-preview";
const input = { items: [{ variantId: "v-a", quantity: 1 }], paymentFeeType: "percent", paymentFeeValue: 10 };
const preview = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: { merchantId: "m-a", storeId: "s-a", input, confirmationToken: "a".repeat(64),
  items: [{ variantId: "v-a", productId: "p-a", sku: "SKU", name: "Item", quantity: 1, unitPrice: 1200, lineTotal: 1200, stock: 5 }],
  financial: { schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
    paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200, vatRatePpm: 100_000 },
    components: { taxMode: "inclusive", merchandiseGrossMinor: 1200, discountMinor: 0, merchandiseNetMinor: 1200, shippingMinor: 0,
      merchandiseVatMinor: 109, shippingVatMinor: 0, paymentFeeMinor: 120, paymentFeeVatMinor: 11, vatMinor: 120, totalMinor: 1320, unclassifiedMinor: 0 } } } };
describe("server cart payment fee preview contract", () => {
  it("requires an opaque server confirmation before a preview can authorize checkout", () => {
    const { confirmationToken: _token, ...unconfirmed } = preview.data;
    expect(CartPaymentFeePreviewV1Schema.safeParse({ ...preview, data: unconfirmed }).success).toBe(false);
    expect(CartPaymentFeePreviewV1Schema.safeParse({ ...preview, data: { ...preview.data, confirmationToken: "wrong" } }).success).toBe(false);
  });
  it("preserves original inputs without injected defaults or resolved client amounts", () => {
    expect(CartPaymentFeePreviewInputV1Schema.parse(input)).toEqual(input);
    expect(CartPaymentFeePreviewV1Schema.parse(preview)).toEqual(preview);
  });
  it.each([
    { ...input, total: 1 }, { ...input, taxMode: "inclusive" }, { ...input, merchantId: "foreign" },
    { ...input, paymentFeeBasisMinor: 1000 }, { ...input, paymentFeeValue: 2.501 }, { ...input, paymentFeeValue: undefined },
    { ...input, paymentFeeType: "amount", paymentFeeValue: 0.5 }, { ...input, shippingFee: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, items: [] }, { ...input, items: [...input.items, ...input.items] },
    { ...input, items: [{ variantId: "v-a", quantity: 0 }] }, { ...input, items: [{ ...input.items[0], unitPrice: 1 }] },
    { ...input, discountType: "percent" }, { ...input, discountType: "amount", discountValue: 0.5 },
    { ...input, discountType: "amount", discountValue: 10, discountPercent: 10 },
  ])("rejects unknown, ambiguous or unsafe cart input: %j", invalid => {
    expect(CartPaymentFeePreviewInputV1Schema.safeParse(invalid).success).toBe(false);
  });
  it.each([
    { ...preview, schemaVersion: 2 }, { ...preview, data: { ...preview.data, metadata: {} } },
    { ...preview, data: { ...preview.data, input: { ...input, paymentFeeValue: 20 } } },
    { ...preview, data: { ...preview.data, input: { ...input, discountPercent: 10 } } },
    { ...preview, data: { ...preview.data, input: { ...input, shippingFee: 1 } } },
    { ...preview, data: { ...preview.data, items: [{ ...preview.data.items[0], variantId: "foreign" }] } },
    { ...preview, data: { ...preview.data, items: [{ ...preview.data.items[0], quantity: 2 }] } },
    { ...preview, data: { ...preview.data, items: [{ ...preview.data.items[0], unitPrice: 1 }] } },
  ])("rejects a preview detached from its requested cart: %j", invalid => {
    expect(CartPaymentFeePreviewV1Schema.safeParse(invalid).success).toBe(false);
  });
});
