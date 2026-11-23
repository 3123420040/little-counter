import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildExactStockChangedEvent } from "../services/exact-outbox-event-builders";

describe("OUTBOX-02C exact stock.changed aggregate conversion", () => {
  it("anchors the handled payload to one immutable stock movement", () => {
    const event = buildExactStockChangedEvent({
      merchantId: "merchant_a",
      storeId: "store_a",
      inventoryItemId: "inventory_a",
      movementId: "movement_a",
      sourceOccurredAt: new Date("2026-08-06T05:00:00.000Z"),
      payload: {
        merchantId: "wrong_merchant",
        storeId: "wrong_store",
        inventoryItemId: "wrong_inventory",
        movementId: "wrong_movement",
        productId: "product_a",
        variantId: "variant_a",
        quantityBefore: 10,
        quantityChange: -2,
        quantityAfter: 8,
        reorderLevel: 5,
      },
    });

    expect(event).toEqual({
      merchantId: "merchant_a",
      storeId: "store_a",
      aggregateType: "inventory_item",
      aggregateId: "inventory_a",
      eventType: "stock.changed",
      eventVersion: 1,
      sourceEventId: "stock_movement:movement_a",
      sourceOccurredAt: "2026-08-06T05:00:00.000Z",
      retryPolicyKey: "inventory-v1",
      payload: {
        merchantId: "merchant_a",
        storeId: "store_a",
        inventoryItemId: "inventory_a",
        movementId: "movement_a",
        productId: "product_a",
        variantId: "variant_a",
        quantityBefore: 10,
        quantityChange: -2,
        quantityAfter: 8,
        reorderLevel: 5,
      },
    });
  });

  it("fails closed without the stock movement timestamp", () => {
    expect(() => buildExactStockChangedEvent({
      merchantId: "merchant_a",
      storeId: "store_a",
      inventoryItemId: "inventory_a",
      movementId: "movement_a",
      sourceOccurredAt: undefined,
      payload: {},
    })).toThrow("sourceOccurredAt");
  });

  it("converts all six live stock.changed writers together", () => {
    const serviceRoot = path.resolve(import.meta.dirname, "../services");
    const sources = ["inventory-service.ts", "order-service.ts", "order-correction-service.ts"]
      .map((name) => fs.readFileSync(path.join(serviceRoot, name), "utf8"))
      .join("\n");
    expect(sources).not.toMatch(/emitOutbox\(client, "stock\.changed"/);
    expect(sources.match(/emitExactOutbox\(\s*client,\s*buildExactStockChangedEvent\(/g)).toHaveLength(6);
    expect(sources.match(/sourceOccurredAt: movement\.created_at/g)).toHaveLength(6);
  });
});
