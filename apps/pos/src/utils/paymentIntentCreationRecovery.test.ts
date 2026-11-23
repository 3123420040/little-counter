// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPendingPaymentIntentCreations, preservePaymentIntentCreation, removePendingPaymentIntentCreation } from "./paymentIntentCreationRecovery";
const scope = { operatorId: "operator-1", merchantId: "merchant-1", storeId: "store-1" };
const input = { provider: "sepay_va" as const, idempotencyKey: "original-request-1", order: {
  items: [{ variantId: "private-variant", quantity: 1 }], paymentMethod: "sepay_va", amountReceived: 0, customerMode: "walk_in" as const,
  notes: "Synthetic private note", paymentFeeType: "percent" as const, paymentFeeValue: 2, cartConfirmationToken: "a".repeat(64),
} };
beforeEach(() => { localStorage.clear(); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("TextEncoder", TextEncoder); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("private durable intent correlation metadata", () => {
  it("hashes the exact original HTTP body and stores no cart, note, amount, customer or authentication material", async () => {
    const before = JSON.stringify(input), record = await preservePaymentIntentCreation(input, scope);
    expect(record.requestHash).toBe(createHash("sha256").update(JSON.stringify({ provider: input.provider, order: input.order })).digest("hex"));
    expect(Object.keys(record).sort()).toEqual(["schemaVersion", "operatorId", "merchantId", "storeId", "idempotencyKey", "requestHash", "provider", "createdAt"].sort());
    expect(JSON.stringify(record)).not.toMatch(/private-variant|Synthetic private note|amountReceived|cartConfirmationToken|paymentFeeValue|authorization/);
    expect(JSON.stringify(input)).toBe(before);
    expect(listPendingPaymentIntentCreations(scope)).toEqual([record]);
  });
  it("preserves the same immutable record on retry and refuses a changed wire body instead of replacing its hash/key", async () => {
    const write = vi.spyOn(Object.hasOwn(localStorage, "setItem") ? localStorage : Storage.prototype, "setItem"), record = await preservePaymentIntentCreation(input, scope);
    expect(await preservePaymentIntentCreation(input, scope)).toEqual(record);
    expect(write).toHaveBeenCalledOnce();
    await expect(preservePaymentIntentCreation({ ...input, order: { ...input.order, shippingFee: 10 } }, scope)).rejects.toThrow("nội dung khác");
    expect(listPendingPaymentIntentCreations(scope)).toEqual([record]);
  });
  it("survives module reload and session cleanup while staying partitioned by operator, merchant and store", async () => {
    const record = await preservePaymentIntentCreation(input, scope);
    sessionStorage.clear(); localStorage.removeItem("snus_operator"); localStorage.removeItem("snus_auth_state");
    vi.resetModules();
    const reloaded = await import("./paymentIntentCreationRecovery");
    expect(reloaded.listPendingPaymentIntentCreations(scope)).toEqual([record]);
    for (const changed of [{ ...scope, operatorId: "other" }, { ...scope, merchantId: "other" }, { ...scope, storeId: "other" }]) {
      expect(reloaded.listPendingPaymentIntentCreations(changed)).toEqual([]);
    }
  });
  it("does not silently discard a corrupt recovery row or let stale removal delete a changed row", async () => {
    const record = await preservePaymentIntentCreation(input, scope), key = localStorage.key(0)!;
    await expect(preservePaymentIntentCreation(input, { merchantId: scope.merchantId, storeId: scope.storeId })).rejects.toThrow();
    expect(() => removePendingPaymentIntentCreation({ ...record, requestHash: "b".repeat(64) })).toThrow();
    expect(listPendingPaymentIntentCreations(scope)).toEqual([record]);
    localStorage.setItem(key, "corrupt");
    expect(() => listPendingPaymentIntentCreations(scope)).toThrow();
    expect(localStorage.getItem(key)).toBe("corrupt");
  });
  it("refuses unavailable storage or an unverified write instead of pretending recovery is durable", async () => {
    const write = vi.spyOn(Object.hasOwn(localStorage, "setItem") ? localStorage : Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Unavailable", "QuotaExceededError"); });
    await expect(preservePaymentIntentCreation(input, scope)).rejects.toThrow();
    write.mockImplementation(() => undefined);
    await expect(preservePaymentIntentCreation(input, scope)).rejects.toThrow("Chưa lưu được");
  });
  it("removes only the exact captured record without touching another operator's pending result", async () => {
    const original = await preservePaymentIntentCreation(input, scope), otherScope = { ...scope, operatorId: "other" };
    const other = await preservePaymentIntentCreation(input, otherScope);
    removePendingPaymentIntentCreation(original);
    expect(listPendingPaymentIntentCreations(scope)).toEqual([]);
    expect(listPendingPaymentIntentCreations(otherScope)).toEqual([other]);
  });
});
