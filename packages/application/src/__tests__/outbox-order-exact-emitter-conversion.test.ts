import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExactOrderCorrectedEvent,
  buildExactOrderShippingAdjustedEvent,
  buildExactRefundCreatedEvent,
  buildExactSaleCancelledEvent,
  buildExactSaleCreatedEvent,
  buildExactStockFoundEvent,
} from "../services/exact-outbox-event-builders";

const occurredAt = new Date("2026-08-06T03:00:00.000Z");
const common = {
  merchantId: "merchant_a",
  storeId: "store_a",
  orderId: "order_a",
};

describe("OUTBOX-02E exact order aggregate conversion", () => {
  it("gives creation events distinct identities on one immutable order occurrence", () => {
    const sale = buildExactSaleCreatedEvent({
      ...common,
      sourceOccurredAt: occurredAt,
      payload: { orderId: "wrong", merchantId: "wrong", storeId: "wrong", total: 100 },
    });
    const stockFound = buildExactStockFoundEvent({
      ...common,
      sourceOccurredAt: occurredAt,
      payload: { orderId: "wrong", inventoryValue: 25 },
    });

    expect(sale).toMatchObject({
      aggregateType: "order",
      aggregateId: "order_a",
      eventType: "sale.created",
      sourceEventId: "order:order_a:created",
      sourceOccurredAt: "2026-08-06T03:00:00.000Z",
      retryPolicyKey: "financial-v1",
      payload: { orderId: "order_a", merchantId: "merchant_a", storeId: "store_a", total: 100 },
    });
    expect(stockFound).toMatchObject({
      eventType: "stock.found",
      sourceEventId: "order:order_a:stock_found",
      retryPolicyKey: "inventory-v1",
      payload: { orderId: "order_a", merchantId: "merchant_a", storeId: "store_a", inventoryValue: 25 },
    });
  });

  it("anchors shipping adjustment to the immutable audit occurrence", () => {
    expect(buildExactOrderShippingAdjustedEvent({
      ...common,
      auditEventId: "audit_a",
      sourceOccurredAt: occurredAt,
      payload: { auditEventId: "wrong", newShippingFee: 30 },
    })).toMatchObject({
      eventType: "order.shipping_adjusted",
      sourceEventId: "audit_event:audit_a",
      retryPolicyKey: "financial-v1",
      payload: { auditEventId: "audit_a", orderId: "order_a", newShippingFee: 30 },
    });
  });

  it("anchors correction to the immutable correction header", () => {
    expect(buildExactOrderCorrectedEvent({
      ...common,
      correctionId: "correction_a",
      sourceOccurredAt: occurredAt,
      payload: { correctionId: "wrong", revision: 2 },
    })).toMatchObject({
      eventType: "order.corrected",
      sourceEventId: "order_correction:correction_a",
      retryPolicyKey: "financial-v1",
      payload: { correctionId: "correction_a", orderId: "order_a", revision: 2 },
    });
  });

  it("anchors refund to the posted payment-entry fact", () => {
    expect(buildExactRefundCreatedEvent({
      ...common,
      paymentEntryId: "payment_a",
      sourceOccurredAt: occurredAt,
      payload: { paymentEntryId: "wrong", amount: 40 },
    })).toMatchObject({
      eventType: "refund.created",
      sourceEventId: "payment_entry:payment_a:refund_created",
      retryPolicyKey: "financial-v1",
      payload: { paymentEntryId: "payment_a", orderId: "order_a", amount: 40 },
    });
  });

  it("anchors cancellation to the persisted cancellation transition", () => {
    expect(buildExactSaleCancelledEvent({
      ...common,
      sourceOccurredAt: occurredAt,
      payload: { orderId: "wrong", reason: "duplicate" },
    })).toMatchObject({
      eventType: "sale.cancelled",
      sourceEventId: "order:order_a:cancelled",
      retryPolicyKey: "financial-v1",
      payload: { orderId: "order_a", reason: "duplicate" },
    });
  });

  it("fails closed when any order occurrence is absent", () => {
    expect(() => buildExactSaleCancelledEvent({
      ...common,
      sourceOccurredAt: undefined,
      payload: {},
    })).toThrow("sourceOccurredAt");
  });

  it("converts the five live order writers while shipping uses the correction writer", () => {
    const serviceRoot = path.resolve(import.meta.dirname, "../services");
    const sources = ["order-service.ts", "order-correction-service.ts"]
      .map((name) => fs.readFileSync(path.join(serviceRoot, name), "utf8"))
      .join("\n");
    for (const eventType of [
      "stock.found",
      "sale.created",
      "order.shipping_adjusted",
      "sale.cancelled",
      "refund.created",
      "order.corrected",
    ]) {
      expect(sources).not.toContain(`emitOutbox(client, "${eventType}"`);
    }
    expect(sources.match(/emitExactOutbox\(\s*client,\s*buildExact(?:SaleCreated|StockFound|SaleCancelled|RefundCreated|OrderCorrected)Event\(/g)).toHaveLength(5);
    expect(sources).not.toContain("buildExactOrderShippingAdjustedEvent(");
    expect(sources).toContain("export async function updateOrderShippingFee(");
    expect(sources).toContain("await applyOrderCorrection(headers, orderId, plan.correctionInput, actor, scope, PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1)");
  });

  it("requires DB-returned timestamps for correction and cancel", () => {
    const serviceRoot = path.resolve(import.meta.dirname, "../services");
    const order = fs.readFileSync(path.join(serviceRoot, "order-service.ts"), "utf8");
    const correction = fs.readFileSync(path.join(serviceRoot, "order-correction-service.ts"), "utf8");
    const audit = fs.readFileSync(path.resolve(serviceRoot, "../repositories/audit-repository.ts"), "utf8");
    expect(correction).toMatch(/sourceOccurredAt: header\.rows\[0\][!]?\.created_at/);
    expect(order).toMatch(/RETURNING canceled_at/);
    expect(audit).toMatch(/RETURNING id::text, created_at/);
  });
});
