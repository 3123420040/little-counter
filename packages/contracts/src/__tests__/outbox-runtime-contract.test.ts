import { describe, expect, it } from "vitest";
import {
  EXACT_OUTBOX_EVENT_CONTRACTS,
  EXACT_OUTBOX_INTENTIONAL_NOOP_DISPOSITIONS,
  EXACT_OUTBOX_RETRY_POLICIES,
  resolveExactOutboxEventContract,
} from "../outbox-runtime";

const emittedEventTypes = [
  "customer.created",
  "customer.deleted",
  "customer.merged",
  "journal_entry.posted",
  "order.corrected",
  "order.shipping_adjusted",
  "product.image_autofill_requested",
  "purchase_order.received",
  "refund.created",
  "sale.cancelled",
  "sale.created",
  "shift.closed",
  "shift.discrepancy_alert",
  "shift.force_closed",
  "shift.opened",
  "stock.changed",
  "stock.found",
] as const;

describe("exact outbox runtime contract", () => {
  it("classifies every currently emitted event type and the Telegram consumer type", () => {
    expect(Object.keys(EXACT_OUTBOX_EVENT_CONTRACTS).sort()).toEqual([
      ...emittedEventTypes,
      "telegram.notification.requested",
    ].sort());
    for (const eventType of emittedEventTypes) {
      expect(resolveExactOutboxEventContract(eventType, 1)?.eventType).toBe(eventType);
    }
  });

  it("binds every no-handler event to an explicit DEC-32 intentional-noop disposition", () => {
    const unsupported = Object.values(EXACT_OUTBOX_EVENT_CONTRACTS)
      .filter((contract) => contract.handling === "unsupported")
      .map((contract) => contract.eventType)
      .sort();
    const intentionalNoops = Object.values(EXACT_OUTBOX_EVENT_CONTRACTS)
      .filter((contract) => contract.handling === "intentional_noop")
      .map((contract) => contract.eventType)
      .sort();

    expect(unsupported).toEqual([]);
    expect(intentionalNoops).toEqual([
      "customer.created",
      "customer.deleted",
      "customer.merged",
      "journal_entry.posted",
      "shift.closed",
      "shift.force_closed",
      "shift.opened",
    ]);

    const dispositionEventTypes = Object.keys(
      EXACT_OUTBOX_INTENTIONAL_NOOP_DISPOSITIONS,
    ) as Array<keyof typeof EXACT_OUTBOX_INTENTIONAL_NOOP_DISPOSITIONS>;
    expect([...dispositionEventTypes].sort()).toEqual(intentionalNoops);
    for (const eventType of dispositionEventTypes) {
      expect(EXACT_OUTBOX_INTENTIONAL_NOOP_DISPOSITIONS[eventType]).toMatchObject({
        eventType,
        eventVersion: 1,
        handling: "intentional_noop",
        decisionId: "DEC-32",
        payloadPolicy: "identity_scope_only",
        preserveEnvelopeForCompatibility: true,
      });
    }
  });

  it("freezes the no-op dispositions and records the synchronous source of truth", () => {
    expect(Object.isFrozen(EXACT_OUTBOX_INTENTIONAL_NOOP_DISPOSITIONS)).toBe(true);
    expect(EXACT_OUTBOX_INTENTIONAL_NOOP_DISPOSITIONS).toMatchObject({
      "customer.created": { reasonCode: "synchronous_customer_mutation_and_audit" },
      "customer.deleted": { reasonCode: "synchronous_customer_mutation_and_audit" },
      "customer.merged": { reasonCode: "synchronous_customer_mutation_and_audit" },
      "journal_entry.posted": { reasonCode: "synchronous_journal_post_and_audit" },
      "shift.closed": { reasonCode: "synchronous_shift_state_event_and_audit" },
      "shift.force_closed": { reasonCode: "synchronous_shift_state_event_and_audit" },
      "shift.opened": { reasonCode: "synchronous_shift_state_event_and_audit" },
    });
    for (const disposition of Object.values(EXACT_OUTBOX_INTENTIONAL_NOOP_DISPOSITIONS)) {
      expect(Object.isFrozen(disposition)).toBe(true);
    }
  });

  it("binds every event version to a versioned bounded retry policy", () => {
    for (const contract of Object.values(EXACT_OUTBOX_EVENT_CONTRACTS)) {
      expect(contract.eventVersion).toBe(1);
      const policy = EXACT_OUTBOX_RETRY_POLICIES[contract.retryPolicyKey];
      expect(policy.key).toBe(contract.retryPolicyKey);
      expect(policy.maxAttempts).toBeGreaterThan(0);
      expect(policy.baseDelaySeconds).toBeGreaterThanOrEqual(5);
      expect(policy.maxDelaySeconds).toBeGreaterThanOrEqual(policy.baseDelaySeconds);
      expect(policy.maxDelaySeconds).toBeLessThanOrEqual(3_600);
    }
  });

  it("rejects unknown versions and event types", () => {
    expect(resolveExactOutboxEventContract("order.corrected", 2)).toBeNull();
    expect(resolveExactOutboxEventContract("unknown.event", 1)).toBeNull();
  });
});
