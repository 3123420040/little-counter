/**
 * A pending/paid provider intent seals the quoted cart total. Operators must
 * cancel the intent (when still pending) before changing the cart or method.
 */
export function isPaymentIntentCartLocked(status: string | null | undefined): boolean {
  return status === "pending" || status === "paid";
}
