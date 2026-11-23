import { randomUUID } from "node:crypto";
import { CryptoReceiptEvidenceSchema, type CryptoReceiptEvidence, type RetailCryptoAsset } from "../contract-seams";
import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedTransaction } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import {
  findCryptoSaleEvidenceForClient,
  findExistingCryptoReceiptForClient,
} from "../repositories/crypto-receipt-evidence-repository";
import {
  findCryptoTreasuryEventIdentityForClient,
  listCryptoReconciliationRowsForClient,
} from "../repositories/crypto-treasury-repository";
import { insertJournalEntryForClient } from "./accounting-service";

export type CryptoTreasuryEventType = "manual_transfer" | "off_ramp" | "disposal";

export interface PersistCryptoReceiptEvidenceInput extends Omit<CryptoReceiptEvidence, "asset"> {
  asset: RetailCryptoAsset;
  orderId?: string;
  paymentEntryId?: string;
  providerPaymentId?: string;
  provider?: "nowpayments";
  feeAsset?: "USDT" | "USDC";
  custodyAccountRef?: string;
  providerConfigId?: string;
  providerConfigPurpose?: "merchant_retail";
  walletProvenance?: Record<string, unknown>;
  quoteId?: string;
  quotePayload?: Record<string, unknown>;
  valuationRate?: string | number;
  netVndValue?: number;
  carryingValueVnd?: number;
  saleJournalEntryId?: string;
  feeJournalEntryId?: string;
  evidencePayload?: Record<string, unknown>;
  createdBy?: string;
}

export interface CryptoReceiptEvidenceResult {
  id: string;
  evidenceId: string;
  lotId: string;
  merchantId: string;
  storeId: string;
  orderId: string | null;
  paymentEntryId: string | null;
  paymentIntentId: string;
  providerEventId: string;
  asset: "USDT" | "USDC";
  network: "TRC20" | "MATIC";
  retailCryptoAsset: RetailCryptoAsset;
  grossQuantity: string;
  providerFeeQuantity: string;
  netQuantity: string;
  grossVndValue: number;
  feeVndValue: number;
  netVndValue: number;
  carryingValueVnd: number;
  destinationWalletRef: string;
  txHash: string;
  saleJournalEntryId: string | null;
  feeJournalEntryId: string | null;
}

export interface ManualCryptoTreasuryEventInput {
  treasuryEventId: string;
  merchantId: string;
  storeId?: string;
  eventType: CryptoTreasuryEventType;
  retailCryptoAsset: RetailCryptoAsset;
  sourceWalletRef: string;
  destinationWalletRef?: string;
  quantity: string | number;
  proceedsVnd?: number;
  feeQuantity?: string | number;
  feeVndValue?: number;
  manualReason: string;
  evidencePayload?: Record<string, unknown>;
  createdBy: string;
  eventDate?: string;
}

export interface CryptoTreasuryEventResult {
  id: string;
  treasuryEventId: string;
  eventType: CryptoTreasuryEventType;
  retailCryptoAsset: RetailCryptoAsset;
  quantity: string;
  feeQuantity: string;
  carryingValueRemovedVnd: number;
  proceedsVnd: number;
  feeVndValue: number;
  gainVnd: number;
  lossVnd: number;
  journalEntryId: string | null;
  lotApplications: Array<{ lotId: string; quantityRemoved: string; carryingValueRemovedVnd: number }>;
}

export interface CryptoReconciliationRow {
  merchantId: string;
  walletRef: string;
  asset: "USDT" | "USDC";
  network: "TRC20" | "MATIC";
  retailCryptoAsset: RetailCryptoAsset;
  grossQuantity: string;
  providerFeeQuantity: string;
  netReceiptQuantity: string;
  disposedQuantity: string;
  remainingQuantity: string;
  grossVndValue: number;
  feeVndValue: number;
  carryingValueReceivedVnd: number;
  carryingValueRemovedVnd: number;
  remainingCarryingValueVnd: number;
  status: "manual_evidence_only_no_tax_or_revaluation_claim";
}

const QUANTITY_SCALE_DIGITS = 18;
const QUANTITY_SCALE = 10n ** BigInt(QUANTITY_SCALE_DIGITS);

function splitAssetNetwork(retailCryptoAsset: RetailCryptoAsset): { asset: "USDT" | "USDC"; network: "TRC20" | "MATIC" } {
  if (retailCryptoAsset === "USDTTRC20") return { asset: "USDT", network: "TRC20" };
  if (retailCryptoAsset === "USDCMATIC") return { asset: "USDC", network: "MATIC" };
  throw new PlatformError("validation_error", "Only USDTTRC20 and USDCMATIC are supported", 400);
}

