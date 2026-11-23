import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildExactProductImageAutofillRequestedEvent } from "../services/exact-outbox-event-builders";

describe("OUTBOX-02F exact product.image_autofill_requested conversion", () => {
  it("anchors the handled request to one immutable audit occurrence", () => {
    expect(buildExactProductImageAutofillRequestedEvent({
      merchantId: "merchant_a",
      storeId: null,
      productId: "product_a",
      auditEventId: "audit_a",
      sourceOccurredAt: new Date("2026-08-06T02:00:00.000Z"),
      payload: {
        merchantId: "wrong_merchant",
        storeId: "wrong_store",
        productId: "wrong_product",
        auditEventId: "wrong_audit",
        title: "Product A",
        sku: "SKU-A",
      },
    })).toEqual({
      merchantId: "merchant_a",
      storeId: null,
      aggregateType: "product",
      aggregateId: "product_a",
      eventType: "product.image_autofill_requested",
      eventVersion: 1,
      sourceEventId: "audit_event:audit_a",
      sourceOccurredAt: "2026-08-06T02:00:00.000Z",
      retryPolicyKey: "media-v1",
      payload: {
        merchantId: "merchant_a",
        storeId: null,
        productId: "product_a",
        auditEventId: "audit_a",
        title: "Product A",
        sku: "SKU-A",
      },
    });
  });

  it("fails closed without the audit timestamp", () => {
    expect(() => buildExactProductImageAutofillRequestedEvent({
      merchantId: "merchant_a",
      storeId: "store_a",
      productId: "product_a",
      auditEventId: "audit_a",
      sourceOccurredAt: undefined,
      payload: {},
    })).toThrow("sourceOccurredAt");
  });

  it("converts the last live legacy writer after its duplicate guard", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../services/product-image-autofill-service.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/emitOutbox\(client, PRODUCT_IMAGE_AUTOFILL_EVENT/);
    expect(source).toMatch(/const requestAudit = await recordAuditEntry/);
    expect(source).toMatch(/emitExactOutbox\(client, buildExactProductImageAutofillRequestedEvent\(/);
    expect(source).toMatch(/sourceOccurredAt: requestAudit\.createdAt/);
    expect(source.indexOf("const duplicate = await queryOne")).toBeLessThan(source.indexOf("const requestAudit = await recordAuditEntry"));
  });
});
