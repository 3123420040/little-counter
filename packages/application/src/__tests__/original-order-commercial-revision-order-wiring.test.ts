import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const orderServiceSource = readFileSync(
  fileURLToPath(new URL("../services/order-service.ts", import.meta.url)),
  "utf8",
);

describe("ORD-WIRE-01 staged order-create integration", () => {
  it("uses the compile-time default-off caller config with no env override", () => {
    expect(orderServiceSource).toContain(
      "ORIGINAL_ORDER_COMMERCIAL_REVISION_CALLER_DEFAULT_CONFIG_V1",
    );
    expect(orderServiceSource).toContain(
      "recordOriginalOrderCommercialRevisionFromOrderCreateV1",
    );
    expect(orderServiceSource).not.toMatch(
      /process\.env\.ORDER_FINANCIAL_ORIGINAL_REVISION_WRITE_ENABLED/,
    );
    expect(orderServiceSource).not.toMatch(
      /originalOrderCommercialRevision[\s\S]{0,300}enabled:\s*true/,
    );
  });

  it("captures database order and catalog-cost timestamps", () => {
    expect(orderServiceSource).toMatch(/ps\.updated_at\s+AS\s+cost_evidence_updated_at/i);
    expect(orderServiceSource).toMatch(/RETURNING\s+display_id,\s*created_at/i);
    expect(orderServiceSource).toContain("costEvidenceUpdatedAt");
    expect(orderServiceSource).toContain("orderCreatedAt");
  });

  it("awaits revision creation after line inserts and before the initial payment", () => {
    const lineInsert = orderServiceSource.indexOf("INSERT INTO public.order_item");
    const revisionCall = orderServiceSource.indexOf(
      "await recordOriginalOrderCommercialRevisionFromOrderCreateV1",
    );
    const paymentCall = orderServiceSource.indexOf("await recordSaleCharge");
    expect(lineInsert).toBeGreaterThan(0);
    expect(revisionCall).toBeGreaterThan(lineInsert);
    expect(paymentCall).toBeGreaterThan(revisionCall);
    const contextStart = orderServiceSource.indexOf("const originalRevisionDependencies");
    expect(contextStart).toBeGreaterThan(lineInsert);
    const callBlock = orderServiceSource.slice(contextStart, paymentCall);
    expect(callBlock).toContain('ownership: "caller"');
    expect(callBlock).toContain("orderCreatedInCurrentTransaction: true");
    expect(callBlock).toContain("transactionContext");
    expect(callBlock).toContain("commercialContext");
    expect(callBlock).toContain("totals.commercialAdjustmentVersion === 2");
    expect(callBlock).toContain("await recordOriginalOrderCommercialRevisionFromOrderCreateV2");
    expect(callBlock).toContain("costEvidenceSource: \"inventory.product_settings\"");
  });
});
