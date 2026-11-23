import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildExactPurchaseOrderReceivedEvent } from "../services/exact-outbox-event-builders";

describe("OUTBOX-02D exact purchase_order.received conversion", () => {
  it("anchors the handled receipt payload to one immutable receipt fact", () => {
    const event = buildExactPurchaseOrderReceivedEvent({
      merchantId: "merchant_a",
      storeId: "store_a",
      receiptId: "receipt_a",
      sourceOccurredAt: new Date("2026-08-06T04:00:00.000Z"),
      payload: {
        merchantId: "wrong_merchant",
        storeId: "wrong_store",
        receiptId: "wrong_receipt",
        purchaseOrderId: "po_a",
        inventoryValue: 250_000,
        stockLocationId: "location_a",
      },
    });

    expect(event).toEqual({
      merchantId: "merchant_a",
      storeId: "store_a",
      aggregateType: "purchase_order_receipt",
      aggregateId: "receipt_a",
      eventType: "purchase_order.received",
      eventVersion: 1,
      sourceEventId: "purchase_order_receipt:receipt_a",
      sourceOccurredAt: "2026-08-06T04:00:00.000Z",
      retryPolicyKey: "inventory-v1",
      payload: {
        merchantId: "merchant_a",
        storeId: "store_a",
        receiptId: "receipt_a",
        purchaseOrderId: "po_a",
        inventoryValue: 250_000,
        stockLocationId: "location_a",
      },
    });
  });

  it("fails closed without the receipt timestamp", () => {
    expect(() => buildExactPurchaseOrderReceivedEvent({
      merchantId: "merchant_a",
      storeId: "store_a",
      receiptId: "receipt_a",
      sourceOccurredAt: undefined,
      payload: {},
    })).toThrow("sourceOccurredAt");
  });

  it("uses the DB-returned receipt occurrence at the only live writer", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../services/inventory-service.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/emitOutbox\(client, "purchase_order\.received"/);
    expect(source.match(/emitExactOutbox\(client, buildExactPurchaseOrderReceivedEvent\(/g)).toHaveLength(1);
    expect(source).toMatch(/RETURNING received_at/);
    expect(source).toMatch(/sourceOccurredAt: receipt\.received_at/);
  });
});
