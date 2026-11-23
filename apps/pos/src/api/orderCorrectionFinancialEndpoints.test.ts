import { beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("./client", () => ({ api: client }));
import { fetchOrderCorrectionFinancialContextV1, previewOrderCorrectionFinancialV1, applyOrderCorrectionFinancialV1 } from "./endpoints";
const scope = { merchantId: "m-a", storeId: "s-a" }, token = "a".repeat(64);
const financial = { status: "available", snapshot: { schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
  paymentFee: { paymentFeeType: "percent", paymentFeeValue: 10, paymentFeeBasisMinor: 1200, vatRatePpm: 100000 },
  components: { taxMode: "inclusive", merchandiseGrossMinor: 1200, discountMinor: 0, merchandiseNetMinor: 1200, shippingMinor: 0,
    merchandiseVatMinor: 109, shippingVatMinor: 0, paymentFeeMinor: 120, paymentFeeVatMinor: 11, vatMinor: 120, unclassifiedMinor: 0, totalMinor: 1320 } } };
const envelope = { schemaVersion: 1, contractVersion: "orders.payment-fee.v1" };
const context = { ...envelope, data: { ...scope, orderId: "o/a", baseRevision: 0, componentVersion: 2, commercialState: "active", currencyCode: "VND", minorUnitExponent: 0,
  components: financial.snapshot.components, paymentFee: financial.snapshot.paymentFee,
  items: [{ lineId: "line", productId: "p-a", variantId: "v-a", skuSnapshot: "SKU", titleSnapshot: "Item", quantity: 1, unitPriceMinor: 1200 }] } };
const input = { baseRevision: 0, reason: "Correct entered fee", items: [{ variantId: "v-a", quantity: 1 }], paymentFeeType: "percent" as const, paymentFeeValue: 10,
  settlement: { method: "cash", amountReceived: 120 }, confirmationToken: token };
const preview = { ...envelope, data: { ...scope, orderId: "o/a", baseRevision: 0, nextRevision: 1, confirmationToken: token,
  beforeTotals: { total: 1200 }, afterTotals: { total: 1320 }, totalDelta: 120, cogsDelta: 0,
  beforeFinancial: { status: "legacy" }, afterFinancial: financial,
  settlement: { direction: "collect", method: "cash", amount: 120, status: "posted" },
  items: [{ variantId: "v-a", productId: "p-a", productTitle: "Item", sku: "SKU", quantityBefore: 1, quantityAfter: 1, quantityDelta: 0, unitPrice: 1200, stockDelta: 0, availableStock: 5 }] } };
const applied = { ...envelope, data: { ...scope, orderId: "o/a", correction: { id: "correction", revision: 1, status: "applied", reason: input.reason,
  beforeTotals: preview.data.beforeTotals, afterTotals: preview.data.afterTotals, totalDelta: 120,
  beforeFinancial: preview.data.beforeFinancial, afterFinancial: financial, paymentEntryId: "pay", settlementStatus: "posted" } } };
const headers = { "x-order-financial-contract": "orders.payment-fee.v1", "x-operating-merchant-id": "m-a", "x-operating-store-id": "s-a" };
beforeEach(() => vi.clearAllMocks());
describe("captured financial correction transport", () => {
  it("reads the stored descriptor/revision with exact operating scope and AbortSignal", async () => {
    const controller = new AbortController(); client.get.mockResolvedValueOnce(context);
    await expect(fetchOrderCorrectionFinancialContextV1("o/a", scope, controller.signal)).resolves.toEqual(context);
    expect(client.get).toHaveBeenCalledExactlyOnceWith("/api/platform/admin/orders/o%2Fa/corrections/preview", headers, controller.signal);
  });
  it("previews the original wire body without injecting defaults", async () => {
    const { confirmationToken: _token, ...draft } = input; const before = JSON.stringify(draft); client.post.mockResolvedValueOnce(preview);
    await expect(previewOrderCorrectionFinancialV1("o/a", draft, scope)).resolves.toEqual(preview);
    expect(JSON.stringify(draft)).toBe(before);
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/platform/admin/orders/o%2Fa/corrections/preview", draft, undefined, headers, undefined);
  });
  it("uses the confirmed body/token and caller-owned key for apply", async () => {
    client.post.mockResolvedValueOnce(applied);
    await expect(applyOrderCorrectionFinancialV1("o/a", input, "confirmed-key", scope, preview)).resolves.toEqual(applied);
    expect(client.post).toHaveBeenCalledExactlyOnceWith("/api/platform/admin/orders/o%2Fa/corrections", input, "confirmed-key", headers, undefined);
  });
  it.each(["merchantId", "storeId", "orderId"])("refuses a wrong %s without a legacy fallback", async field => {
    client.get.mockResolvedValueOnce({ ...context, data: { ...context.data, [field]: "foreign" } });
    await expect(fetchOrderCorrectionFinancialContextV1("o/a", scope)).rejects.toThrow(); expect(client.get).toHaveBeenCalledOnce();
    client.post.mockResolvedValueOnce({ ...preview, data: { ...preview.data, [field]: "foreign" } });
    await expect(previewOrderCorrectionFinancialV1("o/a", input, scope)).rejects.toThrow();
    client.post.mockResolvedValueOnce({ ...applied, data: { ...applied.data, [field]: "foreign" } });
    await expect(applyOrderCorrectionFinancialV1("o/a", input, "key", scope, preview)).rejects.toThrow(); expect(client.post).toHaveBeenCalledTimes(2);
  });
  it("refuses malformed, unconfirmed or mismatched commands before dispatch", async () => {
    for (const invalid of [{ ...input, merchantId: "foreign" }, { ...input, confirmationToken: undefined }, { ...input, confirmationToken: "b".repeat(64) }]) {
      await expect(applyOrderCorrectionFinancialV1("o/a", invalid, "key", scope, preview)).rejects.toThrow();
    }
    await expect(applyOrderCorrectionFinancialV1("o/a", input, "", scope, preview)).rejects.toThrow(); expect(client.post).not.toHaveBeenCalled();
  });
  it("refuses stale lines/revision and an unversioned reply", async () => {
    for (const invalid of [{ data: preview.data }, { ...preview, data: { ...preview.data, baseRevision: 1, nextRevision: 2 } },
      { ...preview, data: { ...preview.data, items: [{ ...preview.data.items[0], variantId: "foreign" }] } }]) {
      client.post.mockResolvedValueOnce(invalid); await expect(previewOrderCorrectionFinancialV1("o/a", input, scope)).rejects.toThrow();
    }
    expect(client.post).toHaveBeenCalledTimes(3);
  });
  it("refuses a balanced but different committed result from the confirmed preview", async () => {
    client.post.mockResolvedValueOnce({ ...applied, data: { ...applied.data, correction: { ...applied.data.correction, revision: 2 } } });
    await expect(applyOrderCorrectionFinancialV1("o/a", input, "key", scope, preview)).rejects.toThrow();
  });
  it("rejects an aborted context and captures scope before awaiting", async () => {
    const controller = new AbortController(); client.get.mockImplementationOnce(async () => { controller.abort(); return context; });
    await expect(fetchOrderCorrectionFinancialContextV1("o/a", scope, controller.signal)).rejects.toThrow();
    const changed = { ...scope }; client.get.mockImplementationOnce(async () => { changed.storeId = "foreign"; return context; });
    await expect(fetchOrderCorrectionFinancialContextV1("o/a", changed)).resolves.toEqual(context);
  });
});
