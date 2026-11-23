import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExactCustomerCreatedEvent,
  buildExactCustomerDeletedEvent,
  buildExactCustomerMergedEvent,
  buildExactJournalPostedEvent,
} from "../services/exact-outbox-event-builders";

const merchantId = "merchant_a";
const occurredAt = new Date("2026-08-06T03:00:00.000Z");

describe("DEC-32 exact no-op emitter conversion", () => {
  it("builds identity/scope-only customer envelopes without contact data", () => {
    const created = buildExactCustomerCreatedEvent({
      merchantId,
      customerId: "customer_a",
      sourceOccurredAt: occurredAt,
    });
    const deleted = buildExactCustomerDeletedEvent({
      merchantId,
      customerId: "customer_a",
      sourceOccurredAt: occurredAt,
    });
    const merged = buildExactCustomerMergedEvent({
      merchantId,
      primaryId: "customer_a",
      duplicateId: "customer_b",
      sourceOccurredAt: occurredAt,
    });

    expect(created).toEqual({
      merchantId,
      storeId: null,
      aggregateType: "customer",
      aggregateId: "customer_a",
      eventType: "customer.created",
      eventVersion: 1,
      sourceEventId: "customer:customer_a:created",
      sourceOccurredAt: "2026-08-06T03:00:00.000Z",
      retryPolicyKey: "workflow-v1",
      payload: { customerId: "customer_a", merchantId },
    });
    expect(deleted.eventType).toBe("customer.deleted");
    expect(deleted.sourceEventId).toBe("customer:customer_a:deleted");
    expect(merged.payload).toEqual({
      primaryId: "customer_a",
      duplicateId: "customer_b",
      merchantId,
    });
    expect(merged.sourceEventId).toBe("customer:customer_a:merged:customer_b");
    expect(JSON.stringify([created, deleted, merged])).not.toMatch(/phone|email|first_name|last_name/i);
  });

  it("builds an exact financial-policy journal envelope", () => {
    expect(buildExactJournalPostedEvent({
      merchantId,
      storeId: "store_a",
      journalEntryId: "journal_a",
      sourceOccurredAt: "2026-08-06T10:00:00+07:00",
    })).toEqual({
      merchantId,
      storeId: "store_a",
      aggregateType: "journal_entry",
      aggregateId: "journal_a",
      eventType: "journal_entry.posted",
      eventVersion: 1,
      sourceEventId: "journal_entry:journal_a:posted",
      sourceOccurredAt: "2026-08-06T03:00:00.000Z",
      retryPolicyKey: "financial-v1",
      payload: { journalEntryId: "journal_a", merchantId, storeId: "store_a" },
    });
  });

  it("fails closed when the persisted mutation timestamp is absent or invalid", () => {
    expect(() => buildExactCustomerCreatedEvent({
      merchantId,
      customerId: "customer_a",
      sourceOccurredAt: null,
    })).toThrow("sourceOccurredAt");
    expect(() => buildExactJournalPostedEvent({
      merchantId,
      storeId: "store_a",
      journalEntryId: "journal_a",
      sourceOccurredAt: "not-a-date",
    })).toThrow("sourceOccurredAt");
  });

  it("binds both live services to persisted timestamps and the exact emitter", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const customerSource = fs.readFileSync(path.join(root, "services/customer-service.ts"), "utf8");
    const accountingSource = fs.readFileSync(path.join(root, "services/accounting-service.ts"), "utf8");

    expect(customerSource).toContain("emitExactOutbox");
    expect(customerSource).not.toContain("emitOutbox(");
    expect(customerSource).toMatch(/RETURNING[\s\S]*created_at/i);
    expect(customerSource).toMatch(/RETURNING[\s\S]*deleted_at/i);
    expect(accountingSource).toContain("emitExactOutbox");
    expect(accountingSource).not.toContain("emitOutbox(");
    expect(accountingSource).toMatch(/RETURNING[\s\S]*posted_at/i);
  });
});