function requireText(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new PlatformError("validation_error", `${field} is required`, 400);
  return text;
}

function parseQuantityUnits(value: unknown, field: string, options: { positive?: boolean } = {}): bigint {
  const text = requireText(value, field);
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text);
  if (!match) {
    throw new PlatformError("validation_error", `${field} must be a non-negative decimal with at most 18 decimals`, 400);
  }
  const whole = BigInt(match[1]);
  const fractional = (match[2] || "").padEnd(QUANTITY_SCALE_DIGITS, "0");
  const units = whole * QUANTITY_SCALE + BigInt(fractional || "0");
  if (options.positive && units <= 0n) {
    throw new PlatformError("validation_error", `${field} must be greater than zero`, 400);
  }
  return units;
}

function quantityText(value: unknown, field: string): string {
  return unitsToQuantityText(parseQuantityUnits(value, field));
}

function positiveQuantityText(value: unknown, field: string): string {
  return unitsToQuantityText(parseQuantityUnits(value, field, { positive: true }));
}

function unitsToQuantityText(units: bigint): string {
  if (units < 0n) throw new PlatformError("validation_error", "quantity cannot be negative", 400);
  const whole = units / QUANTITY_SCALE;
  const fractional = units % QUANTITY_SCALE;
  if (fractional === 0n) return whole.toString();
  return `${whole}.${fractional.toString().padStart(QUANTITY_SCALE_DIGITS, "0").replace(/0+$/, "")}`;
}

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new PlatformError("validation_error", "division by zero", 400);
  return (numerator + denominator / 2n) / denominator;
}

function wholeVnd(value: unknown, field: string): number {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount < 0) throw new PlatformError("validation_error", `${field} must be a non-negative VND amount`, 400);
  return Math.round(amount);
}

function valuationRateText(input: PersistCryptoReceiptEvidenceInput, grossVndValue: number, grossQuantity: string): string {
  if (input.valuationRate !== undefined && input.valuationRate !== null) {
    const text = String(input.valuationRate);
    if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) {
      throw new PlatformError("validation_error", "valuationRate must be positive", 400);
    }
    return text;
  }
  const quantity = Number(grossQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new PlatformError("validation_error", "grossQuantity must be positive", 400);
  return (grossVndValue / quantity).toFixed(12);
}

function sameText(left: unknown, right: unknown): boolean {
  return String(left ?? "") === String(right ?? "");
}

function sameQuantity(left: unknown, right: unknown): boolean {
  return parseQuantityUnits(left, "existingQuantity") === parseQuantityUnits(right, "incomingQuantity");
}

function rowToReceiptResult(row: Record<string, unknown>): CryptoReceiptEvidenceResult {
  return {
    id: String(row.id),
    evidenceId: String(row.evidence_id),
    lotId: String(row.lot_id),
    merchantId: String(row.merchant_id),
    storeId: String(row.store_id),
    orderId: row.order_id ? String(row.order_id) : null,
    paymentEntryId: row.payment_entry_id ? String(row.payment_entry_id) : null,
    paymentIntentId: String(row.payment_intent_id),
    providerEventId: String(row.provider_event_id),
    asset: String(row.asset) as "USDT" | "USDC",
    network: String(row.network) as "TRC20" | "MATIC",
    retailCryptoAsset: String(row.retail_crypto_asset) as RetailCryptoAsset,
    grossQuantity: unitsToQuantityText(parseQuantityUnits(row.gross_quantity, "gross_quantity")),
    providerFeeQuantity: unitsToQuantityText(parseQuantityUnits(row.provider_fee_quantity, "provider_fee_quantity")),
    netQuantity: unitsToQuantityText(parseQuantityUnits(row.net_quantity, "net_quantity")),
    grossVndValue: Number(row.gross_vnd_value),
    feeVndValue: Number(row.fee_vnd_value),
    netVndValue: Number(row.net_vnd_value),
    carryingValueVnd: Number(row.carrying_value_vnd),
    destinationWalletRef: String(row.destination_wallet_ref),
    txHash: String(row.tx_hash),
    saleJournalEntryId: row.sale_journal_entry_id ? String(row.sale_journal_entry_id) : null,
    feeJournalEntryId: row.fee_journal_entry_id ? String(row.fee_journal_entry_id) : null,
  };
}

