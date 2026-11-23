import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../services/order-correction-service.ts", import.meta.url)),
  "utf8",
);

describe("CORR-REV order-correction wiring", () => {
  it("records the canonical revision inside the caller-owned correction transaction", () => {
    const legacyHeader = source.indexOf("INSERT INTO app.order_corrections");
    const itemInsert = source.indexOf("INSERT INTO app.order_correction_items");
    const canonicalRevision = source.indexOf("new PostgresCorrectionCommercialRevisionRepositoryV1");
    const paymentEntry = source.indexOf("let paymentEntryId", canonicalRevision);
    expect(legacyHeader).toBeGreaterThan(0);
    expect(itemInsert).toBeGreaterThan(legacyHeader);
    expect(canonicalRevision).toBeGreaterThan(itemInsert);
    expect(paymentEntry).toBeGreaterThan(canonicalRevision);
    const block = source.slice(canonicalRevision, paymentEntry);
    expect(block).toContain('transactionOwnership: "caller"');
    expect(block).toContain("beforeTotals: plan.before");
    expect(block).toContain("afterTotals: plan.after");
    expect(block).toContain("quantity: line.quantityAfter");
  });

  it("returns the canonical revision identity to the caller", () => {
    expect(source).toContain("commercialRevisionId: correctionRevision.revisionId");
  });

  it("posts a positive correction against the new revision before the legacy mirror", () => {
    const revisionWrite = source.indexOf("const correctionRevision = await correctionRevisionTask.execute()");
    const canonicalCharge = source.indexOf("await recordPositiveCorrectionChargeV1", revisionWrite);
    const legacyPayment = source.indexOf("let paymentEntryId", canonicalCharge);
    expect(revisionWrite).toBeGreaterThan(0);
    expect(canonicalCharge).toBeGreaterThan(revisionWrite);
    expect(legacyPayment).toBeGreaterThan(canonicalCharge);
    const block = source.slice(source.indexOf("const positiveChargeInput", revisionWrite), legacyPayment);
    expect(block).toContain('transactionOwnership: "caller"');
    expect(block).toContain("baseCommercialRevisionId: previousRevision.id");
    expect(block).toContain("effectiveCommercialRevisionId: correctionRevision.revisionId");
  });

  it("treats successful COD correction as posted because no later confirmation exists", () => {
    const repository = readFileSync(new URL("../services/postgres-positive-correction-charge-repository.ts", import.meta.url), "utf8");
    expect(repository).toMatch(/method === "cod"[\s\S]*?status: "posted"/);
    expect(repository).toMatch(/method === "bank_transfer"[\s\S]*?status: "pending"/);
    expect(source).not.toContain('method === "cod" ? "pending"');
  });
});
