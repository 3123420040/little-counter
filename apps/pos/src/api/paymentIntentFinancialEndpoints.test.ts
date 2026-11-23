import { beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("./client", () => ({ api: client }));
import { createPaymentIntentFinancialV1, fetchPaymentIntentCreationReceiptV1, closePaymentIntentCreationReceiptV1, fetchPaymentIntentFinancialV1, fetchPaymentIntentsFinancialV1, resolvePaymentIntentFinancialV1 } from "./endpoints";
const scope = { scopeKind: "report" as const, merchantId: "m-a", storeIds: ["s-a"] };
const operating = { merchantId: "m-a", storeId: "s-a" };
const intent = { id: "pi/a", merchantId: "m-a", storeId: "s-a", provider: "mock", status: "pending", amount: 1320, currencyCode: "vnd",
  referenceCode: "PIA", paymentUrl: null, qrPayload: null, expiresAt: "2026-10-28T12:00:00.000Z", paidAt: null, completedOrderId: null,
  manualReviewReason: null, createdAt: "2026-10-28T11:00:00.000Z", updatedAt: "2026-10-28T11:00:00.000Z",
  financial: { status: "available", snapshot: { schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
    paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200, vatRatePpm: 100_000 },
    components: { taxMode: "inclusive", merchandiseGrossMinor: 1200, discountMinor: 0, merchandiseNetMinor: 1200, shippingMinor: 0,
      merchandiseVatMinor: 109, shippingVatMinor: 0, paymentFeeMinor: 120, paymentFeeVatMinor: 11, vatMinor: 120, unclassifiedMinor: 0, totalMinor: 1320 } } },
};
const response = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: intent };
const input = { provider: "mock" as const, order: { items: [{ variantId: "variant-a", quantity: 1 }], paymentMethod: "mock", amountReceived: 0,
  paymentFeeType: "percent" as const, paymentFeeValue: 10, cartConfirmationToken: "a".repeat(64) }, idempotencyKey: "confirmed-key" };
