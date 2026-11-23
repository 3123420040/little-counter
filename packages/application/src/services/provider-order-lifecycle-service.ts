import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import { PlatformError } from "../errors/platform-error";
import { validateProviderSettlementEvidenceV1 } from "./provider-initial-posted-charge-bridge";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const invalid = (): never => { throw new PlatformError("payment_intent_lifecycle_invalid", "Persisted provider settlement scope or evidence is inconsistent", 409); };

/** Lock entity rows before the intent; SQL keeps timestamp comparisons at DB precision. */
export async function lockProviderIntentScopeForClient(client: PoolClient, intentId: string) {
  await client.query("SAVEPOINT provider_lifecycle_guard; RELEASE SAVEPOINT provider_lifecycle_guard");
  const intent = await queryOne<{ merchant_id: string; store_id: string; stock_location_id: string }>(client,
    "SELECT merchant_id,store_id,stock_location_id FROM app.payment_intents WHERE id=$1", [intentId]);
  if (!intent?.merchant_id || !intent.store_id || !intent.stock_location_id) return null;
  const merchant = await queryOne<{ status: string; version: string; eligible: boolean }>(client, `
    SELECT m.status,COALESCE(to_jsonb(m)->>'status_version','1') AS version,
      (m.status='active' OR m.status='suspended' AND EXISTS(SELECT 1 FROM app.payment_intents i
        WHERE i.id=$2 AND i.created_at < (to_jsonb(m)->>'status_changed_at')::timestamptz)) AS eligible
    FROM app.merchants m WHERE m.id=$1 FOR SHARE
  `, [intent.merchant_id, intentId]);
  const store = await queryOne<{ status: string; version: string; eligible: boolean; stock_location_id: string }>(client, `
    SELECT s.status,s.stock_location_id,COALESCE(to_jsonb(s)->>'status_version','1') AS version,
      (s.status='active' OR s.status='suspended' AND EXISTS(SELECT 1 FROM app.payment_intents i
        WHERE i.id=$3 AND i.created_at < (to_jsonb(s)->>'status_changed_at')::timestamptz)) AS eligible
    FROM app.stores s WHERE s.merchant_id=$1 AND s.id=$2 FOR SHARE
  `, [intent.merchant_id, intent.store_id, intentId]);
  if (!merchant || !store) return null;
  return { merchantId: intent.merchant_id, storeId: intent.store_id, stockLocationId: store.stock_location_id,
    merchantVersion: merchant.version, storeVersion: store.version,
    eligible: merchant.eligible === true && store.eligible === true && store.stock_location_id === intent.stock_location_id,
    suspended: merchant.status !== "active" || store.status !== "active" };
}

/** No client flag authorizes inactive commerce: every value is checked against locked facts. */
export async function verifyProviderOrderLifecycleForClient(client: PoolClient, input: {
  body: unknown; metadata: Record<string, unknown>; merchantId: string; storeId: string; stockLocationId: string;
}) {
  const intentId = input.metadata.paymentIntentId, eventId = input.metadata.providerEventId;
  const provider = input.metadata.paymentProvider;
  if (typeof intentId !== "string" || typeof eventId !== "string" || typeof provider !== "string") invalid();
  const scope = await lockProviderIntentScopeForClient(client, intentId as string);
  if (!scope?.eligible || scope.merchantId !== input.merchantId || scope.storeId !== input.storeId
    || scope.stockLocationId !== input.stockLocationId) invalid();
  const intent = await queryOne<Record<string, unknown>>(client,
    "SELECT * FROM app.payment_intents WHERE id=$1 FOR UPDATE", [intentId]);
  const event = await queryOne<Record<string, unknown>>(client, `
    SELECT * FROM app.payment_provider_events WHERE provider=$1 AND provider_event_id=$2 FOR UPDATE
  `, [provider, eventId]);
  if (!intent || !event || intent.provider !== provider || intent.status !== "paid" || intent.completed_order_id
    || event.status !== "received" || event.payment_intent_id !== intentId
    || intent.merchant_id !== input.merchantId || intent.store_id !== input.storeId
    || intent.stock_location_id !== input.stockLocationId || event.merchant_id !== input.merchantId
    || event.store_id !== input.storeId || intent.reference_code !== input.metadata.referenceCode
    || intent.business_purpose !== "retail_order" || intent.provider_config_purpose !== "merchant_retail"
    || String(intent.currency_code).toLowerCase() !== "vnd" || !isDeepStrictEqual(input.body, intent.order_input)) invalid();
  const amount = Number(intent!.amount), metadata = object(intent!.metadata), quote = object(metadata.quote);
  const provenance = object(metadata.provenance), providerMetadata = object(metadata.provider);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount !== input.metadata.amountReceived
    || quote.totals === undefined || object(quote.totals).total !== amount
    || provenance.merchantId !== input.merchantId || provenance.storeId !== input.storeId
    || provenance.stockLocationId !== input.stockLocationId) invalid();
  const payload = object(event!.payload), normalized = object(payload._normalized), verification = object(payload._verification);
  const localMockSettlement = process.env.NODE_ENV !== "production" && (
    event!.event_type === "mock.settled" && payload.local === true
    || process.env.NODE_ENV === "test" && verification.mode === "test");
  if (input.metadata.localMockSettlement !== localMockSettlement || (scope!.suspended && localMockSettlement)) invalid();
  if (!localMockSettlement) {
    if (provider !== "sepay_va" && provider !== "nowpayments") invalid();
    if (intent!.provider_config_id !== input.metadata.providerConfigId
      || providerMetadata.providerConfigId !== intent!.provider_config_id
      || providerMetadata.providerConfigPurpose !== "merchant_retail") invalid();
    try {
      validateProviderSettlementEvidenceV1({ provider, providerConfigPurpose: "merchant_retail",
        providerConfigId: intent!.provider_config_id, intentAmountMinor: amount,
        providerAmount: String(provider === "nowpayments" ? normalized.grossQuantity : event!.amount),
        providerCurrencyCode: String(event!.currency_code),
        expectedProviderAmount: String(provider === "nowpayments" ? providerMetadata.expectedProviderAmount : amount),
        expectedProviderCurrencyCode: String(provider === "nowpayments" ? providerMetadata.expectedProviderCurrency : "vnd"),
        direction: normalized.direction, verification,
      });
    } catch { invalid(); }
  }
  return { ...scope!, amount, quote, localMockSettlement };
}
