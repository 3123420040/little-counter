import { describe, expect, it } from "vitest";
import type { PoolClient } from "../db/client";
import { buildPositiveCorrectionChargeContractV1 } from "../services/payment-positive-correction-charge-contract";
import { recordPositiveCorrectionChargeV1 } from "../services/postgres-positive-correction-charge-repository";

const eventId = "123e4567-e89b-42d3-a456-426614174000";
const obligationId = "123e4567-e89b-42d3-a456-426614174001";

function contract() {
  const before = {
    taxMode: "inclusive" as const,
    merchandiseGrossMinor: 100_000,
    discountMinor: 10_000,
    merchandiseNetMinor: 90_000,
    shippingMinor: 10_000,
    merchandiseVatMinor: 8_182,
    shippingVatMinor: 909,
    vatMinor: 9_091,
    unclassifiedMinor: 0,
    totalMinor: 100_000,
  };
  return buildPositiveCorrectionChargeContractV1({
    merchantId: "merchant-a",
    storeId: "store-a",
    orderId: "order-a",
    correctionId: "correction-a-1",
    baseCommercialRevisionId: "123e4567-e89b-42d3-a456-426614174010",
    baseCommercialRevision: 0,
    effectiveCommercialRevisionId: "123e4567-e89b-42d3-a456-426614174011",
    effectiveCommercialRevision: 1,
    currencyCode: "VND",
    minorUnitExponent: 0,
    sourceOccurredAt: "2026-08-06T12:00:00.000Z",
    beforeComponents: before,
    effectiveComponents: {
      ...before,
      merchandiseGrossMinor: 120_000,
      merchandiseNetMinor: 110_000,
      shippingMinor: 5_000,
      merchandiseVatMinor: 10_000,
      shippingVatMinor: 455,
      vatMinor: 10_455,
      totalMinor: 115_000,
    },
  });
}

function fakeClient() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("positive_correction_charge_existing")) return { rows: [], rowCount: 0 };
      if (sql.includes("positive_correction_charge_insert_event")) return { rows: [{ id: eventId }], rowCount: 1 };
      if (sql.includes("positive_correction_charge_insert_obligation")) return { rows: [{ id: obligationId }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

describe("positive correction charge persistence", () => {
  it.each([
    ["cod", "cod", "posted", "cod_order_created"],
    ["cash", "cash", "posted", "cash_receipt"],
    ["bank_transfer", "manual_bank", "pending", null],
  ] as const)("persists %s with the exact lifecycle and signed delta", async (settlementMethod, dbMethod, status, evidenceType) => {
    const fake = fakeClient();
    const result = await recordPositiveCorrectionChargeV1(fake.client, {
      contract: contract(),
      settlementMethod,
      transactionOwnership: "caller",
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 1_000,
    });

    expect(result).toMatchObject({ outcome: "inserted", paymentEventId: eventId, obligationId });
    const eventCall = fake.calls.find((call) => call.sql.includes("positive_correction_charge_insert_event"));
    expect(eventCall?.params).toContain(dbMethod);
    expect(eventCall?.params).toContain(status);
    expect(eventCall?.params).toContain(evidenceType);
    const sql = fake.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("positive_correction_charge_insert_delta");
    if (status === "posted") {
      expect(sql).toContain("positive_correction_charge_insert_evidence");
      expect(sql).toContain("positive_correction_charge_insert_allocation");
    } else {
      expect(sql).not.toContain("positive_correction_charge_insert_evidence");
      expect(sql).not.toContain("positive_correction_charge_insert_allocation");
    }
    expect(sql).not.toContain("payment_event_component_allocations");
    expect(sql).not.toContain("BEGIN TRANSACTION");
  });

  it("rejects unsupported methods before writing", async () => {
    const fake = fakeClient();
    await expect(recordPositiveCorrectionChargeV1(fake.client, {
      contract: contract(),
      settlementMethod: "provider" as never,
      transactionOwnership: "caller",
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 1_000,
    })).rejects.toThrow("settlement method");
    expect(fake.calls).toHaveLength(0);
  });
});
