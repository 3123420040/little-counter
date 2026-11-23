import { ApiError } from "../api/client";
import type { CompleteSaleInput } from "../api/endpoints";
import { revalidateQueuedSaleAccess, type QueuedSale, type ScopeSnapshot, type SyncAccessSummary } from "./offlineQueue";
import { requiresOfflineCheckoutReview } from "./offlineCheckoutReview";

type Transport = (payload: CompleteSaleInput, scope: ScopeSnapshot) => Promise<unknown>;
export type ReplayResult = { accepted: true } | {
  accepted: false; review: boolean; message: string; code?: string; details?: unknown;
};

/** Retry the captured wire body and scope. Queue metadata never changes its idempotency hash. */
export async function replayQueuedSale(sale: QueuedSale, access: SyncAccessSummary, send: Transport): Promise<ReplayResult> {
  const validation = revalidateQueuedSaleAccess(sale, access);
  if (!validation.ok || !sale.scope) return {
    accepted: false, review: true, message: `Không thể đồng bộ trong phiên hiện tại: ${validation.reason}`,
    code: validation.reason,
  };
  try {
    await send(sale.payload, sale.scope);
    return { accepted: true };
  } catch (error) {
    let replayError = error;
    // Pre-fix queues rewrote an already-sent online shift body. Only attempt
    // reconstruction after the server proves this key already exists. A second
    // mismatch still refuses; never mint a new key for an uncertain payment.
    if (error instanceof ApiError && error.code === "idempotency_conflict"
      && sale.payload.shiftAttribution === "offline_cached_shift") {
      const { queuedAt: _queuedAt, ...original } = sale.payload;
      try {
        await send({ ...original, shiftAttribution: "online_open_shift" }, sale.scope);
        return { accepted: true };
      } catch (retryError) { replayError = retryError; }
    }
    return {
      accepted: false,
      review: requiresOfflineCheckoutReview(replayError),
      message: replayError instanceof Error ? replayError.message : "Không thể đồng bộ đơn",
      code: replayError instanceof ApiError ? replayError.code : undefined,
      details: replayError instanceof ApiError ? replayError.details : undefined,
    };
  }
}