function assertExistingReceiptMatches(
  existing: Record<string, unknown>,
  input: {
    parsed: CryptoReceiptEvidence;
    provider: string;
    split: { asset: "USDT" | "USDC"; network: "TRC20" | "MATIC" };
    orderId: string | null;
    paymentEntryId: string | null;
    providerPaymentId: string | null;
    grossQuantity: string;
    providerFeeQuantity: string;
    netQuantity: string;
    grossVndValue: number;
    feeVndValue: number;
    netVndValue: number;
    carryingValueVnd: number;
  },
): void {
  const checks = [
    sameText(existing.evidence_id, input.parsed.evidenceId),
    sameText(existing.provider, input.provider),
    sameText(existing.provider_event_id, input.parsed.providerEventId),
    sameText(existing.merchant_id, input.parsed.merchantId),
    sameText(existing.store_id, input.parsed.storeId),
    sameText(existing.payment_intent_id, input.parsed.paymentIntentId),
    sameText(existing.asset, input.split.asset),
    sameText(existing.network, input.split.network),
    sameText(existing.retail_crypto_asset, input.parsed.asset),
    sameText(existing.tx_hash, input.parsed.transactionHash),
    sameText(existing.destination_wallet_ref, input.parsed.destinationWalletRef),
    sameQuantity(existing.gross_quantity, input.grossQuantity),
    sameQuantity(existing.provider_fee_quantity, input.providerFeeQuantity),
    sameQuantity(existing.net_quantity, input.netQuantity),
    Number(existing.gross_vnd_value) === input.grossVndValue,
    Number(existing.fee_vnd_value) === input.feeVndValue,
    Number(existing.net_vnd_value) === input.netVndValue,
    Number(existing.carrying_value_vnd) === input.carryingValueVnd,
  ];
  if (input.orderId) checks.push(sameText(existing.order_id, input.orderId));
  if (input.paymentEntryId) checks.push(sameText(existing.payment_entry_id, input.paymentEntryId));
  if (input.providerPaymentId) checks.push(sameText(existing.provider_payment_id, input.providerPaymentId));
  if (checks.some((ok) => !ok)) {
    throw new PlatformError("conflicting_crypto_receipt_evidence", "Duplicate crypto receipt evidence conflicts with existing accounting evidence", 409, {
      evidenceId: input.parsed.evidenceId,
      providerEventId: input.parsed.providerEventId,
    });
  }
}

async function ensureProviderFeeJournal(
  client: PoolClient,
  input: {
    evidenceId: string;
    merchantId: string;
    storeId: string;
    feeVndValue: number;
    createdBy: string;
    entryDate: string;
  },
): Promise<string | null> {
  if (input.feeVndValue <= 0) return null;
  const existing = await queryOne<{ id: string }>(client, `
    SELECT id::text
    FROM accounting.journal_entries
    WHERE reference_type = 'crypto_provider_fee' AND reference_id = $1
  `, [input.evidenceId]);
  if (existing) return existing.id;
  const entry = await insertJournalEntryForClient(client, {
    entryDate: input.entryDate,
    referenceType: "crypto_provider_fee",
    referenceId: input.evidenceId,
    description: `Crypto provider fee - ${input.evidenceId}`,
    status: "posted",
    createdBy: input.createdBy,
    merchantId: input.merchantId,
    storeId: input.storeId,
    lines: [
      { accountCode: "6423", debitAmount: input.feeVndValue, creditAmount: 0, description: "Provider/network fee from verified crypto receipt" },
      { accountCode: "1122", debitAmount: 0, creditAmount: input.feeVndValue, description: "Stablecoin asset reduced by provider fee" },
    ],
  });
  return String(entry.id);
}

