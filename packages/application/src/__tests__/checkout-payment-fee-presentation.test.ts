import { describe, expect, it } from "vitest";
import { checkoutPaymentFeeResponseV1 } from "../services/checkout-payment-fee-presentation";
import { calculateOrderTotalsV2, paymentFeeFinancialSnapshotV1 } from "../services/order-total-service";
const totals = calculateOrderTotalsV2(1200, { paymentFeeType: "percent", paymentFeeValue: 10 }, 0, { taxMode: "inclusive", vatRatePpm: 100000 });
const data = { orderId: "o-a", orderNumber: "ORD-A", merchantId: "m-a", storeId: "s-a", status: "completed", createdAt: "2026-10-28T10:00:00.000Z",
  subtotal: 1200, merchandisePayable: 1200, shippingFee: 0, discount: 0, tax: 120, total: 1320, change: 680, paymentMethod: "cash",
  items: [{ productId: "p-a", variantId: "v-a", name: "Item", quantity: 1, unitPrice: 1200, lineTotal: 1200 }], financial: paymentFeeFinancialSnapshotV1(totals) };
describe("public checkout allowlist", () => {
  it("never forwards broad staff, customer, payment evidence or internal revenue fields", () => {
    const reply = checkoutPaymentFeeResponseV1({ data: { ...data, creator: { secret: true }, customer: { private: true }, paymentEntries: [], merchandiseRevenue: 1091 } });
    expect(reply.data).toEqual(data);
    expect(reply).toMatchObject({ schemaVersion: 1, contractVersion: "orders.payment-fee.v1" });
  });
  it("normalizes trusted PostgreSQL integer numeric strings while rejecting null or malformed values", () => {
    expect(checkoutPaymentFeeResponseV1({ data: { ...data, items: [{ ...data.items[0], quantity: "1.000", unitPrice: "1200", lineTotal: "1200.00" }] } }).data.items).toEqual(data.items);
    for (const invalid of [null, "", "not-money", "1.5", "Infinity"]) {
      expect(() => checkoutPaymentFeeResponseV1({ data: { ...data, items: [{ ...data.items[0], unitPrice: invalid }] } })).toThrow();
    }
  });
  it.each([null, { ...data, total: 1 }, { ...data, financial: undefined }])("refuses a missing/corrupt cached response: %j", invalid => {
    expect(() => checkoutPaymentFeeResponseV1({ data: invalid })).toThrow();
  });
});
