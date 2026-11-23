// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { ApiError } from "../api/client";
import { replayQueuedSale } from "./offlineSaleReplay";
import { reviewedOfflineShiftPayload } from "./offlineCheckoutReview";
import type { QueuedSale } from "./offlineQueue";
const scope = { merchantId: "m", storeId: "A", stockLocationId: "stock-A", operatorId: "op", accessEpoch: "epoch", capabilityVersion: "v1" };
const access = { ...scope, merchantIds: ["m"], storeIds: ["A", "B"], selectedMerchantId: "m", selectedStoreId: "A" };
const sale: QueuedSale = {
  id: "same-key", status: "queued", createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", scope,
  payload: { items: [{ variantId: "citrus", quantity: 3 }], paymentMethod: "bank_transfer", amountReceived: 690000,
    idempotencyKey: "same-key", shiftId: "shift", shiftOpenedAt: "2026-09-07T00:00:00.000Z", shiftAttribution: "online_open_shift",
    bankTransferSettlementAcknowledgment: { policyVersion: 1, acknowledgmentVersion: 1 } },
};
describe("queued checkout replay", () => {
  it.each(["cart_quote_changed", "validation_error", "unsupported_contract", "variant_price_unavailable"])("keeps the captured quote/key for %s and requires review without resubmitting", async code => {
    const queued: QueuedSale = { ...sale, payload: { ...sale.payload, paymentFeeType: "percent", paymentFeeValue: 2, cartConfirmationToken: "a".repeat(64) } };
    const captured = JSON.stringify(queued), send = vi.fn().mockRejectedValue(new ApiError("Cần xem lại bản tính", 409, code));
    expect(await replayQueuedSale(queued, access, send)).toMatchObject({ accepted: false, review: true, code });
    expect(send).toHaveBeenCalledExactlyOnceWith(queued.payload, queued.scope);
    expect(JSON.stringify(queued)).toBe(captured);
  });
  it.each([0,2])("keeps fee=%s and the original key byte-identical across a lost response",async paymentFeeValue=>{
    const queued:QueuedSale={...sale,payload:{...sale.payload,paymentFeeType:"percent",paymentFeeValue}};
    const captured=JSON.stringify(queued.payload),send=vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce({});
    expect(await replayQueuedSale(queued,access,send)).toMatchObject({accepted:false,review:false});
    expect(await replayQueuedSale(queued,access,send)).toEqual({accepted:true});
    expect(send.mock.calls.map(([payload])=>JSON.stringify(payload))).toEqual([captured,captured]);
    expect(JSON.stringify(queued.payload)).toBe(captured);
    expect(queued.id).toBe(sale.id);
  });
  it("holds fee-bearing payloads when capability or scope changed without rekeying or stripping the fee",async()=>{
    const queued:QueuedSale={...sale,payload:{...sale.payload,paymentFeeType:"amount",paymentFeeValue:4_320}};
    const captured=JSON.stringify(queued),send=vi.fn();
    expect(await replayQueuedSale(queued,{...access,capabilityVersion:"different"},send)).toMatchObject({accepted:false,review:true,code:"capability_version_changed"});
    expect(await replayQueuedSale(queued,{...access,selectedStoreId:"B"},send)).toMatchObject({accepted:false,review:true,code:"selected_scope_changed"});
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(queued)).toBe(captured);
  });
  it("retains the fee when the known historical shift rewrite is safely reconstructed",async()=>{
    const queued:QueuedSale={...sale,payload:{...sale.payload,paymentFeeType:"amount",paymentFeeValue:4_320,
      shiftAttribution:"offline_cached_shift",queuedAt:sale.createdAt}};
    const captured=JSON.stringify(queued),send=vi.fn().mockRejectedValueOnce(new ApiError("conflict",409,"idempotency_conflict")).mockResolvedValueOnce({});
    expect(await replayQueuedSale(queued,access,send)).toEqual({accepted:true});
    expect(send.mock.calls[1][0]).toEqual({...sale.payload,paymentFeeType:"amount",paymentFeeValue:4_320});
    expect(JSON.stringify(queued)).toBe(captured);
  });
  it("holds a definite closed-shift refusal then allows explicitly reviewed cached attribution with the same key", async () => {
    const send = vi.fn().mockRejectedValueOnce(new ApiError("Online sale shift must be open", 409, "invalid_shift")).mockResolvedValueOnce({});
    const result = await replayQueuedSale(sale, access, send);
    expect(result).toMatchObject({ accepted: false, review: true, code: "invalid_shift" });
    const payload = reviewedOfflineShiftPayload({ ...sale, lastErrorCode: "invalid_shift" });
    expect(payload).toEqual({ ...sale.payload, shiftAttribution: "offline_cached_shift", queuedAt: sale.createdAt });
    expect(await replayQueuedSale({ ...sale, payload }, access, send)).toEqual({ accepted: true });
    expect(send.mock.calls[1][0].idempotencyKey).toBe(sale.id);
  });
  it("does not repair shift attribution after an uncertain transport result", () => {
    expect(reviewedOfflineShiftPayload(sale)).toBe(sale.payload);
    expect(reviewedOfflineShiftPayload({ ...sale, lastErrorCode: "idempotency_conflict" })).toBe(sale.payload);
  });
  it.each(["manual_bank_confirmation_disabled", "shift_required", "shift_offline_not_allowed"])("holds %s for visible staff review", async (code) => {
    expect(await replayQueuedSale(sale, access, vi.fn().mockRejectedValue(new ApiError("Unavailable", 409, code))))
      .toMatchObject({ accepted: false, review: true, code });
  });
  it("retries byte-identical body and captured scope after a lost response", async () => {
    const snapshot = JSON.stringify(sale.payload);
    const send = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce({ status: 200 });
    expect(await replayQueuedSale(sale, access, send)).toMatchObject({ accepted: false, review: false });
    expect(await replayQueuedSale(sale, access, send)).toEqual({ accepted: true });
    expect(send.mock.calls.map(([body]) => JSON.stringify(body))).toEqual([snapshot, snapshot]);
    expect(send.mock.calls[1][1]).toEqual(scope);
    expect(JSON.stringify(sale.payload)).toBe(snapshot);
  });
  it("never sends A's queued acknowledgment to selected B", async () => {
    const send = vi.fn();
    expect(await replayQueuedSale(sale, { ...access, selectedStoreId: "B" }, send)).toMatchObject({ accepted: false, review: true, code: "selected_scope_changed" });
    expect(send).not.toHaveBeenCalled();
  });
  it("retains stale acknowledgment and key until explicit staff review", async () => {
    const send = vi.fn().mockRejectedValue(new ApiError("changed", 409, "checkout_policy_refresh_required"));
    expect(await replayQueuedSale(sale, access, send)).toMatchObject({ accepted: false, review: true });
    expect(sale.payload.bankTransferSettlementAcknowledgment?.policyVersion).toBe(1);
    expect(sale.payload.idempotencyKey).toBe("same-key");
  });
  it("recovers the known old shift rewrite only after a committed-key conflict", async () => {
    const legacy = { ...sale, payload: { ...sale.payload, shiftAttribution: "offline_cached_shift" as const, queuedAt: "2026-09-07T01:00:00.000Z" } };
    const send = vi.fn().mockRejectedValueOnce(new ApiError("conflict", 409, "idempotency_conflict")).mockResolvedValueOnce({});
    expect(await replayQueuedSale(legacy, access, send)).toEqual({ accepted: true });
    expect(send.mock.calls[1][0]).toEqual(sale.payload);
    expect(legacy.payload.queuedAt).toBeDefined();
  });
});
