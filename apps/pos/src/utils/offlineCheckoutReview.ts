import { ApiError } from "../api/client";
import type { QueuedSale } from "./offlineQueue";

/** Change attribution only after an authoritative non-commit refusal, never a lost response. */
export function reviewedOfflineShiftPayload(sale: QueuedSale) {
  if (sale.lastErrorCode !== "invalid_shift" || sale.payload.shiftAttribution !== "online_open_shift"
    || !sale.payload.shiftId || !sale.payload.shiftOpenedAt) return sale.payload;
  return { ...sale.payload, shiftAttribution: "offline_cached_shift" as const, queuedAt: sale.createdAt };
}

/** Stale commercial or policy input needs explicit review; automatic retries cannot repair it. */
export function requiresOfflineCheckoutReview(error: unknown): boolean {
  if (error instanceof ApiError && (
    error.code === "idempotency_conflict"
    || error.code === "cart_quote_changed"
    || error.code === "validation_error"
    || error.code === "unsupported_contract"
    || error.code === "variant_price_unavailable"
    || error.code === "invalid_shift"
    || error.code === "shift_required"
    || error.code === "shift_offline_not_allowed"
    || error.code === "manual_bank_confirmation_disabled"
    || error.code === "checkout_bank_unavailable"
    || error.code === "checkout_policy_refresh_required"
    || error.code === "checkout_bank_acknowledgment_required"
  )) {
    return true;
  }

  const message = error instanceof Error ? error.message : "";
  return /stock|inventory|tồn|insufficient/i.test(message);
}
