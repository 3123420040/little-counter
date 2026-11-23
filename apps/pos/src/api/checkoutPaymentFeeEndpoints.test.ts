import { beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), api: client }));
import { completeSale } from "./endpoints";
import { ApiError } from "./client";
const scope = { merchantId: "m-a", storeId: "s-a" };
const input = { items: [{ variantId: "v-a", quantity: 1 }], paymentMethod: "cash", amountReceived: 2000,
  paymentFeeType: "percent" as const, paymentFeeValue: 10, idempotencyKey: "same-confirmed-key", cartConfirmationToken: "a".repeat(64) };
const receipt = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1", data: { ...scope,
  orderId: "o-a", orderNumber: "ORD-A", status: "completed", subtotal: 1200, merchandisePayable: 1200, shippingFee: 0,
  discount: 0, tax: 120, total: 1320, change: 680, paymentMethod: "cash", createdAt: "2026-10-28T10:00:00.000Z",
  items: [{ variantId: "v-a", productId: "p-a", name: "Item", quantity: 1, unitPrice: 1200, lineTotal: 1200 }],
  financial: { schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
    paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200, vatRatePpm: 100000 },
    components: { taxMode: "inclusive", merchandiseGrossMinor: 1200, discountMinor: 0, merchandiseNetMinor: 1200, shippingMinor: 0,
      merchandiseVatMinor: 109, shippingVatMinor: 0, paymentFeeMinor: 120, paymentFeeVatMinor: 11, vatMinor: 120, unclassifiedMinor: 0, totalMinor: 1320 } },
} };
beforeEach(() => client.post.mockReset());
describe("fee-aware checkout transport", () => {
  it("sends original body/key and exact scope/contract without forcing a fee-free V1 receipt", async () => {
    const bytes = JSON.stringify(input); client.post.mockResolvedValueOnce(receipt);
    await expect(completeSale(input, scope)).resolves.toEqual(receipt);
    expect(JSON.stringify(input)).toBe(bytes);
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/pos/carts/complete", input, input.idempotencyKey, {
      "x-order-financial-contract": "orders.payment-fee.v1", "x-operating-merchant-id": "m-a", "x-operating-store-id": "s-a",
    });
  });
  it.each([
    { data: receipt.data }, { ...receipt, data: { ...receipt.data, total: 1200 } },
    { ...receipt, data: { ...receipt.data, merchantId: "foreign" } }, { ...receipt, data: { ...receipt.data, storeId: "foreign" } },
    { ...receipt, data: { ...receipt.data, change: 0 } },
    { ...receipt, data: { ...receipt.data, items: [{ ...receipt.data.items[0], variantId: "foreign" }] } },
  ])("refuses a stale/wrong paid receipt without fallback: %j", async value => {
    client.post.mockResolvedValueOnce(value);
    await expect(completeSale(input, scope)).rejects.toThrow(); expect(client.post).toHaveBeenCalledOnce();
  });
  it("keeps legacy body/headers/response unchanged and does not add a default fee", async () => {
    const { paymentFeeType: _type, paymentFeeValue: _value, cartConfirmationToken: _token, ...legacy } = input;
    client.post.mockResolvedValueOnce({ data: { orderId: "old" } });
    await expect(completeSale(legacy, scope)).resolves.toEqual({ data: { orderId: "old" } });
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/pos/carts/complete", legacy, legacy.idempotencyKey, {
      "x-operating-merchant-id": "m-a", "x-operating-store-id": "s-a",
    });
  });
  it("rejects missing scope or an unrecognized input before dispatch", async () => {
    await expect(completeSale(input)).rejects.toThrow();
    await expect(completeSale({ ...input, total: 1 } as typeof input, scope)).rejects.toThrow();
    expect(client.post).not.toHaveBeenCalled();
  });
  it("returns an explicit reviewable refusal for a pre-confirmation financial queue without changing its body/key", async () => {
    const { cartConfirmationToken: _token, ...oldQueue } = input;
    const bytes = JSON.stringify(oldQueue);
    await expect(completeSale(oldQueue, scope)).rejects.toBeInstanceOf(ApiError);
    await expect(completeSale(oldQueue, scope)).rejects.toMatchObject({ status: 400, code: "validation_error" });
    expect(client.post).not.toHaveBeenCalled();
    expect(JSON.stringify(oldQueue)).toBe(bytes);
  });
});
