import { describe, expect, it } from "vitest";
import { PaymentIntentFinancialListFiltersV1Schema, PaymentIntentFinancialListResponseV1Schema, PaymentIntentFinancialResponseV1Schema,
  PaymentIntentCreationReceiptInputV1Schema, PaymentIntentCreationReceiptV1Schema, paymentIntentCreationKeyPrefixV1 } from "../payment-intent-financial";
const intent = { id: "pi-a", merchantId: "m-a", storeId: "s-a", provider: "mock", status: "pending", amount: 1320, currencyCode: "vnd",
  referenceCode: "PIA", paymentUrl: null, qrPayload: null, expiresAt: "2026-10-28T12:00:00.000Z", paidAt: null, completedOrderId: null,
  manualReviewReason: null, createdAt: "2026-10-28T11:00:00.000Z", updatedAt: "2026-10-28T11:00:00.000Z",
  financial: { status: "available", snapshot: { schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
    paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200, vatRatePpm: 100_000 },
    components: { taxMode: "inclusive", merchandiseGrossMinor: 1200, discountMinor: 0, merchandiseNetMinor: 1200, shippingMinor: 0,
      merchandiseVatMinor: 109, shippingVatMinor: 0, paymentFeeMinor: 120, paymentFeeVatMinor: 11, vatMinor: 120, unclassifiedMinor: 0, totalMinor: 1320 } } },
};
const response = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: intent };
describe("strict versioned payment intent public responses", () => {
  it("validates the actual payable amount without requiring a current fee-write capability", () => {
    expect(PaymentIntentFinancialResponseV1Schema.parse(response)).toEqual(response);
  });
  it.each([
    { ...response, schemaVersion: 2 }, { ...response, contractVersion: "other" },
    { ...response, data: { ...intent, amount: 1200 } }, { ...response, data: { ...intent, currencyCode: "USD" } },
    { ...response, data: { ...intent, status: "completed" } }, { ...response, data: { ...intent, merchantId: null } },
    { ...response, data: { ...intent, financial: undefined } }, { ...response, data: { ...intent, metadata: { private: true } } },
    { ...response, data: { ...intent, orderInput: {} } }, { ...response, data: { ...intent, amount: Number.MAX_SAFE_INTEGER + 1 } },
    { ...response, data: { ...intent, financial: { status: "legacy", snapshot: intent.financial.snapshot } } },
    { ...response, order: { orderId: "foreign-order" } },
  ])("refuses wrong versions, hidden details, inconsistent amount/identity or fabricated legacy data: %j", value => {
    expect(PaymentIntentFinancialResponseV1Schema.safeParse(value).success).toBe(false);
  });
  it("distinguishes legacy and unavailable snapshots without inventing a zero fee", () => {
    for (const financial of [{ status: "legacy" }, { status: "unavailable", reason: "stored_quote_invalid" }]) {
      expect(PaymentIntentFinancialResponseV1Schema.parse({ ...response, data: { ...intent, financial } }).data.financial).toEqual(financial);
    }
  });
  it("retains empty-page cohort counts and rejects duplicate/impossible rows", () => {
    const list = { ...response, data: [intent], count: 1, limit: 1, offset: 0 };
    expect(PaymentIntentFinancialListResponseV1Schema.parse(list)).toEqual(list);
    expect(PaymentIntentFinancialListResponseV1Schema.parse({ ...list, data: [], offset: 9999 }).count).toBe(1);
    for (const invalid of [{ ...list, data: [intent, intent], limit: 2, count: 2 }, { ...list, count: 0 },
      { ...list, limit: 101 }, { ...list, offset: -1 }, { ...list, data: [intent, { ...intent, id: "pi-b" }], count: 2 }]) {
      expect(PaymentIntentFinancialListResponseV1Schema.safeParse(invalid).success).toBe(false);
    }
  });
  it("accepts only finite supported list filters before numeric coercion", () => {
    expect(PaymentIntentFinancialListFiltersV1Schema.parse({ status: "pending", provider: "mock", limit: "1", offset: "9999" }))
      .toEqual({ status: "pending", provider: "mock", limit: 1, offset: 9999 });
    for (const invalid of [{ status: "other" }, { provider: "card" }, { limit: 101 }, { limit: "" }, { offset: "-1" },
      { offset: "1.5" }, { offset: ["1"] }, { merchantId: "foreign" }, { limit: Number.POSITIVE_INFINITY }]) {
      expect(PaymentIntentFinancialListFiltersV1Schema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("private creation receipt recovery contract", () => {
  const requestHash = "a".repeat(64);
  it("accepts a hash-only request without adding order, operator or pricing defaults", () => {
    expect(PaymentIntentCreationReceiptInputV1Schema.parse({ requestHash })).toEqual({ requestHash });
  });
  it.each([{}, { requestHash: "" }, { requestHash: "A".repeat(64) }, { requestHash: "a".repeat(63) },
    { requestHash: 0 }, { requestHash, items: [] }, { requestHash, operatorId: "other" }, { requestHash, total: 1 }])(
    "refuses malformed hashes or untrusted recovery fields: %j", input => {
      expect(PaymentIntentCreationReceiptInputV1Schema.safeParse(input).success).toBe(false);
    });
  it("distinguishes a known owned intent from an unresolved outcome without inventing a replacement", () => {
    const envelope = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", requestHash };
    expect(PaymentIntentCreationReceiptV1Schema.parse({ ...envelope, data: { status: "unresolved" } }).data).toEqual({ status: "unresolved" });
    expect(PaymentIntentCreationReceiptV1Schema.parse({ ...envelope, data: { status: "closed" } }).data).toEqual({ status: "closed" });
    expect(PaymentIntentCreationReceiptV1Schema.parse({ ...envelope, data: { status: "resolved", intent } }).data).toEqual({ status: "resolved", intent });
    for (const data of [{ status: "resolved" }, { status: "not_created" }, { status: "unresolved", intent },
      { status: "resolved", intent: { ...intent, metadata: { internal: true } } }]) {
      expect(PaymentIntentCreationReceiptV1Schema.safeParse({ ...envelope, data }).success).toBe(false);
    }
  });
  it("binds the versioned key prefix to exact encoded operator/store boundaries", () => {
    expect(paymentIntentCreationKeyPrefixV1("operator:a", "store:a")).toBe("snus-pos-pi-recovery.v1:operator%3Aa:store%3Aa:");
    expect(paymentIntentCreationKeyPrefixV1("operator:a", "store:a")).not.toBe(paymentIntentCreationKeyPrefixV1("operator", "a:store:a"));
  });
});