export async function persistCryptoReceiptEvidenceForClient(
  client: PoolClient,
  input: PersistCryptoReceiptEvidenceInput,
): Promise<CryptoReceiptEvidenceResult> {
  const parsed = CryptoReceiptEvidenceSchema.parse({
    ...input,
    asset: input.asset,
  });
  const provider = input.provider || "nowpayments";
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`crypto-receipt:${provider}:${parsed.providerEventId}:${parsed.evidenceId}`]);

  const grossUnits = parseQuantityUnits(parsed.grossQuantity, "grossQuantity", { positive: true });
  const providerFeeUnits = parseQuantityUnits(parsed.providerFeeQuantity, "providerFeeQuantity");
  const netUnits = parseQuantityUnits(parsed.netQuantity, "netQuantity");
  if (providerFeeUnits > grossUnits || grossUnits - providerFeeUnits !== netUnits) {
    throw new PlatformError("validation_error", "Crypto gross quantity must equal provider fee plus net quantity", 400);
  }
  const grossQuantity = unitsToQuantityText(grossUnits);
  const providerFeeQuantity = unitsToQuantityText(providerFeeUnits);
  const netQuantity = unitsToQuantityText(netUnits);
  const split = splitAssetNetwork(parsed.asset);
  const grossVndValue = wholeVnd(parsed.grossVndValue, "grossVndValue");
  const feeVndValue = wholeVnd(parsed.feeVndValue, "feeVndValue");
  if (feeVndValue > grossVndValue) throw new PlatformError("validation_error", "feeVndValue cannot exceed grossVndValue", 400);
  const netVndValue = wholeVnd(input.netVndValue ?? grossVndValue - feeVndValue, "netVndValue");
  const carryingValueVnd = wholeVnd(input.carryingValueVnd ?? netVndValue, "carryingValueVnd");
  const valuationRate = valuationRateText(input, grossVndValue, grossQuantity);
  const lotId = `lot_${parsed.evidenceId}`;
  const orderId = input.orderId || null;
  const paymentEntryId = input.paymentEntryId || null;
  const providerPaymentId = input.providerPaymentId || null;
  const createdBy = input.createdBy || "system";
  const entryDate = new Date(parsed.valuationTimestamp).toISOString().slice(0, 10);

  const existing = await findExistingCryptoReceiptForClient(client, {
    evidenceId: parsed.evidenceId,
    provider,
    providerEventId: parsed.providerEventId,
    merchantId: parsed.merchantId,
    walletRef: parsed.destinationWalletRef,
    retailCryptoAsset: parsed.asset,
    txHash: parsed.transactionHash,
  });
  if (existing) {
    assertExistingReceiptMatches(existing, {
      parsed,
      provider,
      split,
      orderId,
      paymentEntryId,
      providerPaymentId,
      grossQuantity,
      providerFeeQuantity,
      netQuantity,
      grossVndValue,
      feeVndValue,
      netVndValue,
      carryingValueVnd,
    });
    if (!existing.lot_id) {
      await client.query(`
        INSERT INTO accounting.crypto_asset_lots (
          lot_id, receipt_evidence_id, merchant_id, store_id, asset, network, retail_crypto_asset,
          wallet_ref, original_quantity, remaining_quantity, original_carrying_value_vnd,
          remaining_carrying_value_vnd, valuation_rate, acquired_at
        ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $9, $10, $10, $11, $12)
        ON CONFLICT (lot_id) DO NOTHING
      `, [
        lotId,
        existing.id,
        parsed.merchantId,
        parsed.storeId,
        split.asset,
        split.network,
        parsed.asset,
        parsed.destinationWalletRef,
        netQuantity,
        carryingValueVnd,
        valuationRate,
        parsed.valuationTimestamp,
      ]);
    }
    return rowToReceiptResult({ ...existing, lot_id: existing.lot_id || lotId });
  }

  const feeJournalEntryId = input.feeJournalEntryId ?? await ensureProviderFeeJournal(client, {
    evidenceId: parsed.evidenceId,
    merchantId: parsed.merchantId,
    storeId: parsed.storeId,
    feeVndValue,
    createdBy,
    entryDate,
  });

  const inserted = await client.query<Record<string, unknown>>(`
    INSERT INTO accounting.crypto_receipt_evidence (
      evidence_id, provider, provider_event_id, merchant_id, store_id, order_id, payment_entry_id,
      payment_intent_id, provider_payment_id, asset, network, retail_crypto_asset,
      gross_quantity, provider_fee_quantity, net_quantity, fee_asset, tx_hash,
      destination_wallet_ref, custody_account_ref, provider_config_id, provider_config_purpose,
      wallet_provenance, quote_id, quote_payload, valuation_rate, valuation_rate_source,
      valuation_timestamp, gross_vnd_value, fee_vnd_value, net_vnd_value, carrying_value_vnd,
      sale_journal_entry_id, fee_journal_entry_id, evidence_payload, created_by
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::uuid, $8, $9, $10, $11, $12,
      $13, $14, $15, $16, $17, $18, $19, $20, $21,
      $22::jsonb, $23, $24::jsonb, $25, $26, $27, $28, $29, $30, $31,
      $32::uuid, $33::uuid, $34::jsonb, $35
    )
    RETURNING *
  `, [
    parsed.evidenceId,
    provider,
    parsed.providerEventId,
    parsed.merchantId,
    parsed.storeId,
    orderId,
    paymentEntryId,
    parsed.paymentIntentId,
    providerPaymentId,
    split.asset,
    split.network,
    parsed.asset,
    grossQuantity,
    providerFeeQuantity,
    netQuantity,
    input.feeAsset || split.asset,
    parsed.transactionHash,
    parsed.destinationWalletRef,
    input.custodyAccountRef || null,
    input.providerConfigId || null,
    input.providerConfigPurpose || "merchant_retail",
    JSON.stringify(input.walletProvenance || {}),
    input.quoteId || null,
    JSON.stringify(input.quotePayload || {}),
    valuationRate,
    parsed.valuationRateSource,
    parsed.valuationTimestamp,
    grossVndValue,
    feeVndValue,
    netVndValue,
    carryingValueVnd,
    input.saleJournalEntryId || null,
    feeJournalEntryId,
    JSON.stringify(input.evidencePayload || parsed),
    createdBy,
  ]);

  const receipt = inserted.rows[0];
  await client.query<Record<string, unknown>>(`
    INSERT INTO accounting.crypto_asset_lots (
      lot_id, receipt_evidence_id, merchant_id, store_id, asset, network, retail_crypto_asset,
      wallet_ref, original_quantity, remaining_quantity, original_carrying_value_vnd,
      remaining_carrying_value_vnd, valuation_rate, acquired_at
    ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $9, $10, $10, $11, $12)
  `, [
    lotId,
    receipt.id,
    parsed.merchantId,
    parsed.storeId,
    split.asset,
    split.network,
    parsed.asset,
    parsed.destinationWalletRef,
    netQuantity,
    carryingValueVnd,
    valuationRate,
    parsed.valuationTimestamp,
  ]);

  return rowToReceiptResult({ ...receipt, lot_id: lotId });
}