beforeEach(() => vi.clearAllMocks());
describe("captured payment intent financial API", () => {
  it("reads the exact intent with explicit report scope, protocol and AbortSignal", async () => {
    const controller = new AbortController(); client.get.mockResolvedValueOnce(response);
    await expect(fetchPaymentIntentFinancialV1("pi/a", scope, controller.signal)).resolves.toEqual(response);
    expect(client.get).toHaveBeenCalledExactlyOnceWith("/api/payment-intents/pi%2Fa", {
      "x-order-financial-contract": "orders.payment-fee.v1", "x-report-merchant-id": "m-a", "x-report-store-ids": "s-a",
    }, controller.signal);
  });
  it.each([
    { data: intent }, { ...response, schemaVersion: 2 }, { ...response, data: { ...intent, id: "foreign-intent" } },
    { ...response, data: { ...intent, merchantId: "foreign" } }, { ...response, data: { ...intent, storeId: "foreign" } },
    { ...response, data: { ...intent, amount: 1200 } }, { ...response, data: { ...intent, financial: undefined } },
  ])("refuses old, foreign or inconsistent replies without a fallback request: %j", async invalid => {
    client.get.mockResolvedValueOnce(invalid);
    await expect(fetchPaymentIntentFinancialV1("pi/a", scope)).rejects.toThrow();
    expect(client.get).toHaveBeenCalledTimes(1);
  });
  it("does not accept a response that completed after its captured scope was aborted", async () => {
    const controller = new AbortController();
    client.get.mockImplementationOnce(async () => { controller.abort(); return response; });
    await expect(fetchPaymentIntentFinancialV1("pi/a", scope, controller.signal)).rejects.toThrow();
  });
  it("validates every list row and keeps count/limit/offset, including an empty later page", async () => {
    const list = { ...response, data: [intent], count: 1, limit: 1, offset: 0 };
    client.get.mockResolvedValueOnce(list);
    await expect(fetchPaymentIntentsFinancialV1({ status: "pending", limit: 1 }, scope)).resolves.toEqual(list);
    client.get.mockResolvedValueOnce({ ...list, data: [{ ...intent, storeId: "foreign" }] });
    await expect(fetchPaymentIntentsFinancialV1({ status: "pending", limit: 1 }, scope)).rejects.toThrow();
    client.get.mockResolvedValueOnce({ ...list, data: [], offset: 9999 });
    await expect(fetchPaymentIntentsFinancialV1({ status: "pending", limit: 1, offset: 9999 }, scope)).resolves.toMatchObject({ count: 1, data: [] });
    client.get.mockResolvedValueOnce({ ...list, data: [{ ...intent, status: "manual_review" }] });
    await expect(fetchPaymentIntentsFinancialV1({ status: "pending", limit: 1 }, scope)).rejects.toThrow();
    client.get.mockResolvedValueOnce({ ...list, limit: 10 });
    await expect(fetchPaymentIntentsFinancialV1({ status: "pending", limit: 1 }, scope)).rejects.toThrow();
  });
  it("sends the original creation body and caller-owned key without injecting resolved totals", async () => {
    const before = JSON.stringify(input); client.post.mockResolvedValueOnce(response);
    await expect(createPaymentIntentFinancialV1(input, operating)).resolves.toEqual(response);
    expect(JSON.stringify(input)).toBe(before);
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/payment-intents", { provider: input.provider, order: input.order }, "confirmed-key", {
      "x-order-financial-contract": "orders.payment-fee.v1", "x-operating-merchant-id": "m-a", "x-operating-store-id": "s-a",
    }, undefined);
  });
  it("rejects another provider or fee descriptor even when the returned snapshot balances", async () => {
    client.post.mockResolvedValueOnce({ ...response, data: { ...intent, provider: "sepay_va" } });
    await expect(createPaymentIntentFinancialV1(input, operating)).rejects.toThrow();
    const changed = { ...response, data: { ...intent, amount: 1440, financial: { status: "available", snapshot: {
      ...intent.financial.snapshot, paymentFee: { ...intent.financial.snapshot.paymentFee, paymentFeeValue: 20 },
      components: { ...intent.financial.snapshot.components, paymentFeeMinor: 240, paymentFeeVatMinor: 22, vatMinor: 131, totalMinor: 1440 },
    } } } };
    client.post.mockResolvedValueOnce(changed);
    await expect(createPaymentIntentFinancialV1(input, operating)).rejects.toThrow();
    expect(client.post).toHaveBeenCalledTimes(2);
  });
  it("binds creation to the dispatched provider/descriptor when the caller changes its draft while awaiting the reply", async () => {
    const draft: Parameters<typeof createPaymentIntentFinancialV1>[0] = { ...input, order: { ...input.order } };
    client.post.mockImplementationOnce(async () => {
      draft.provider = "sepay_va"; draft.order.paymentFeeValue = 20;
      return response;
    });
    await expect(createPaymentIntentFinancialV1(draft, operating)).resolves.toEqual(response);
  });
  it.each(["cancel", "mock-settle"] as const)("uses the confirmed key and scope for %s", async action => {
    client.post.mockResolvedValueOnce(response);
    await expect(resolvePaymentIntentFinancialV1("pi/a", action, "confirmed-key", operating)).resolves.toEqual(response);
    expect(client.post).toHaveBeenCalledExactlyOnceWith(`/api/payment-intents/pi%2Fa/${action}`, {}, "confirmed-key", {
      "x-order-financial-contract": "orders.payment-fee.v1", "x-operating-merchant-id": "m-a", "x-operating-store-id": "s-a",
    }, undefined);
  });
  it("keeps unavailable recovery separate from legacy zero and refuses incomplete input before dispatch", async () => {
    client.get.mockResolvedValueOnce({ ...response, data: { ...intent, financial: { status: "unavailable", reason: "stored_quote_invalid" } } });
    await expect(fetchPaymentIntentFinancialV1("pi/a", scope)).resolves.toMatchObject({ data: { financial: { status: "unavailable" } } });
    await expect(createPaymentIntentFinancialV1({ ...input, order: { ...input.order, paymentFeeValue: undefined } }, operating)).rejects.toThrow();
    expect(client.post).not.toHaveBeenCalled();
    await expect(resolvePaymentIntentFinancialV1("pi/a", "cancel", "", operating)).rejects.toThrow();
    expect(client.post).not.toHaveBeenCalled();
  });
  it.each([{ total: 1 }, { items: [{ variantId: "variant-a", quantity: 1, unitPrice: 1 }] }, { merchantId: "foreign" }])(
    "refuses an unrecognized raw creation field before dispatch: %j", async invalid => {
      await expect(createPaymentIntentFinancialV1({ ...input, order: { ...input.order, ...invalid } }, operating)).rejects.toThrow();
      expect(client.post).not.toHaveBeenCalled();
    });
});

