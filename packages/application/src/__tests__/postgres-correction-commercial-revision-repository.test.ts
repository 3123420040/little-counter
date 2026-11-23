import { describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { createCorrectionCommercialRevisionTaskV1 } from "../services/correction-commercial-revision-service";
import { PostgresCorrectionCommercialRevisionRepositoryV1 } from "../services/postgres-correction-commercial-revision-repository";

const revisionId = "123e4567-e89b-42d3-a456-426614174000";

function input() {
  return {
    merchantId: "merchant-a",
    storeId: "store-a",
    orderId: "order-a",
    correctionId: "correction-a-1",
    revision: 1,
    sourceOccurredAt: "2026-08-06T12:00:00.000Z",
    currencyCode: "VND" as const,
    minorUnitExponent: 0 as const,
    taxMode: "inclusive" as const,
    beforeTotals: {
      subtotal: 100_000, discount: 10_000, merchandisePayable: 90_000,
      shippingFee: 10_000, merchandiseTax: 8_182, shippingTax: 909,
      tax: 9_091, total: 100_000,
    },
    afterTotals: {
      subtotal: 120_000, discount: 10_000, merchandisePayable: 110_000,
      shippingFee: 5_000, merchandiseTax: 10_000, shippingTax: 455,
      tax: 10_455, total: 115_000,
    },
    lines: [
      { variantId: "variant-a", productId: "product-a", skuSnapshot: "SKU-A", titleSnapshot: "A", quantity: 2, unitPriceMinor: 50_000 },
      { variantId: "variant-b", productId: "product-b", skuSnapshot: "SKU-B", titleSnapshot: "B", quantity: 1, unitPriceMinor: 20_000 },
    ],
  };
}

function fakeClient(options: { replayFingerprint?: string } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("correction_revision_existing")) {
        return options.replayFingerprint
          ? { rows: [{ id: revisionId, revision: 1, bundle_fingerprint: options.replayFingerprint }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("correction_revision_previous")) {
        return { rows: [{
          revision: 0,
          tax_mode: "inclusive",
          merchandise_gross_minor: "100000",
          discount_minor: "10000",
          merchandise_net_minor: "90000",
          shipping_minor: "10000",
          merchandise_vat_minor: "8182",
          shipping_vat_minor: "909",
          vat_minor: "9091",
          unclassified_minor: "0",
          total_minor: "100000",
        }], rowCount: 1 };
      }
      if (sql.includes("correction_revision_insert_revision")) {
        return { rows: [{ id: revisionId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

describe("PostgresCorrectionCommercialRevisionRepositoryV1", () => {
  it("locks the chain and inserts revision, components and every effective line", async () => {
    const fake = fakeClient();
    const repository = new PostgresCorrectionCommercialRevisionRepositoryV1(fake.client, {
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 1_000,
      transactionOwnership: "caller",
    });
    const task = createCorrectionCommercialRevisionTaskV1({ repository }, input());

    await expect(task.execute()).resolves.toMatchObject({ outcome: "inserted", revisionId });

    const sql = fake.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("correction_revision_lock");
    expect(sql).toContain("correction_revision_previous");
    expect(sql).toContain("correction_revision_insert_revision");
    expect(sql).toContain("correction_revision_insert_components");
    expect(sql.match(/correction_revision_insert_line/g)).toHaveLength(2);
    expect(sql).not.toContain("BEGIN TRANSACTION");
    expect(sql).not.toContain("COMMIT");
  });

  it("returns replay only when the immutable fingerprint matches", async () => {
    const first = fakeClient();
    const firstRepo = new PostgresCorrectionCommercialRevisionRepositoryV1(first.client, {
      statementTimeoutMs: 5_000, lockTimeoutMs: 1_000, transactionOwnership: "caller",
    });
    const bundle = createCorrectionCommercialRevisionTaskV1({ repository: firstRepo }, input()).bundle;
    const replay = fakeClient({ replayFingerprint: bundle.bundleFingerprint });
    const replayRepo = new PostgresCorrectionCommercialRevisionRepositoryV1(replay.client, {
      statementTimeoutMs: 5_000, lockTimeoutMs: 1_000, transactionOwnership: "caller",
    });

    await expect(replayRepo.appendCorrectionRevision(bundle)).resolves.toMatchObject({ outcome: "replayed" });

    const drift = fakeClient({ replayFingerprint: "0".repeat(64) });
    const driftRepo = new PostgresCorrectionCommercialRevisionRepositoryV1(drift.client, {
      statementTimeoutMs: 5_000, lockTimeoutMs: 1_000, transactionOwnership: "caller",
    });
    await expect(driftRepo.appendCorrectionRevision(bundle)).rejects.toThrow("fingerprint drift");
  });
});