export async function persistCryptoReceiptEvidence(input: PersistCryptoReceiptEvidenceInput): Promise<CryptoReceiptEvidenceResult> {
  await ensurePlatformSchema();
  return withConnectedTransaction((client) => persistCryptoReceiptEvidenceForClient(client, input));
}

export async function persistCryptoReceiptEvidenceFromSaleForClient(
  client: PoolClient,
  salePayload: Record<string, unknown>,
  saleJournalEntryId?: string | null,
): Promise<CryptoReceiptEvidenceResult | null> {
  const orderId = String(salePayload.orderId || "");
  const paymentEntryId = String(salePayload.paymentEntryId || "");
  const paymentIntentId = String(salePayload.paymentIntentId || "");
  const providerEventId = String(salePayload.providerEventId || "");
  if (!orderId && !paymentEntryId && !paymentIntentId && !providerEventId) return null;

  const row = await findCryptoSaleEvidenceForClient(client, {
    orderId,
    paymentEntryId,
    paymentIntentId,
    providerEventId,
  });
  if (!row?.crypto_receipt_evidence) return null;

  const evidence = CryptoReceiptEvidenceSchema.parse(row.crypto_receipt_evidence) as CryptoReceiptEvidence;
  const intentMetadata = row.intent_metadata && typeof row.intent_metadata === "object"
    ? row.intent_metadata as Record<string, unknown>
    : {};
  const providerMetadata = intentMetadata.provider && typeof intentMetadata.provider === "object"
    ? intentMetadata.provider as Record<string, unknown>
    : {};
  const quote = providerMetadata.quote && typeof providerMetadata.quote === "object"
    ? providerMetadata.quote as Record<string, unknown>
    : {};
  return persistCryptoReceiptEvidenceForClient(client, {
    ...evidence,
    asset: evidence.asset,
    orderId: String(row.order_id || orderId || ""),
    paymentEntryId: String(row.payment_entry_id || paymentEntryId || "") || undefined,
    provider: String(row.provider || "nowpayments") as "nowpayments",
    providerPaymentId: String(row.provider_event_id || evidence.providerEventId),
    providerConfigId: row.provider_config_id ? String(row.provider_config_id) : undefined,
    providerConfigPurpose: row.provider_config_purpose === "merchant_retail" ? "merchant_retail" : "merchant_retail",
    walletProvenance: {
      destinationWalletRef: evidence.destinationWalletRef,
      providerConfigId: row.provider_config_id || null,
      providerConfigPurpose: row.provider_config_purpose || "merchant_retail",
    },
    quoteId: typeof quote.quoteId === "string" ? quote.quoteId : undefined,
    quotePayload: Object.keys(quote).length > 0 ? quote : {
      valuationRateSource: evidence.valuationRateSource,
      valuationTimestamp: evidence.valuationTimestamp,
    },
    valuationRate: typeof quote.vndUsdRate === "number" || typeof quote.vndUsdRate === "string"
      ? quote.vndUsdRate
      : undefined,
    saleJournalEntryId: saleJournalEntryId || undefined,
    evidencePayload: { ...evidence },
    createdBy: "system",
  });
}

