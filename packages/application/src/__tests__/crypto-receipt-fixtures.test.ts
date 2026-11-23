import { describe, expect, it } from "vitest";
import { CryptoReceiptEvidenceSchema } from "../contract-seams";
import {
  missingFeeManualReviewFixture,
  verifiedReceiptFixtures,
} from "./fixtures/crypto-receipt-evidence";

describe("Synthetic crypto receipt fixtures", () => {
  it("contains complete, linked USDTTRC20 and native USDCMATIC evidence", () => {
    expect(verifiedReceiptFixtures.map((fixture) => fixture.evidence.asset))
      .toEqual(["USDTTRC20", "USDCMATIC"]);

    for (const fixture of verifiedReceiptFixtures) {
      expect(CryptoReceiptEvidenceSchema.parse(fixture.evidence)).toEqual(fixture.evidence);
      expect(fixture.references.paymentIntentRecord.id).toBe(fixture.evidence.paymentIntentId);
      expect(fixture.references.providerEventRecord.providerEventId).toBe(fixture.evidence.providerEventId);
      expect(fixture.references.providerEventRecord.paymentIntentId).toBe(fixture.evidence.paymentIntentId);
      expect(fixture.references.paymentEntryRecord.paymentIntentId).toBe(fixture.evidence.paymentIntentId);
      expect(fixture.references.paymentEntryRecord.providerEventId).toBe(fixture.evidence.providerEventId);
      expect(fixture.references.orderRecord.merchantId).toBe(fixture.evidence.merchantId);
      expect(fixture.references.orderRecord.storeId).toBe(fixture.evidence.storeId);
    }
  });

  it("does not invent zero fee evidence when the provider fee is missing", () => {
    expect(missingFeeManualReviewFixture).toMatchObject({
      status: "manual_review",
      manualReviewReason: "missing_provider_fee_evidence",
      cryptoReceiptEvidence: null,
    });
  });
});
