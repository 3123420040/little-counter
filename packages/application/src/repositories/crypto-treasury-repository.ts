import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import type { RetailCryptoAsset } from "../contract-seams";

export async function findCryptoTreasuryEventIdentityForClient(
  client: PoolClient,
  treasuryEventId: string,
): Promise<Record<string, unknown> | null> {
  return queryOne<Record<string, unknown>>(client, `
    SELECT merchant_id, store_id, event_type, retail_crypto_asset, source_wallet_ref,
      destination_wallet_ref, quantity::text, proceeds_vnd::numeric, fee_quantity::text,
      fee_vnd_value::numeric, manual_reason, created_by
    FROM accounting.crypto_treasury_events
    WHERE treasury_event_id = $1
  `, [treasuryEventId]);
}

export async function listCryptoReconciliationRowsForClient(
  client: PoolClient,
  input: { merchantId?: string; walletRef?: string; retailCryptoAsset?: RetailCryptoAsset },
): Promise<Record<string, unknown>[]> {
  const rows = await client.query<Record<string, unknown>>(`
    WITH receipts AS (
      SELECT merchant_id, destination_wallet_ref AS wallet_ref, asset, network, retail_crypto_asset,
        SUM(gross_quantity)::text AS gross_quantity,
        SUM(provider_fee_quantity)::text AS provider_fee_quantity,
        SUM(net_quantity)::text AS net_receipt_quantity,
        SUM(gross_vnd_value)::numeric AS gross_vnd_value,
        SUM(fee_vnd_value)::numeric AS fee_vnd_value,
        SUM(carrying_value_vnd)::numeric AS carrying_value_received_vnd
      FROM accounting.crypto_receipt_evidence
      WHERE status = 'verified'
        AND ($1::text IS NULL OR merchant_id = $1)
        AND ($2::text IS NULL OR destination_wallet_ref = $2)
        AND ($3::text IS NULL OR retail_crypto_asset = $3)
      GROUP BY merchant_id, destination_wallet_ref, asset, network, retail_crypto_asset
    ), lots AS (
      SELECT merchant_id, wallet_ref, asset, network, retail_crypto_asset,
        SUM(original_quantity - remaining_quantity)::text AS disposed_quantity,
        SUM(remaining_quantity)::text AS remaining_quantity,
        SUM(original_carrying_value_vnd - remaining_carrying_value_vnd)::numeric AS carrying_value_removed_vnd,
        SUM(remaining_carrying_value_vnd)::numeric AS remaining_carrying_value_vnd
      FROM accounting.crypto_asset_lots
      WHERE ($1::text IS NULL OR merchant_id = $1)
        AND ($2::text IS NULL OR wallet_ref = $2)
        AND ($3::text IS NULL OR retail_crypto_asset = $3)
      GROUP BY merchant_id, wallet_ref, asset, network, retail_crypto_asset
    )
    SELECT r.*, COALESCE(l.disposed_quantity, '0') AS disposed_quantity,
      COALESCE(l.remaining_quantity, '0') AS remaining_quantity,
      COALESCE(l.carrying_value_removed_vnd, 0)::numeric AS carrying_value_removed_vnd,
      COALESCE(l.remaining_carrying_value_vnd, 0)::numeric AS remaining_carrying_value_vnd
    FROM receipts r
    LEFT JOIN lots l USING (merchant_id, wallet_ref, asset, network, retail_crypto_asset)
    ORDER BY r.merchant_id, r.wallet_ref, r.retail_crypto_asset
  `, [input.merchantId || null, input.walletRef || null, input.retailCryptoAsset || null]);
  return rows.rows;
}