type LotRow = {
  id: string;
  lot_id: string;
  remaining_quantity: string;
  remaining_carrying_value_vnd: string;
  store_id: string;
};

export async function recordManualCryptoTreasuryEvent(input: ManualCryptoTreasuryEventInput): Promise<CryptoTreasuryEventResult> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const treasuryEventId = requireText(input.treasuryEventId, "treasuryEventId");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`crypto-treasury-event:${treasuryEventId}`]);
    const merchantId = requireText(input.merchantId, "merchantId");
    const sourceWalletRef = requireText(input.sourceWalletRef, "sourceWalletRef");
    const manualReason = requireText(input.manualReason, "manualReason");
    const quantityUnits = parseQuantityUnits(input.quantity, "quantity", { positive: true });
    const feeUnits = parseQuantityUnits(input.feeQuantity ?? 0, "feeQuantity");
    const removalUnits = quantityUnits + feeUnits;
    const quantity = unitsToQuantityText(quantityUnits);
    const feeQuantity = unitsToQuantityText(feeUnits);
    const split = splitAssetNetwork(input.retailCryptoAsset);
    const proceedsVnd = wholeVnd(input.proceedsVnd || 0, "proceedsVnd");
    const feeVndValue = wholeVnd(input.feeVndValue || 0, "feeVndValue");
    const existingRow = await findCryptoTreasuryEventIdentityForClient(client, treasuryEventId);
    if (existingRow) {
      const sameExistingEvent = [
        sameText(existingRow.merchant_id, merchantId),
        sameText(existingRow.store_id || "", input.storeId || ""),
        sameText(existingRow.event_type, input.eventType),
        sameText(existingRow.retail_crypto_asset, input.retailCryptoAsset),
        sameText(existingRow.source_wallet_ref, sourceWalletRef),
        sameText(existingRow.destination_wallet_ref || "", input.destinationWalletRef || ""),
        sameQuantity(existingRow.quantity, quantity),
        sameQuantity(existingRow.fee_quantity, feeQuantity),
        Number(existingRow.proceeds_vnd) === proceedsVnd,
        Number(existingRow.fee_vnd_value) === feeVndValue,
        sameText(existingRow.manual_reason, manualReason),
        sameText(existingRow.created_by, requireText(input.createdBy, "createdBy")),
      ].every(Boolean);
      if (!sameExistingEvent) {
        throw new PlatformError("conflicting_crypto_treasury_event", "Duplicate treasury event ID conflicts with the existing manual command", 409, {
          treasuryEventId,
        });
      }
      return (await getCryptoTreasuryEventByBusinessId(client, treasuryEventId))!;
    }

    const lots = await client.query<LotRow>(`
      SELECT id::text, lot_id, remaining_quantity::text, remaining_carrying_value_vnd::text, store_id
      FROM accounting.crypto_asset_lots
      WHERE merchant_id = $1
        AND wallet_ref = $2
        AND retail_crypto_asset = $3
        AND status = 'open'
        AND remaining_quantity > 0
      ORDER BY acquired_at ASC, id ASC
      FOR UPDATE
    `, [merchantId, sourceWalletRef, input.retailCryptoAsset]);

    let remainingToRemove = removalUnits;
    let carryingValueRemovedUnits = 0n;
    const applications: Array<{ id: string; lotId: string; quantityRemoved: string; carryingValueRemovedVnd: number }> = [];
    for (const lot of lots.rows) {
      if (remainingToRemove <= 0n) break;
      const lotUnits = parseQuantityUnits(lot.remaining_quantity, "lot.remaining_quantity");
      const removedUnits = lotUnits < remainingToRemove ? lotUnits : remainingToRemove;
      const lotCarry = BigInt(Math.round(Number(lot.remaining_carrying_value_vnd)));
      const removedCarry = removedUnits === lotUnits
        ? lotCarry
        : roundDiv(lotCarry * removedUnits, lotUnits);
      applications.push({
        id: lot.id,
        lotId: lot.lot_id,
        quantityRemoved: unitsToQuantityText(removedUnits),
        carryingValueRemovedVnd: Number(removedCarry),
      });
      carryingValueRemovedUnits += removedCarry;
      remainingToRemove -= removedUnits;
    }

    if (remainingToRemove > 0n) {
      throw new PlatformError("validation_error", "Insufficient crypto lot quantity for treasury event", 400);
    }

    const carryingValueRemovedVnd = Number(carryingValueRemovedUnits);
    if (feeVndValue > proceedsVnd) {
      throw new PlatformError("validation_error", "feeVndValue cannot exceed proceedsVnd for an off-ramp/disposal", 400);
    }
    const netCashProceedsVnd = Math.max(0, proceedsVnd - feeVndValue);
    const gainVnd = Math.max(0, proceedsVnd - carryingValueRemovedVnd);
    const lossVnd = Math.max(0, carryingValueRemovedVnd - proceedsVnd);
    const storeId = input.storeId || lots.rows[0]?.store_id || null;

    const event = await client.query<Record<string, unknown>>(`
      INSERT INTO accounting.crypto_treasury_events (
        treasury_event_id, merchant_id, store_id, event_type, asset, network, retail_crypto_asset,
        source_wallet_ref, destination_wallet_ref, quantity, proceeds_vnd, fee_quantity, fee_vnd_value,
        carrying_value_removed_vnd, gain_vnd, loss_vnd, evidence_payload, manual_reason, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19)
      RETURNING id::text
    `, [
      treasuryEventId,
      merchantId,
      storeId,
      input.eventType,
      split.asset,
      split.network,
      input.retailCryptoAsset,
      sourceWalletRef,
      input.destinationWalletRef || null,
      quantity,
      proceedsVnd,
      feeQuantity,
      feeVndValue,
      carryingValueRemovedVnd,
      gainVnd,
      lossVnd,
      JSON.stringify(input.evidencePayload || {}),
      manualReason,
      requireText(input.createdBy, "createdBy"),
    ]);

    for (const application of applications) {
      await client.query(`
        INSERT INTO accounting.crypto_treasury_event_lots (treasury_event_id, lot_id, quantity_removed, carrying_value_removed_vnd)
        VALUES ($1::uuid, $2::uuid, $3, $4)
      `, [event.rows[0].id, application.id, application.quantityRemoved, application.carryingValueRemovedVnd]);
      await client.query(`
        UPDATE accounting.crypto_asset_lots
        SET remaining_quantity = GREATEST(0, remaining_quantity - $2::numeric),
            remaining_carrying_value_vnd = GREATEST(0, remaining_carrying_value_vnd - $3::numeric),
            status = CASE WHEN remaining_quantity - $2::numeric <= 0 THEN 'closed' ELSE 'open' END,
            updated_at = now()
        WHERE id = $1::uuid
      `, [application.id, application.quantityRemoved, application.carryingValueRemovedVnd]);
    }

    const journalEntry = await insertJournalEntryForClient(client, {
      entryDate: input.eventDate || new Date().toISOString().slice(0, 10),
      referenceType: "crypto_treasury_event",
      referenceId: treasuryEventId,
      description: `Crypto treasury ${input.eventType} - ${treasuryEventId}`,
      status: "posted",
      createdBy: input.createdBy,
      merchantId,
      storeId,
      lines: [
        ...(netCashProceedsVnd > 0 ? [{ accountCode: "1121", debitAmount: netCashProceedsVnd, creditAmount: 0, description: "Manual crypto net proceeds" }] : []),
        ...(feeVndValue > 0 ? [{ accountCode: "6423", debitAmount: feeVndValue, creditAmount: 0, description: "Crypto treasury provider/network fee" }] : []),
        ...(lossVnd > 0 ? [{ accountCode: "6351", debitAmount: lossVnd, creditAmount: 0, description: "Crypto disposal loss" }] : []),
        { accountCode: "1122", debitAmount: 0, creditAmount: carryingValueRemovedVnd, description: "Remove stablecoin carrying value" },
        ...(gainVnd > 0 ? [{ accountCode: "5152", debitAmount: 0, creditAmount: gainVnd, description: "Crypto disposal gain" }] : []),
      ],
    });
    await client.query("UPDATE accounting.crypto_treasury_events SET journal_entry_id = $1::uuid WHERE id = $2::uuid", [journalEntry.id, event.rows[0].id]);

    return (await getCryptoTreasuryEventByBusinessId(client, treasuryEventId))!;
  });
}