describe("creation receipt recovery transport", () => {
  const requestHash = "a".repeat(64), key = "original-intent-request";
  const recovered = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", requestHash, data: { status: "resolved", intent } };
  it.each(["closed", "resolved"])("uses the explicit close endpoint and binds its %s outcome without a creation fallback", async status => {
    const result = { ...recovered, data: status === "closed" ? { status } : recovered.data };
    client.post.mockResolvedValueOnce(result);
    await expect(closePaymentIntentCreationReceiptV1(requestHash, key, operating)).resolves.toEqual(result);
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/payment-intents/creation-receipt/close", { requestHash }, key, {
      "x-order-financial-contract": "orders.payment-fee.v1", "x-operating-merchant-id": "m-a", "x-operating-store-id": "s-a",
    }, undefined);
    expect(client.get).not.toHaveBeenCalled();
  });
  it("sends only the captured hash/key/scope and validates the owned live intent without a creation fallback", async () => {
    client.post.mockResolvedValueOnce(recovered);
    await expect(fetchPaymentIntentCreationReceiptV1(requestHash, key, operating)).resolves.toEqual(recovered);
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/payment-intents/creation-receipt", { requestHash }, key, {
      "x-order-financial-contract": "orders.payment-fee.v1", "x-operating-merchant-id": "m-a", "x-operating-store-id": "s-a",
    }, undefined);
  });
  it("returns unresolved as a distinct result instead of creating or guessing a new request", async () => {
    client.post.mockResolvedValueOnce({ ...recovered, data: { status: "unresolved" } });
    await expect(fetchPaymentIntentCreationReceiptV1(requestHash, key, operating)).resolves.toMatchObject({ data: { status: "unresolved" } });
    expect(client.post).toHaveBeenCalledOnce(); expect(client.get).not.toHaveBeenCalled();
  });
  it.each([
    { ...recovered, requestHash: "b".repeat(64) }, { ...recovered, schemaVersion: 2 },
    { ...recovered, data: { status: "resolved", intent: { ...intent, merchantId: "foreign" } } },
    { ...recovered, data: { status: "resolved", intent: { ...intent, storeId: "foreign" } } },
    { ...recovered, data: { status: "resolved", intent: { ...intent, metadata: { private: true } } } },
    { ...recovered, data: { status: "not_created" } },
  ])("refuses a stale, foreign or invented receipt outcome with no fallback: %j", async value => {
    client.post.mockResolvedValueOnce(value);
    await expect(fetchPaymentIntentCreationReceiptV1(requestHash, key, operating)).rejects.toThrow();
    expect(client.post).toHaveBeenCalledOnce(); expect(client.get).not.toHaveBeenCalled();
  });
  it("refuses an aborted result after it arrives", async () => {
    const controller = new AbortController();
    client.post.mockImplementationOnce(async () => { controller.abort(); return recovered; });
    await expect(fetchPaymentIntentCreationReceiptV1(requestHash, key, operating, controller.signal)).rejects.toThrow();
  });
  it("rejects missing original keys and malformed hashes before dispatch", async () => {
    await expect(fetchPaymentIntentCreationReceiptV1("invalid", key, operating)).rejects.toThrow();
    await expect(fetchPaymentIntentCreationReceiptV1(requestHash, "", operating)).rejects.toThrow();
    expect(client.post).not.toHaveBeenCalled();
  });
});
