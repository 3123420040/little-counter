import { beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./client", () => ({ api: client }));
import { previewCartPaymentFeeV1 } from "./endpoints";
const input = { items: [{ variantId: "v-a", quantity: 1 }], paymentFeeType: "percent" as const, paymentFeeValue: 10 };
const scope = { merchantId: "m-a", storeId: "s-a" };
const preview = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: { ...scope, input, confirmationToken: "a".repeat(64),
  items: [{ variantId: "v-a", productId: "p-a", sku: "SKU", name: "Item", quantity: 1, unitPrice: 1200, lineTotal: 1200, stock: 5 }],
  financial: { schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
    paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200, vatRatePpm: 100_000 },
    components: { taxMode: "inclusive", merchandiseGrossMinor: 1200, discountMinor: 0, merchandiseNetMinor: 1200, shippingMinor: 0,
      merchandiseVatMinor: 109, shippingVatMinor: 0, paymentFeeMinor: 120, paymentFeeVatMinor: 11, vatMinor: 120, totalMinor: 1320, unclassifiedMinor: 0 } } } };
beforeEach(() => client.post.mockReset());
describe("captured server cart fee preview", () => {
  it("sends only the captured commercial input/scope and parses a strict authoritative response", async () => {
    const controller = new AbortController(); client.post.mockResolvedValueOnce(preview);
    await expect(previewCartPaymentFeeV1(input, scope, controller.signal)).resolves.toEqual(preview);
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/pos/carts/preview", input, undefined, {
      "x-order-financial-contract": "orders.payment-fee.v1", "x-operating-merchant-id": "m-a", "x-operating-store-id": "s-a",
    }, controller.signal);
  });
  it.each([
    { ...preview, schemaVersion: 2 }, { ...preview, data: { ...preview.data, storeId: "foreign" } },
    { ...preview, data: { ...preview.data, merchantId: "foreign" } },
    { ...preview, data: { ...preview.data, financial: { ...preview.data.financial, paymentFee: { ...preview.data.financial.paymentFee, paymentFeeValue: 20 } } } },
    { ...preview, data: { ...preview.data, input: { ...input, discountPercent: 10 } } },
  ])("refuses detached/invalid previews with no legacy/local fallback: %j", async value => {
    client.post.mockResolvedValueOnce(value);
    await expect(previewCartPaymentFeeV1(input, scope)).rejects.toThrow();
    expect(client.post).toHaveBeenCalledOnce();
  });
  it("captures input values before a caller mutates its draft while waiting", async () => {
    const draft = structuredClone(input);
    client.post.mockImplementationOnce(async () => { draft.paymentFeeValue = 20; return preview; });
    await expect(previewCartPaymentFeeV1(draft, scope)).resolves.toEqual(preview);
    expect(client.post.mock.calls[0][1]).toEqual(input);
  });
  it("refuses a valid but different cart input even when its returned totals still balance", async () => {
    const alternateInput = { ...input, shippingFee: 0 };
    client.post.mockResolvedValueOnce({ ...preview, data: { ...preview.data, input: alternateInput } });
    await expect(previewCartPaymentFeeV1(input, scope)).rejects.toThrow();
  });
  it("does not accept late responses after the captured scope is aborted", async () => {
    const controller = new AbortController();
    client.post.mockImplementationOnce(async () => { controller.abort(); return preview; });
    await expect(previewCartPaymentFeeV1(input, scope, controller.signal)).rejects.toThrow();
  });
  it("rejects resolved input and missing scope before dispatch", async () => {
    await expect(previewCartPaymentFeeV1({ ...input, total: 1 }, scope)).rejects.toThrow();
    await expect(previewCartPaymentFeeV1(input, { merchantId: "m-a", storeId: "" })).rejects.toThrow();
    expect(client.post).not.toHaveBeenCalled();
  });
});