async function getCryptoTreasuryEventByBusinessId(client: PoolClient, treasuryEventId: string): Promise<CryptoTreasuryEventResult | null> {
  const row = await queryOne<Record<string, unknown>>(client, `
    SELECT id::text, treasury_event_id, event_type, retail_crypto_asset, quantity::text, fee_quantity::text,
      carrying_value_removed_vnd::numeric, proceeds_vnd::numeric, fee_vnd_value::numeric,
      gain_vnd::numeric, loss_vnd::numeric, journal_entry_id::text
    FROM accounting.crypto_treasury_events
    WHERE treasury_event_id = $1
  `, [treasuryEventId]);
  if (!row) return null;
  const lotRows = await client.query<Record<string, unknown>>(`
    SELECT l.lot_id, tel.quantity_removed::text, tel.carrying_value_removed_vnd::numeric
    FROM accounting.crypto_treasury_event_lots tel
    JOIN accounting.crypto_asset_lots l ON l.id = tel.lot_id
    WHERE tel.treasury_event_id = $1::uuid
    ORDER BY tel.created_at ASC
  `, [row.id]);
  return {
    id: String(row.id),
    treasuryEventId: String(row.treasury_event_id),
    eventType: String(row.event_type) as CryptoTreasuryEventType,
    retailCryptoAsset: String(row.retail_crypto_asset) as RetailCryptoAsset,
    quantity: unitsToQuantityText(parseQuantityUnits(row.quantity, "quantity")),
    feeQuantity: unitsToQuantityText(parseQuantityUnits(row.fee_quantity, "fee_quantity")),
    carryingValueRemovedVnd: Number(row.carrying_value_removed_vnd),
    proceedsVnd: Number(row.proceeds_vnd),
    feeVndValue: Number(row.fee_vnd_value),
    gainVnd: Number(row.gain_vnd),
    lossVnd: Number(row.loss_vnd),
    journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : null,
    lotApplications: lotRows.rows.map((lot) => ({
      lotId: String(lot.lot_id),
      quantityRemoved: unitsToQuantityText(parseQuantityUnits(lot.quantity_removed, "quantity_removed")),
      carryingValueRemovedVnd: Number(lot.carrying_value_removed_vnd),
    })),
  };
}

