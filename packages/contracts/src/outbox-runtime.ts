export const EXACT_OUTBOX_RETRY_POLICIES = {
  "financial-v1": {
    key: "financial-v1",
    maxAttempts: 5,
    baseDelaySeconds: 30,
    maxDelaySeconds: 900,
  },
  "inventory-v1": {
    key: "inventory-v1",
    maxAttempts: 5,
    baseDelaySeconds: 15,
    maxDelaySeconds: 300,
  },
  "notification-v1": {
    key: "notification-v1",
    maxAttempts: 8,
    baseDelaySeconds: 15,
    maxDelaySeconds: 900,
  },
  "media-v1": {
    key: "media-v1",
    maxAttempts: 3,
    baseDelaySeconds: 60,
    maxDelaySeconds: 600,
  },
  "workflow-v1": {
    key: "workflow-v1",
    maxAttempts: 5,
    baseDelaySeconds: 30,
    maxDelaySeconds: 600,
  },
} as const;

export type ExactOutboxRetryPolicyKey = keyof typeof EXACT_OUTBOX_RETRY_POLICIES;
export type ExactOutboxHandling = "handled" | "intentional_noop" | "unsupported";

export type ExactOutboxEventContract = {
  eventType: string;
  eventVersion: number;
  retryPolicyKey: ExactOutboxRetryPolicyKey;
  handling: ExactOutboxHandling;
};

export type ExactOutboxIntentionalNoopReasonCode =
  | "synchronous_customer_mutation_and_audit"
  | "synchronous_journal_post_and_audit"
  | "synchronous_shift_state_event_and_audit";

export type ExactOutboxIntentionalNoopDisposition = {
  eventType: string;
  eventVersion: 1;
  handling: "intentional_noop";
  decisionId: "DEC-32";
  reasonCode: ExactOutboxIntentionalNoopReasonCode;
  payloadPolicy: "identity_scope_only";
  preserveEnvelopeForCompatibility: true;
};

function intentionalNoopDisposition(
  eventType: string,
  reasonCode: ExactOutboxIntentionalNoopReasonCode,
): ExactOutboxIntentionalNoopDisposition {
  return Object.freeze({
    eventType,
    eventVersion: 1,
    handling: "intentional_noop",
    decisionId: "DEC-32",
    reasonCode,
    payloadPolicy: "identity_scope_only",
    preserveEnvelopeForCompatibility: true,
  });
}

export const EXACT_OUTBOX_INTENTIONAL_NOOP_DISPOSITIONS = Object.freeze({
  "customer.created": intentionalNoopDisposition(
    "customer.created",
    "synchronous_customer_mutation_and_audit",
  ),
  "customer.deleted": intentionalNoopDisposition(
    "customer.deleted",
    "synchronous_customer_mutation_and_audit",
  ),
  "customer.merged": intentionalNoopDisposition(
    "customer.merged",
    "synchronous_customer_mutation_and_audit",
  ),
  "journal_entry.posted": intentionalNoopDisposition(
    "journal_entry.posted",
    "synchronous_journal_post_and_audit",
  ),
  "shift.closed": intentionalNoopDisposition(
    "shift.closed",
    "synchronous_shift_state_event_and_audit",
  ),
  "shift.force_closed": intentionalNoopDisposition(
    "shift.force_closed",
    "synchronous_shift_state_event_and_audit",
  ),
  "shift.opened": intentionalNoopDisposition(
    "shift.opened",
    "synchronous_shift_state_event_and_audit",
  ),
} as const satisfies Record<string, ExactOutboxIntentionalNoopDisposition>);

export const EXACT_OUTBOX_EVENT_CONTRACTS = {
  "customer.created": contract("customer.created", "workflow-v1", "intentional_noop"),
  "customer.deleted": contract("customer.deleted", "workflow-v1", "intentional_noop"),
  "customer.merged": contract("customer.merged", "workflow-v1", "intentional_noop"),
  "journal_entry.posted": contract("journal_entry.posted", "financial-v1", "intentional_noop"),
  "order.corrected": contract("order.corrected", "financial-v1", "handled"),
  "order.shipping_adjusted": contract("order.shipping_adjusted", "financial-v1", "handled"),
  "product.image_autofill_requested": contract("product.image_autofill_requested", "media-v1", "handled"),
  "purchase_order.received": contract("purchase_order.received", "inventory-v1", "handled"),
  "refund.created": contract("refund.created", "financial-v1", "handled"),
  "sale.cancelled": contract("sale.cancelled", "financial-v1", "handled"),
  "sale.created": contract("sale.created", "financial-v1", "handled"),
  "shift.closed": contract("shift.closed", "workflow-v1", "intentional_noop"),
  "shift.discrepancy_alert": contract("shift.discrepancy_alert", "notification-v1", "handled"),
  "shift.force_closed": contract("shift.force_closed", "workflow-v1", "intentional_noop"),
  "shift.opened": contract("shift.opened", "workflow-v1", "intentional_noop"),
  "stock.changed": contract("stock.changed", "inventory-v1", "handled"),
  "stock.found": contract("stock.found", "inventory-v1", "handled"),
  "telegram.notification.requested": contract("telegram.notification.requested", "notification-v1", "handled"),
} as const satisfies Record<string, ExactOutboxEventContract>;

function contract(
  eventType: string,
  retryPolicyKey: ExactOutboxRetryPolicyKey,
  handling: ExactOutboxHandling,
): ExactOutboxEventContract {
  return { eventType, eventVersion: 1, retryPolicyKey, handling };
}

export function resolveExactOutboxEventContract(
  eventType: string,
  eventVersion: number,
): ExactOutboxEventContract | null {
  const found = EXACT_OUTBOX_EVENT_CONTRACTS[eventType as keyof typeof EXACT_OUTBOX_EVENT_CONTRACTS];
  return found && found.eventVersion === eventVersion ? found : null;
}
