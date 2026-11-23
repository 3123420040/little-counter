import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CryptoReceiptEvidence } from "../contract-seams";
import type { PoolClient } from "../db/client";
import { connectPlatformClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedTransaction } from "../db/transaction";
import { verifiedReceiptFixtures } from "./fixtures/crypto-receipt-evidence";
import { shutdownPlatformDb } from "../platform-db";
import {
  getCryptoAssetReconciliation,
  persistCryptoReceiptEvidence,
  persistCryptoReceiptEvidenceForClient,
  recordManualCryptoTreasuryEvent,
} from "../services/crypto-treasury-service";
import { processOutboxEvent } from "../services/outbox-processor-service";

const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let client: PoolClient;

function evidenceFromFixture(index: 0 | 1, suffix: string, overrides: Partial<CryptoReceiptEvidence> = {}): CryptoReceiptEvidence {
  const base = verifiedReceiptFixtures[index].evidence;
  return {
    ...base,
    evidenceId: `${base.evidenceId}_${suffix}`,
    merchantId: `${base.merchantId}_${suffix}`,
    storeId: `${base.storeId}_${suffix}`,
    paymentIntentId: `${base.paymentIntentId}_${suffix}`,
    providerEventId: `${base.providerEventId}_${suffix}`,
    transactionHash: `${base.transactionHash}_${suffix}`,
    destinationWalletRef: `${base.destinationWalletRef}_${suffix}`,
    ...overrides,
  };
}

async function journalLines(referenceType: string, referenceId: string) {
  const result = await client.query<{
    account_code: string;
    debit_amount: string;
    credit_amount: string;
  }>(`
    SELECT a.code AS account_code,
      COALESCE(SUM(jl.debit_amount), 0)::text AS debit_amount,
      COALESCE(SUM(jl.credit_amount), 0)::text AS credit_amount
    FROM accounting.journal_entries je
    JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
    JOIN accounting.accounts a ON a.id = jl.account_id
    WHERE je.reference_type = $1 AND je.reference_id = $2
    GROUP BY a.code
    ORDER BY a.code
  `, [referenceType, referenceId]);
  return result.rows;
}

async function expectBalanced(referenceType: string, referenceId: string) {
  const row = await queryOne<{ delta: string }>(client, `
    SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0)::text AS delta
    FROM accounting.journal_entries je
    JOIN accounting.journal_lines jl ON jl.journal_entry_id = je.id
    WHERE je.reference_type = $1 AND je.reference_id = $2
  `, [referenceType, referenceId]);
  expect(Number(row?.delta || 0)).toBe(0);
}

async function cleanup() {
  await client?.query(`
    DELETE FROM accounting.crypto_treasury_event_lots
    WHERE treasury_event_id IN (
      SELECT id FROM accounting.crypto_treasury_events WHERE treasury_event_id LIKE $1
    )
  `, [`%${runId}%`]).catch(() => undefined);
  await client?.query("DELETE FROM accounting.crypto_treasury_events WHERE treasury_event_id LIKE $1", [`%${runId}%`]).catch(() => undefined);
  await client?.query(`
    DELETE FROM accounting.crypto_asset_lots
    WHERE receipt_evidence_id IN (
      SELECT id FROM accounting.crypto_receipt_evidence
      WHERE evidence_id LIKE $1 OR merchant_id LIKE $1 OR provider_event_id LIKE $1
    )
  `, [`%${runId}%`]).catch(() => undefined);
  await client?.query(
    "DELETE FROM accounting.crypto_receipt_evidence WHERE evidence_id LIKE $1 OR merchant_id LIKE $1 OR provider_event_id LIKE $1",
    [`%${runId}%`],
  ).catch(() => undefined);
  await client?.query("DELETE FROM app.payment_provider_events WHERE provider_event_id LIKE $1", [`%${runId}%`]).catch(() => undefined);
  await client?.query(`
    DELETE FROM accounting.journal_lines
    WHERE journal_entry_id IN (
      SELECT id FROM accounting.journal_entries
      WHERE reference_id LIKE $1 OR merchant_id LIKE $1 OR store_id LIKE $1
    )
  `, [`%${runId}%`]).catch(() => undefined);
  await client?.query(
    "DELETE FROM accounting.journal_entries WHERE reference_id LIKE $1 OR merchant_id LIKE $1 OR store_id LIKE $1",
    [`%${runId}%`],
  ).catch(() => undefined);
}

