// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  clearOfflineState,
  revalidateQueuedSaleAccess,
  type QueuedSale,
} from "./offlineQueue";

const sale = {
  id: "sale-1",
  payload: { idempotencyKey: "sale-1" },
  status: "queued",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  scope: {
    operatorId: "op_a",
    accessEpoch: "epoch-1",
    capabilityVersion: "checkoutWrite:v1",
    merchantId: "merchant_a",
    storeId: "store_a",
    stockLocationId: "sloc_a",
  },
} as QueuedSale;

const access = {
  operatorId: "op_a",
  accessEpoch: "epoch-1",
  capabilityVersion: "checkoutWrite:v1",
  merchantIds: ["merchant_a"],
  storeIds: ["store_a"],
  selectedMerchantId: "merchant_a",
  selectedStoreId: "store_a",
};

describe("offline access partition", () => {
  it("replays only under the exact operator, access epoch, capability and scope", () => {
    expect(revalidateQueuedSaleAccess(sale, access)).toEqual({ ok: true });
    expect(revalidateQueuedSaleAccess(sale, { ...access, operatorId: "op_b" })).toEqual({
      ok: false,
      reason: "operator_changed",
    });
    expect(revalidateQueuedSaleAccess(sale, { ...access, accessEpoch: "epoch-2" })).toEqual({
      ok: false,
      reason: "access_epoch_changed",
    });
    expect(revalidateQueuedSaleAccess(sale, { ...access, capabilityVersion: "checkoutWrite:v2" })).toEqual({
      ok: false,
      reason: "capability_version_changed",
    });
    expect(revalidateQueuedSaleAccess(sale, { ...access, storeIds: ["store_b"] })).toEqual({
      ok: false,
      reason: "scope_no_longer_accessible",
    });
  });

  it("blocks a different selected store even when both stores are accessible", () => {
    expect(revalidateQueuedSaleAccess(sale, { ...access, storeIds: ["store_a", "store_b"], selectedStoreId: "store_b" }))
      .toEqual({ ok: false, reason: "selected_scope_changed" });
    expect(revalidateQueuedSaleAccess(sale, { ...access, selectedStoreId: undefined }))
      .toEqual({ ok: false, reason: "selected_scope_changed" });
  });

  it("purges the complete offline database on session invalidation", async () => {
    const request = {} as IDBOpenDBRequest;
    const deleteDatabase = vi.fn(() => request);
    vi.stubGlobal("indexedDB", { deleteDatabase });

    const clearing = clearOfflineState();
    request.onsuccess?.(new Event("success") as never);

    await expect(clearing).resolves.toBeUndefined();
    expect(deleteDatabase).toHaveBeenCalledWith("snus-pos-offline");
    vi.unstubAllGlobals();
  });
});
