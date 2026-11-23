export const partnerErrors = {
  invalid_request: [400, "Invalid request"],
  idempotency_key_required: [400, "Idempotency key required"],
  invalid_cursor: [400, "Invalid cursor"],
  invalid_token: [401, "Invalid access token"],
  insufficient_scope: [403, "Insufficient scope"],
  integration_disabled: [403, "Integration disabled"],
  store_not_allowed: [403, "Store not allowed"],
  merchant_capability_denied: [403, "Merchant capability denied"],
  resource_not_found: [404, "Resource not found"],
  insufficient_stock: [409, "Insufficient stock"],
  quote_expired: [409, "Quote expired"],
  quote_changed: [409, "Quote changed"],
  quote_consumed: [409, "Quote consumed"],
  idempotency_conflict: [409, "Idempotency conflict"],
  external_order_conflict: [409, "External order conflict"],
  idempotency_record_expired: [409, "Idempotency record expired"],
  payload_too_large: [413, "Payload too large"],
  unsupported_media_type: [415, "Unsupported media type"],
  unsupported_payment_method: [422, "Unsupported payment method"],
  shipping_policy_unavailable: [422, "Shipping policy unavailable"],
  unsupported_inventory_model: [422, "Unsupported inventory model"],
  rate_limit_exceeded: [429, "Rate limit exceeded"],
  dependency_unavailable: [503, "Dependency unavailable"],
  mutation_busy: [503, "Mutation busy"],
  effective_order_unavailable: [503, "Effective order unavailable"],
  internal_error: [500, "Internal error"],
} as const;
export type PartnerErrorCode = keyof typeof partnerErrors;
export class PartnerError extends Error {
  readonly status: number;
  constructor(readonly code: PartnerErrorCode, readonly retryAfter = 1) {
    super(partnerErrors[code][1]);
    this.status = partnerErrors[code][0];
  }
}
export function partnerProblem(error: unknown, requestId: string) {
  const safe = error instanceof PartnerError ? error : new PartnerError("internal_error");
  return {
    type: `urn:snus:partner:error:${safe.code}`,
    title: safe.message, status: safe.status, code: safe.code, detail: safe.message,
    request_id: requestId, retryable: safe.status === 429 || safe.status >= 500,
  };
}
