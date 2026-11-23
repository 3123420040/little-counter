import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import type { RetailCryptoAsset } from "../contract-seams";

export interface ExistingCryptoReceiptLookup {
  evidenceId: string;
  provider: string;
  providerEventId: string;
  merchantId: string;
  walletRef: string;
  retailCryptoAsset: RetailCryptoAsset;
  txHash: string;
}

export interface CryptoSaleEvidenceLookup {
  orderId: string;
  paymentEntryId: string;
  paymentIntentId: string;
  providerEventId: string;
}

export async function findExistingCryptoReceiptForClient(
  client: PoolClient,
  input: ExistingCryptoReceiptLookup,
): Promise<Record<string, unknown> | null> {
  return queryOne<Record<string, unknown>>(client, `
    SELECT r.*, l.lot_id
    FROM accounting.crypto_receipt_evidence r
    LEFT JOIN accounting.crypto_asset_lots l ON l.receipt_evidence_id = r.id
    WHERE r.evidence_id = $1
       OR (r.provider = $2 AND r.provider_event_id = $3)
       OR (
         r.merchant_id = $4
         AND r.destination_wallet_ref = $5
         AND r.retail_crypto_asset = $6
         AND r.tx_hash = $7
       )
    ORDER BY r.created_at ASC
    LIMIT 1
  `, [
    input.evidenceId,
    input.provider,
    input.providerEventId,
    input.merchantId,
    input.walletRef,
    input.retailCryptoAsset,
    input.txHash,
  ]);
}

export async function findCryptoSaleEvidenceForClient(
  client: PoolClient,
  input: CryptoSaleEvidenceLookup,
): Promise<Record<string, unknown> | null> {
  return queryOne<Record<string, unknown>>(client, `
    SELECT
      ppe.provider,
      ppe.provider_event_id,
      ppe.payment_intent_id,
      ppe.payment_entry_id::text,
      ppe.order_id,
      ppe.crypto_receipt_evidence,
      pi.provider_config_id,
      pi.provider_config_purpose,
      pi.metadata AS intent_metadata
    FROM app.payment_provider_events ppe
    LEFT JOIN app.payment_intents pi ON pi.id = ppe.payment_intent_id
    WHERE ppe.crypto_receipt_evidence IS NOT NULL
      AND (
        ($1::text <> '' AND ppe.order_id = $1)
        OR ($2::text <> '' AND ppe.payment_entry_id::text = $2)
        OR ($3::text <> '' AND ppe.payment_intent_id = $3)
        OR ($4::text <> '' AND ppe.provider_event_id = $4)
      )
    ORDER BY ppe.received_at DESC
    LIMIT 1
  `, [input.orderId, input.paymentEntryId, input.paymentIntentId, input.providerEventId]);
}
