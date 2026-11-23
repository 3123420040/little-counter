import { describe, expect, it } from "vitest";
import {
  parseHistoricalBankRecognitionManifestV1,
  sha256Canonical,
} from "../services/historical-bank-recognition-contract";

const sha = "a".repeat(64);
const uuid = "00000000-0000-4000-8000-000000000001";

function initialItem() {
  return {
    rowNumber: 1, itemId: uuid, decision: "recognize", reasonCode: "owner_declared_received",
    recognitionKind: "initial", merchantId: "merchant-a", storeId: "store-a", orderId: "order-a",
    sourcePendingPaymentEventId: "00000000-0000-4000-8000-000000000002",
    sourceObligationId: "00000000-0000-4000-8000-000000000003",
    sourceCommercialRevisionId: "00000000-0000-4000-8000-000000000004",
    targetPaymentEventId: "00000000-0000-4000-8000-000000000005",
    targetSourceType: "historical_bank_initial_recognition",
    targetSourceId: "hist-bank:v1:source-1", targetIdempotencyKey: "hist-bank:v1:event-1",
    evidenceFingerprint: sha, sourcePayloadSha256: sha, componentBasisFingerprint: sha,
    ownerDeclarationReferenceSha256: sha, currencyCode: "VND", minorUnitExponent: 0,
    amountMinor: 690000, economicOccurredAt: "2026-01-01T00:00:00.000Z",
    components: {
      taxMode: "inclusive", merchandiseGrossMinor: 690000, discountMinor: 0,
      merchandiseNetMinor: 690000, shippingMinor: 0, merchandiseVatMinor: 0,
      shippingVatMinor: 0, vatMinor: 0, unclassifiedMinor: 0, totalMinor: 690000,
    },
  } as const;
}

describe("historical bank recognition manifest contract", () => {
  it("accepts a complete, canonical initial receipt decision", () => {
    const manifest = parseHistoricalBankRecognitionManifestV1({
      schemaVersion: 1, toolVersion: "snus-historical-bank-recognition/v1", runId: uuid,
      sourceDatasetSha256: sha, ownerDeclarationSha256: sha, sourceApplicationSha: "b".repeat(40),
      cutoffAt: "2026-02-01T00:00:00.000Z", reportAsOf: "2026-02-01T00:00:00.000Z",
      datePolicy: "reliable_receipt_else_original_economic_time_v1",
      selection: { mode: "all_census_candidates", targetEnvironment: "disposable", reasonCode: "full_census_disposable_rehearsal" },
      targetScopes: [{ merchantId: "merchant-a", storeId: "store-a" }],
      expected: { recognizedCount: 1, alreadySatisfiedCount: 0, exceptionCount: 0, moneyByCurrency: { VND: 690000 } },
      items: [initialItem()],
    });
    expect(manifest.items[0]?.decision).toBe("recognize");
    expect(sha256Canonical(manifest)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a receipt whose amount is not backed by the component basis", () => {
    expect(() => parseHistoricalBankRecognitionManifestV1({
      schemaVersion: 1, toolVersion: "snus-historical-bank-recognition/v1", runId: uuid,
      sourceDatasetSha256: sha, ownerDeclarationSha256: sha, sourceApplicationSha: "b".repeat(40),
      cutoffAt: "2026-02-01T00:00:00.000Z", reportAsOf: "2026-02-01T00:00:00.000Z",
      datePolicy: "reliable_receipt_else_original_economic_time_v1",
      selection: { mode: "all_census_candidates", targetEnvironment: "disposable", reasonCode: "full_census_disposable_rehearsal" },
      targetScopes: [{ merchantId: "merchant-a", storeId: "store-a" }],
      expected: { recognizedCount: 1, alreadySatisfiedCount: 0, exceptionCount: 0, moneyByCurrency: { VND: 680000 } },
      items: [{ ...initialItem(), amountMinor: 680000 }],
    })).toThrow();
  });
});