export async function getCryptoAssetReconciliation(input: {
  merchantId?: string;
  walletRef?: string;
  retailCryptoAsset?: RetailCryptoAsset;
} = {}): Promise<{ data: CryptoReconciliationRow[] }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const rows = await listCryptoReconciliationRowsForClient(client, input);

    return {
      data: rows.map((row) => ({
        merchantId: String(row.merchant_id),
        walletRef: String(row.wallet_ref),
        asset: String(row.asset) as "USDT" | "USDC",
        network: String(row.network) as "TRC20" | "MATIC",
        retailCryptoAsset: String(row.retail_crypto_asset) as RetailCryptoAsset,
        grossQuantity: unitsToQuantityText(parseQuantityUnits(row.gross_quantity, "gross_quantity")),
        providerFeeQuantity: unitsToQuantityText(parseQuantityUnits(row.provider_fee_quantity, "provider_fee_quantity")),
        netReceiptQuantity: unitsToQuantityText(parseQuantityUnits(row.net_receipt_quantity, "net_receipt_quantity")),
        disposedQuantity: unitsToQuantityText(parseQuantityUnits(row.disposed_quantity, "disposed_quantity")),
        remainingQuantity: unitsToQuantityText(parseQuantityUnits(row.remaining_quantity, "remaining_quantity")),
        grossVndValue: Number(row.gross_vnd_value),
        feeVndValue: Number(row.fee_vnd_value),
        carryingValueReceivedVnd: Number(row.carrying_value_received_vnd),
        carryingValueRemovedVnd: Number(row.carrying_value_removed_vnd),
        remainingCarryingValueVnd: Number(row.remaining_carrying_value_vnd),
        status: "manual_evidence_only_no_tax_or_revaluation_claim",
      })),
    };
  });
}

export function makeCryptoEvidenceId(prefix = "crypto_evidence"): string {
  return `${prefix}_${randomUUID()}`;
}