beforeAll(async () => {
  await ensurePlatformSchema();
  client = await connectPlatformClient();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  client?.release();
  await shutdownPlatformDb().catch(() => undefined);
});

describe("merchant-held crypto treasury accounting", () => {
  it("posts verified crypto sale evidence with separate provider fee accounting from provider evidence", async () => {
    const suffix = `${runId}_sale`;
    const evidence = evidenceFromFixture(0, suffix);
    const orderId = `order_${suffix}`;
    const paymentEntryId = "00000000-0000-4000-8000-100000000001";
    await client.query(`
      INSERT INTO app.payment_provider_events (
        provider, provider_event_id, event_type, amount, currency_code, status, payload,
        merchant_id, store_id, payment_entry_id, order_id, crypto_receipt_evidence
      ) VALUES ('nowpayments', $1, 'payment.finished', $2, 'usdttrc20', 'matched', '{}'::jsonb,
        $3, $4, $5::uuid, $6, $7::jsonb)
    `, [
      evidence.providerEventId,
      evidence.grossVndValue,
      evidence.merchantId,
      evidence.storeId,
      paymentEntryId,
      orderId,
      JSON.stringify(evidence),
    ]);

    await processOutboxEvent({
      id: randomUUID(),
      eventType: "sale.created",
      payload: {
        orderId,
        orderNumber: `ORD-${suffix}`,
        total: evidence.grossVndValue,
        tax: 0,
        merchandiseRevenue: evidence.grossVndValue,
        shippingRevenue: 0,
        cogs: 175000,
        paymentMethod: "crypto_usdt",
        paymentEntryId,
        providerEventId: evidence.providerEventId,
        merchantId: evidence.merchantId,
        storeId: evidence.storeId,
      },
    });

    const receipt = await queryOne<{
      gross_quantity: string;
      provider_fee_quantity: string;
      net_quantity: string;
      carrying_value_vnd: string;
      sale_journal_entry_id: string;
      fee_journal_entry_id: string;
    }>(client, `
      SELECT gross_quantity::text, provider_fee_quantity::text, net_quantity::text, carrying_value_vnd::text,
        sale_journal_entry_id::text, fee_journal_entry_id::text
      FROM accounting.crypto_receipt_evidence
      WHERE evidence_id = $1
    `, [evidence.evidenceId]);
    expect(receipt).toMatchObject({
      gross_quantity: "10.000000000000000000",
      provider_fee_quantity: "0.050000000000000000",
      net_quantity: "9.950000000000000000",
      carrying_value_vnd: "248750",
    });
    expect(receipt?.sale_journal_entry_id).toBeTruthy();
    expect(receipt?.fee_journal_entry_id).toBeTruthy();

    await expectBalanced("order", orderId);
    await expectBalanced("crypto_provider_fee", evidence.evidenceId);
    expect(await journalLines("order", orderId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ account_code: "1122", debit_amount: "250000.00", credit_amount: "0.00" }),
      expect.objectContaining({ account_code: "5111", debit_amount: "0.00", credit_amount: "250000.00" }),
      expect.objectContaining({ account_code: "6321", debit_amount: "175000.00", credit_amount: "0.00" }),
      expect.objectContaining({ account_code: "1561", debit_amount: "0.00", credit_amount: "175000.00" }),
    ]));
    expect(await journalLines("crypto_provider_fee", evidence.evidenceId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ account_code: "1122", debit_amount: "0.00", credit_amount: "1250.00" }),
      expect.objectContaining({ account_code: "6423", debit_amount: "1250.00", credit_amount: "0.00" }),
    ]));
  });

  it("is idempotent for duplicate/concurrent evidence and rejects conflicting duplicates", async () => {
    const suffix = `${runId}_dup`;
    const evidence = evidenceFromFixture(0, suffix);
    const [first, second] = await Promise.all([
      persistCryptoReceiptEvidence({ ...evidence, asset: evidence.asset, orderId: `order_${suffix}`, paymentEntryId: "00000000-0000-4000-8000-100000000002" }),
      persistCryptoReceiptEvidence({ ...evidence, asset: evidence.asset, orderId: `order_${suffix}`, paymentEntryId: "00000000-0000-4000-8000-100000000002" }),
    ]);
    expect(second.id).toBe(first.id);

    const counts = await queryOne<{ receipts: string; lots: string }>(client, `
      SELECT
        (SELECT COUNT(*)::text FROM accounting.crypto_receipt_evidence WHERE evidence_id = $1) AS receipts,
        (SELECT COUNT(*)::text FROM accounting.crypto_asset_lots WHERE lot_id = $2) AS lots
    `, [evidence.evidenceId, `lot_${evidence.evidenceId}`]);
    expect(counts).toEqual({ receipts: "1", lots: "1" });

    await expect(persistCryptoReceiptEvidence({
      ...evidence,
      asset: evidence.asset,
      providerFeeQuantity: "0.06",
      netQuantity: "9.94",
      feeVndValue: 1500,
      orderId: `order_${suffix}`,
      paymentEntryId: "00000000-0000-4000-8000-100000000002",
    })).rejects.toMatchObject({ code: "conflicting_crypto_receipt_evidence" });
  });

  it("records manual off-ramp FIFO disposal, keeps USDTTRC20 and native USDCMATIC separate, and reconciles quantity/carrying value", async () => {
    const suffix = `${runId}_recon`;
    const usdt = evidenceFromFixture(0, suffix, {
      merchantId: `merchant_${suffix}`,
      storeId: `store_${suffix}`,
      destinationWalletRef: `wallet_usdt_${suffix}`,
    });
    const usdc = evidenceFromFixture(1, suffix, {
      merchantId: `merchant_${suffix}`,
      storeId: `store_${suffix}`,
      destinationWalletRef: `wallet_usdc_${suffix}`,
    });

    await persistCryptoReceiptEvidence({ ...usdt, asset: usdt.asset, orderId: `order_usdt_${suffix}`, paymentEntryId: "00000000-0000-4000-8000-100000000003" });
    await persistCryptoReceiptEvidence({ ...usdc, asset: usdc.asset, orderId: `order_usdc_${suffix}`, paymentEntryId: "00000000-0000-4000-8000-100000000004" });

    const disposal = await recordManualCryptoTreasuryEvent({
      treasuryEventId: `treasury_${suffix}`,
      merchantId: usdt.merchantId,
      storeId: usdt.storeId,
      eventType: "off_ramp",
      retailCryptoAsset: "USDTTRC20",
      sourceWalletRef: usdt.destinationWalletRef,
      quantity: "9.95",
      proceedsVnd: 260000,
      feeVndValue: 1000,
      manualReason: "owner-approved off-ramp fixture; manual evidence only, no automated tax claim",
      evidencePayload: { bankReference: `bank_${suffix}` },
      createdBy: "db_test",
      eventDate: "2026-06-21",
    });

    expect(disposal).toMatchObject({
      quantity: "9.95",
      carryingValueRemovedVnd: 248750,
      proceedsVnd: 260000,
      feeVndValue: 1000,
      gainVnd: 11250,
      lossVnd: 0,
    });
    const duplicateDisposal = await recordManualCryptoTreasuryEvent({
      treasuryEventId: `treasury_${suffix}`,
      merchantId: usdt.merchantId,
      storeId: usdt.storeId,
      eventType: "off_ramp",
      retailCryptoAsset: "USDTTRC20",
      sourceWalletRef: usdt.destinationWalletRef,
      quantity: "9.95",
      proceedsVnd: 260000,
      feeVndValue: 1000,
      manualReason: "owner-approved off-ramp fixture; manual evidence only, no automated tax claim",
      evidencePayload: { bankReference: `bank_${suffix}` },
      createdBy: "db_test",
      eventDate: "2026-06-21",
    });
    expect(duplicateDisposal.id).toBe(disposal.id);
    await expect(recordManualCryptoTreasuryEvent({
      treasuryEventId: `treasury_${suffix}`,
      merchantId: usdt.merchantId,
      storeId: usdt.storeId,
      eventType: "off_ramp",
      retailCryptoAsset: "USDTTRC20",
      sourceWalletRef: usdt.destinationWalletRef,
      quantity: "9.95",
      proceedsVnd: 250000,
      feeVndValue: 1000,
      manualReason: "owner-approved off-ramp fixture; manual evidence only, no automated tax claim",
      createdBy: "db_test",
    })).rejects.toMatchObject({ code: "conflicting_crypto_treasury_event" });
    await expectBalanced("crypto_treasury_event", `treasury_${suffix}`);
    expect(await journalLines("crypto_treasury_event", `treasury_${suffix}`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ account_code: "1121", debit_amount: "259000.00", credit_amount: "0.00" }),
      expect.objectContaining({ account_code: "1122", debit_amount: "0.00", credit_amount: "248750.00" }),
      expect.objectContaining({ account_code: "5152", debit_amount: "0.00", credit_amount: "11250.00" }),
      expect.objectContaining({ account_code: "6423", debit_amount: "1000.00", credit_amount: "0.00" }),
    ]));

    const reconciliation = await getCryptoAssetReconciliation({ merchantId: usdt.merchantId });
    const usdtRow = reconciliation.data.find((row) => row.retailCryptoAsset === "USDTTRC20");
    const usdcRow = reconciliation.data.find((row) => row.retailCryptoAsset === "USDCMATIC");
    expect(usdtRow).toMatchObject({
      asset: "USDT",
      network: "TRC20",
      grossQuantity: "10",
      providerFeeQuantity: "0.05",
      netReceiptQuantity: "9.95",
      disposedQuantity: "9.95",
      remainingQuantity: "0",
      carryingValueReceivedVnd: 248750,
      carryingValueRemovedVnd: 248750,
      remainingCarryingValueVnd: 0,
      status: "manual_evidence_only_no_tax_or_revaluation_claim",
    });
    expect(usdcRow).toMatchObject({
      asset: "USDC",
      network: "MATIC",
      grossQuantity: "20",
      providerFeeQuantity: "0.02",
      netReceiptQuantity: "19.98",
      remainingQuantity: "19.98",
      carryingValueReceivedVnd: 499500,
      status: "manual_evidence_only_no_tax_or_revaluation_claim",
    });
  });

  it("persists exact 18-decimal quantities without JavaScript number drift", async () => {
    const suffix = `${runId}_decimal`;
    const evidence = evidenceFromFixture(0, suffix, {
      grossQuantity: "1.000000000000000001",
      providerFeeQuantity: "0.000000000000000001",
      netQuantity: "1",
      grossVndValue: 25000,
      feeVndValue: 1,
    });
    const result = await withConnectedTransaction((tx) => persistCryptoReceiptEvidenceForClient(tx, {
      ...evidence,
      asset: evidence.asset,
      orderId: `order_${suffix}`,
      paymentEntryId: "00000000-0000-4000-8000-100000000005",
    }));
    expect(result).toMatchObject({
      grossQuantity: "1.000000000000000001",
      providerFeeQuantity: "0.000000000000000001",
      netQuantity: "1",
    });
  });
});
