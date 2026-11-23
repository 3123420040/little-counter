import { createHash } from "node:crypto";
import { CryptoReceiptEvidenceSchema, type CryptoReceiptEvidence, type RetailCryptoAsset } from "../contract-seams";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import type { Role } from "../middleware/auth";
import { withScopedIdempotency, isClosedIdempotencyReceiptV1, CLOSED_IDEMPOTENCY_OUTCOME_V1 } from "../db/idempotency";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import { lockProviderIntentScopeForClient } from "./provider-order-lifecycle-service";

// Stable operation codes used with withScopedIdempotency.
export const PI_OPS = {
  createPaymentIntent: "payment_intent.create",
  cancelPaymentIntent: "payment_intent.cancel",
  settleMockPaymentIntent: "payment_intent.settle_mock",
} as const;
import { id } from "../utils/id";
import type { OperatorContext } from "./auth-service";
import { requireFeature } from "./feature-entitlement-service";
import { createProviderPaidOrderForClient, preparePaymentIntentSaleInputForClient, quoteSaleForClient, type SaleInput } from "./order-service";
import {
  createProviderIntent,
  getPaymentProviderAvailability,
  resolvePaymentProviderAvailabilityForClient,
} from "./payment-provider-service";
import { resolveShiftAttributionForSale } from "./shift-service";
import { assertTelegramSalesDraftCanSettlePaymentIntent, convertTelegramSalesDraftForPaidOrder, lockTelegramSalesDraftConfirmationForClient } from "./telegram-sales-service";
import { frozenPaymentFeeQuoteContext, paymentFeeFinancialSnapshotV1 } from "./order-total-service";
import { assertLegacyPaymentIntentFinancialReadV1, paymentIntentFinancialViewV1 } from "./payment-intent-financial-projection";
import { PaymentIntentCreationReceiptInputV1Schema, PaymentIntentCreationReceiptV1Schema, permissions,
  PAYMENT_INTENT_CREATION_KEY_NAMESPACE_V1, paymentIntentCreationKeyPrefixV1 } from "@medusa-snus/contracts";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "@medusa-snus/contracts/runtime-capabilities";
import { requireScopedActorPermission } from "./permission-service";
import type { PaymentFeeHttpContractV1 } from "@medusa-snus/contracts/runtime-capabilities";

export type PaymentIntentProvider = "mock" | "sepay_va" | "nowpayments";
export type PaymentIntentStatus = "pending" | "paid" | "completed" | "expired" | "cancelled" | "manual_review" | "failed";

export interface CreatePaymentIntentInput {
  provider: PaymentIntentProvider;
  order: SaleInput;
  merchantId?: string;
  storeId?: string;
}

export interface ProviderPaymentEventInput {
  provider: PaymentIntentProvider;
  providerEventId: string;
  eventType: string;
  amount: number;
  currencyCode?: string;
  content?: string;
  referenceCode?: string;
  providerTransactionId?: string;
  providerTransactionHash?: string;
  providerNetwork?: string;
  providerPayCurrency?: string;
  providerOccurredAt?: string;
  direction?: "in" | "out" | "unknown";
  providerFeeAmount?: number;
  providerFeeCurrency?: string;
  grossQuantity?: string;
  providerFeeQuantity?: string;
  retailCryptoAsset?: RetailCryptoAsset;
  payload?: Record<string, unknown>;
  verification?: Record<string, unknown>;
}

export interface PaymentIntentRecord {
  id: string;
  provider: PaymentIntentProvider;
  status: PaymentIntentStatus;
  amount: number;
  currencyCode: string;
  orderInput: SaleInput;
  providerReference: string | null;
  referenceCode: string;
  paymentUrl: string | null;
  qrPayload: string | null;
  expiresAt: string;
  paidAt: string | null;
  completedOrderId: string | null;
  manualReviewReason: string | null;
  metadata: Record<string, unknown>;
  merchantId: string | null;
  storeId: string | null;
  stockLocationId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListPaymentIntentsInput {
  status?: PaymentIntentStatus | "all";
  provider?: PaymentIntentProvider | "all";
  limit?: number;
  offset?: number;
  merchantId?: string;
  storeId?: string;
  storeIds?: string[];
}

export interface PaymentIntentReadScope {
  merchantId?: string;
  storeId?: string;
  storeIds?: string[];
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(fn);
}

function paymentIntentScopeClause(
  scope: PaymentIntentReadScope,
  startParamIndex: number,
): { clause: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (scope.storeId) {
    values.push(scope.storeId);
    conditions.push(`store_id = $${startParamIndex + values.length - 1}`);
  }
  if (scope.storeIds?.length) {
    values.push(scope.storeIds);
    conditions.push(`store_id = ANY($${startParamIndex + values.length - 1}::text[])`);
  }
  if (scope.merchantId) {
    values.push(scope.merchantId);
    conditions.push(`merchant_id = $${startParamIndex + values.length - 1}`);
  }
  return { clause: conditions.length ? ` AND ${conditions.join(" AND ")}` : "", values };
}

function providerFeature(provider: PaymentIntentProvider) {
  return provider === "sepay_va" ? "sepay_qr_payment" : "crypto_payment";
}

function paymentMethodForProvider(provider: PaymentIntentProvider): string {
  if (provider === "sepay_va") return "sepay_va";
  if (provider === "nowpayments") return "nowpayments";
  return "mock";
}

function requireProviderGloballyEnabled(provider: PaymentIntentProvider): void {
  if (provider === "mock") return;
  const availability = getPaymentProviderAvailability();
  const current = provider === "sepay_va" ? availability.sepay_va : availability.nowpayments;
  if (!current.enabled) {
    throw new PlatformError("provider_disabled", `Payment provider is disabled: ${provider}`, 503, {
      provider,
      reason: current.reason || "provider_disabled",
    });
  }
}

async function requireScopedProviderEnabled(
  client: PoolClient,
  provider: PaymentIntentProvider,
  scope: { merchantId: string; storeId: string },
): Promise<void> {
  if (provider === "mock") return;
  const availability = await resolvePaymentProviderAvailabilityForClient(client, scope);
  const current = provider === "sepay_va" ? availability.sepay_va : availability.nowpayments;
  if (!current.enabled) {
    throw new PlatformError("provider_disabled", `Payment provider is disabled: ${provider}`, 503, {
      provider,
      reason: current.reason || "provider_disabled",
    });
  }
}

function rowToPaymentIntent(row: Record<string, unknown>): PaymentIntentRecord {
  return {
    id: String(row.id),
    provider: row.provider as PaymentIntentProvider,
    status: row.status as PaymentIntentStatus,
    amount: Number(row.amount),
    currencyCode: String(row.currency_code),
    orderInput: (row.order_input || {}) as SaleInput,
    providerReference: row.provider_reference ? String(row.provider_reference) : null,
    referenceCode: String(row.reference_code),
    paymentUrl: row.payment_url ? String(row.payment_url) : null,
    qrPayload: row.qr_payload ? String(row.qr_payload) : null,
    expiresAt: iso(row.expires_at),
    paidAt: row.paid_at ? iso(row.paid_at) : null,
    completedOrderId: row.completed_order_id ? String(row.completed_order_id) : null,
    manualReviewReason: row.manual_review_reason ? String(row.manual_review_reason) : null,
    metadata: (row.metadata || {}) as Record<string, unknown>,
    merchantId: row.merchant_id ? String(row.merchant_id) : null,
    storeId: row.store_id ? String(row.store_id) : null,
    stockLocationId: row.stock_location_id ? String(row.stock_location_id) : null,
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function expiry(): Date {
  const seconds = Math.max(60, Number(process.env.PAYMENT_QR_EXPIRY_SECONDS || "900"));
  return new Date(Date.now() + seconds * 1000);
}

function referenceCode(intentId: string): string {
  return `PI${intentId.replace(/[^a-zA-Z0-9]/g, "").slice(-10).toUpperCase()}`;
}

async function releaseScanGoPaymentIntentClaim(client: PoolClient, intentId: string, orderInput: unknown): Promise<void> {
  const cartId = typeof (orderInput as SaleInput | undefined)?.scanGoCartId === "string"
    ? String((orderInput as SaleInput).scanGoCartId)
    : "";
  if (!cartId) return;
  await client.query(`
    UPDATE app.scan_go_carts
    SET metadata = COALESCE(metadata, '{}'::jsonb) - 'paymentIntentId' - 'paymentIntentClaimedAt',
        updated_at = now()
    WHERE id = $1
      AND status <> 'redeemed'
      AND metadata->>'paymentIntentId' = $2
  `, [cartId, intentId]);
}

export async function createPaymentIntent(headers: HeadersLike, body: CreatePaymentIntentInput, actor: OperatorContext, scope: { merchantId: string; storeId: string; stockLocationId: string }) {
  const provider = body.provider || "mock";
  requireFeature(providerFeature(provider));
  requireProviderGloballyEnabled(provider);
  if (!scope || !scope.stockLocationId) {
    throw new PlatformError("scope_required", "createPaymentIntent requires OperatingScope with stockLocationId", 409);
  }
  const merchantId = scope.merchantId;
  const storeId = scope.storeId;
  const stockLocationId = scope.stockLocationId;
  const organizationId = actor.organizationId || "org_default";
  const requestKey = headerValue(headers, "idempotency-key");
  const recoverableKey = requestKey.startsWith(PAYMENT_INTENT_CREATION_KEY_NAMESPACE_V1);
  if (recoverableKey && !requestKey.startsWith(paymentIntentCreationKeyPrefixV1(actor.operatorId, storeId))) {
    throw new PlatformError("forbidden", "Creation key does not belong to this operator and store", 403);
  }
  const requestHash = recoverableKey ? createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex") : "";
  return withTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId, storeId });
    if (recoverableKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${merchantId}\u001f${PI_OPS.createPaymentIntent}\u001f${requestKey}`]);
      const previous = await queryOne<{ request_hash: string }>(client, `SELECT metadata->'creationReceipt'->>'requestHash' AS request_hash
        FROM app.payment_intents WHERE merchant_id=$1 AND store_id=$2 AND created_by=$3 AND metadata->'creationReceipt'->>'requestKey'=$4`,
        [merchantId, storeId, actor.operatorId, requestKey]);
      if (previous) {
        if (previous.request_hash !== requestHash) throw new PlatformError("idempotency_conflict", "Same key, different request body", 409);
        const retained = await queryOne(client, `SELECT 1 AS retained FROM app.idempotency_records
          WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3 AND expires_at>now()`, [merchantId, PI_OPS.createPaymentIntent, requestKey]);
        if (!retained) throw new PlatformError("payment_intent_creation_already_recorded", "Creation was already recorded; recover the existing intent", 409);
      }
    }
    await requireScopedProviderEnabled(client, provider, { merchantId, storeId });
    return withScopedIdempotency(client, headers, body, scope.merchantId, PI_OPS.createPaymentIntent, async () => {
    const rawOrderInput: SaleInput = {
      ...(body.order || { items: [], amountReceived: 0 }),
      paymentMethod: paymentMethodForProvider(provider),
      amountReceived: 0,
    };
    const shiftMetadata = await resolveShiftAttributionForSale(client, rawOrderInput, { scopeKind: "operating", ...scope });
    Object.assign(rawOrderInput, shiftMetadata);
    const intentId = id("pi");
    const orderInput = await preparePaymentIntentSaleInputForClient(client, rawOrderInput, { merchantId, storeId, paymentIntentId: intentId });
    const quote = await quoteSaleForClient(client, orderInput, stockLocationId, merchantId, storeId);
    const financial = paymentFeeFinancialSnapshotV1(quote.totals);
    const ref = referenceCode(intentId);
    const expiresAt = expiry();
    const artifacts = await createProviderIntent({
      provider,
      intentId,
      referenceCode: ref,
      amount: quote.totals.total,
      currencyCode: "vnd",
      expiresAt,
      description: `SNUS order ${ref}`,
      organizationId,
      merchantId,
      storeId,
    });
    const providerConfigId = typeof artifacts.metadata.providerConfigId === "string"
      ? artifacts.metadata.providerConfigId
      : null;
    const result = await client.query(`
      INSERT INTO app.payment_intents (
        id, provider, status, amount, currency_code, order_input, provider_reference,
        reference_code, payment_url, qr_payload, expires_at, metadata, created_by,
        merchant_id, store_id, stock_location_id, business_purpose, provider_config_purpose, provider_config_id
      )
      VALUES ($1, $2, 'pending', $3, 'vnd', $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14,
        'retail_order', 'merchant_retail', $15)
      RETURNING *
    `, [
      intentId,
      provider,
      quote.totals.total,
      JSON.stringify(orderInput),
      artifacts.providerReference,
      ref,
      artifacts.paymentUrl,
      artifacts.qrPayload,
      expiresAt,
      JSON.stringify({
        quote: { totals: quote.totals, items: quote.items },
        ...(recoverableKey ? { creationReceipt: { schemaVersion: 1, requestKey, requestHash } } : {}),
        provider: artifacts.metadata,
        provenance: {
          organizationId,
          merchantId,
          storeId,
          stockLocationId,
          ...shiftMetadata,
          providerConfigPurpose: "merchant_retail",
          createdFrom: "pos_checkout",
        },
      }),
      actor.operatorId,
      merchantId,
      storeId,
      stockLocationId,
      providerConfigId,
    ]);
    return { data: { ...rowToPaymentIntent(result.rows[0]), ...(financial ? { financial } : {}) } };
    });
  });
}

function creationRecoveryInput(headers: HeadersLike, body: unknown, actor: OperatorContext, storeId: string) {
  const input = PaymentIntentCreationReceiptInputV1Schema.safeParse(body);
  if (!input.success) throw new PlatformError("validation_error", "A request hash is required for creation receipt recovery", 400);
  const key = headerValue(headers, "idempotency-key");
  if (!key) throw new PlatformError("idempotency_key_required", "The original Idempotency-Key is required", 400);
  if (key.startsWith(PAYMENT_INTENT_CREATION_KEY_NAMESPACE_V1) && !key.startsWith(paymentIntentCreationKeyPrefixV1(actor.operatorId, storeId))) {
    throw new PlatformError("forbidden", "Creation key does not belong to this operator and store", 403);
  }
  return { key, requestHash: input.data.requestHash };
}

async function creationReceiptForClient(client: PoolClient, input: { key: string; requestHash: string }, actor: OperatorContext,
  scope: { merchantId: string; storeId: string }) {
  const envelope = { schemaVersion: 1 as const, contractVersion: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1, requestHash: input.requestHash };
  const receipt = await queryOne<{ request_hash: string; response: { data?: { id?: unknown }; operatorId?: unknown; merchantId?: unknown; storeId?: unknown } }>(client,
    `SELECT request_hash,response FROM app.idempotency_records WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3`,
    [scope.merchantId, PI_OPS.createPaymentIntent, input.key]);
  if (receipt && receipt.request_hash !== input.requestHash) throw new PlatformError("idempotency_conflict", "Same key, different request hash", 409);
  if (receipt && isClosedIdempotencyReceiptV1(receipt.response)) {
    if (receipt.response.operatorId !== actor.operatorId || receipt.response.storeId !== scope.storeId || receipt.response.merchantId !== scope.merchantId) {
      throw new PlatformError("forbidden", "Closed request belongs to another operator and store", 403);
    }
    return PaymentIntentCreationReceiptV1Schema.parse({ ...envelope, data: { status: "closed" } });
  }
  let intent: Record<string, unknown> | null;
  if (receipt) {
    const intentId = receipt.response?.data?.id;
    if (typeof intentId !== "string" || !intentId) throw new PlatformError("financial_invariant_error", "Stored creation receipt is invalid", 409);
    intent = await queryOne<Record<string, unknown>>(client,
      "SELECT * FROM app.payment_intents WHERE id=$1 AND merchant_id=$2 AND store_id=$3 AND created_by=$4",
      [intentId, scope.merchantId, scope.storeId, actor.operatorId]);
    if (!intent) throw new PlatformError("forbidden", "Creation receipt does not belong to this operator and store", 403);
  } else {
    const rows = await client.query<Record<string, unknown>>(`SELECT * FROM app.payment_intents WHERE merchant_id=$1 AND store_id=$2 AND created_by=$3
      AND metadata->'creationReceipt'->>'requestKey'=$4`, [scope.merchantId, scope.storeId, actor.operatorId, input.key]);
    if (rows.rowCount === 0) return PaymentIntentCreationReceiptV1Schema.parse({ ...envelope, data: { status: "unresolved" } });
    if (rows.rowCount !== 1) throw new PlatformError("financial_invariant_error", "Creation key has ambiguous persisted intent evidence", 409);
    intent = rows.rows[0]!;
    const marker = (intent.metadata as { creationReceipt?: { requestHash?: unknown } } | null)?.creationReceipt;
    if (marker?.requestHash !== input.requestHash) throw new PlatformError("idempotency_conflict", "Same key, different request hash", 409);
  }
  return PaymentIntentCreationReceiptV1Schema.parse({ ...envelope,
    data: { status: "resolved", intent: paymentIntentFinancialViewV1(rowToPaymentIntent(intent)) } });
}

/** A missing receipt is unresolved, never permission to replace a possibly accepted request. */
export async function recoverPaymentIntentCreationReceiptV1(headers: HeadersLike, body: unknown, actor: OperatorContext,
  scope: { merchantId: string; storeId: string }) {
  const input = creationRecoveryInput(headers, body, actor, scope.storeId);
  await requireScopedActorPermission(actor, permissions.paymentIntentRead,
    { scopeType: "store", merchantId: scope.merchantId, storeId: scope.storeId });
  return withConnectedClient(async client => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try { return await creationReceiptForClient(client, input, actor, scope); }
    finally { await client.query("ROLLBACK"); }
  });
}

/** Serialize with creation before recording a permanent, metadata-only refusal for this key. */
export async function closePaymentIntentCreationReceiptV1(headers: HeadersLike, body: unknown, actor: OperatorContext,
  scope: { merchantId: string; storeId: string }) {
  const input = creationRecoveryInput(headers, body, actor, scope.storeId);
  const target = { scopeType: "store" as const, merchantId: scope.merchantId, storeId: scope.storeId };
  await requireScopedActorPermission(actor, permissions.paymentIntentRead, target);
  await requireScopedActorPermission(actor, permissions.paymentIntentCreate, target);
  return withConnectedTransaction(async client => {
    await lockActiveBusinessScopeForClient(client, target);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${scope.merchantId}\u001f${PI_OPS.createPaymentIntent}\u001f${input.key}`]);
    const existing = await creationReceiptForClient(client, input, actor, scope);
    if (existing.data.status !== "unresolved") return existing;
    const ownerPrefix = paymentIntentCreationKeyPrefixV1(actor.operatorId, scope.storeId);
    if (!input.key.startsWith(ownerPrefix) || input.key.length === ownerPrefix.length) {
      throw new PlatformError("validation_error", "Only an owned versioned creation key can be closed without execution", 400);
    }
    await client.query(`INSERT INTO app.idempotency_records(tenant_id,operation,idempotency_key,request_hash,response,expires_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'infinity'::timestamptz)`, [scope.merchantId, PI_OPS.createPaymentIntent, input.key, input.requestHash,
      JSON.stringify({ schemaVersion: 1, idempotencyOutcome: CLOSED_IDEMPOTENCY_OUTCOME_V1,
        operatorId: actor.operatorId, merchantId: scope.merchantId, storeId: scope.storeId })]);
    return PaymentIntentCreationReceiptV1Schema.parse({ schemaVersion: 1, contractVersion: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
      requestHash: input.requestHash, data: { status: "closed" } });
  });
}

export async function getPaymentIntent(intentId: string, scope: PaymentIntentReadScope = {}, financialContract: PaymentFeeHttpContractV1 = "legacy") {
  return withTransaction(async (client) => {
    const { clause, values } = paymentIntentScopeClause(scope, 2);
    const row = await queryOne<Record<string, unknown>>(client, `
      SELECT * FROM app.payment_intents
      WHERE id = $1${clause}
      FOR UPDATE
    `, [intentId, ...values]);
    if (!row) throw new PlatformError("resource_not_found", "Payment intent not found", 404);
    if (financialContract === "legacy") assertLegacyPaymentIntentFinancialReadV1(rowToPaymentIntent(row));
    return { data: rowToPaymentIntent(await expirePendingIntentIfNeeded(client, row)) };
  });
}

export async function listPaymentIntents(input: ListPaymentIntentsInput = {}, financialContract: PaymentFeeHttpContractV1 = "legacy") {
  const limit = Math.min(100, Math.max(1, Number(input.limit || 25)));
  const offset = Math.max(0, Number(input.offset || 0));
  const status = input.status && input.status !== "all" ? input.status : null;
  const provider = input.provider && input.provider !== "all" ? input.provider : null;
  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await expirePendingIntentsForList(client, input);
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (status) { values.push(status); conditions.push(`status = $${values.length}`); }
    if (provider) { values.push(provider); conditions.push(`provider = $${values.length}`); }
    if (input.merchantId) { values.push(input.merchantId); conditions.push(`merchant_id = $${values.length}`); }
    if (input.storeId) { values.push(input.storeId); conditions.push(`store_id = $${values.length}`); }
    if (input.storeIds?.length) { values.push(input.storeIds); conditions.push(`store_id = ANY($${values.length}::text[])`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await client.query(`
      SELECT *
      FROM app.payment_intents
      ${where}
      ORDER BY
        CASE status
          WHEN 'manual_review' THEN 0
          WHEN 'paid' THEN 1
          WHEN 'pending' THEN 2
          ELSE 3
        END,
        updated_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `, [...values, limit, offset]);
    // Reject nonzero or unknown fee claims across the whole cohort, including off-page rows.
    const count = await client.query(`
      SELECT count(*)::int AS count,
        count(*) FILTER (WHERE (
          order_input ?| ARRAY['paymentFeeType','paymentFeeValue']
          OR frozen.totals ?| ARRAY['paymentFeeType','paymentFeeValue','paymentFeeMinor','paymentFeeVatMinor']
          OR frozen.totals->>'commercialAdjustmentVersion' NOT IN ('1')
          OR frozen.totals->>'commercialCalculationVersion' NOT IN ('1')
        ) AND (
          frozen.totals->'paymentFeeMinor' IS DISTINCT FROM '0'::jsonb
          OR frozen.totals->'paymentFeeVatMinor' IS DISTINCT FROM '0'::jsonb
          OR frozen.totals->>'commercialAdjustmentVersion' IS DISTINCT FROM '2'
          OR frozen.totals->>'commercialCalculationVersion' IS DISTINCT FROM '2'
          OR frozen.totals->'paymentFeeType' IS DISTINCT FROM order_input->'paymentFeeType'
          OR frozen.totals->'paymentFeeValue' IS DISTINCT FROM order_input->'paymentFeeValue'
          OR frozen.totals->'paymentFeeBasisMinor' IS DISTINCT FROM frozen.totals->'merchandisePayable'
          OR frozen.totals->'total' IS DISTINCT FROM to_jsonb(amount)
          OR CASE
            WHEN frozen.totals->>'paymentFeeType' = 'amount' THEN frozen.totals->'paymentFeeValue' IS DISTINCT FROM '0'::jsonb
            WHEN frozen.totals->>'paymentFeeType' = 'percent'
              AND jsonb_typeof(frozen.totals->'paymentFeeValue') = 'number'
              AND jsonb_typeof(frozen.totals->'paymentFeeBasisMinor') = 'number'
            THEN NOT ((frozen.totals->>'paymentFeeValue')::numeric BETWEEN 0 AND 100
              AND round((frozen.totals->>'paymentFeeValue')::numeric, 2) = (frozen.totals->>'paymentFeeValue')::numeric
              AND (frozen.totals->>'paymentFeeBasisMinor')::numeric BETWEEN 0 AND 9007199254740991
              AND trunc((frozen.totals->>'paymentFeeBasisMinor')::numeric) = (frozen.totals->>'paymentFeeBasisMinor')::numeric
              AND round((frozen.totals->>'paymentFeeValue')::numeric * (frozen.totals->>'paymentFeeBasisMinor')::numeric / 100) = 0)
            ELSE true
          END
        ))::int AS incompatible_fee_count
      FROM app.payment_intents
      CROSS JOIN LATERAL (SELECT metadata #> '{quote,totals}' AS totals) frozen
      ${where}
    `, values);
    if (financialContract === "legacy" && Number(count.rows[0]?.incompatible_fee_count || 0) > 0) {
      throw new PlatformError("unsupported_contract", "A compatible order financial contract is required for payment fees", 409);
    }
    if (financialContract === "legacy") rows.rows.map(rowToPaymentIntent).forEach(assertLegacyPaymentIntentFinancialReadV1);
    return {
      data: rows.rows.map(rowToPaymentIntent),
      count: Number(count.rows[0]?.count || 0),
      limit,
      offset,
    };
  });
}

async function lockActivePaymentIntentCommandScope(client: PoolClient, intentId: string, scope: PaymentIntentReadScope) {
  const { clause, values } = paymentIntentScopeClause(scope, 2);
  const intent = await queryOne<{ merchant_id: string; store_id: string; order_input: SaleInput }>(client,
    `SELECT merchant_id,store_id,order_input FROM app.payment_intents WHERE id=$1${clause}`, [intentId, ...values]);
  if (!intent) throw new PlatformError("resource_not_found", "Payment intent not found", 404);
  await lockTelegramSalesDraftConfirmationForClient(client, intent.order_input);
  await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId: intent.merchant_id, storeId: intent.store_id });
}

export async function cancelPaymentIntent(headers: HeadersLike, intentId: string, actor: OperatorContext, scope: PaymentIntentReadScope = {}, financialContract: PaymentFeeHttpContractV1 = "legacy") {
  const tenantId = scope.merchantId;
  if (!tenantId) {
    throw new PlatformError("scope_required", "cancelPaymentIntent requires tenantId for scoped idempotency", 409);
  }
  return withTransaction(async (client) => {
    await lockActivePaymentIntentCommandScope(client, intentId, scope);
    const result = await withScopedIdempotency(client, headers, { intentId }, tenantId, PI_OPS.cancelPaymentIntent, async () => {
    const { clause, values } = paymentIntentScopeClause(scope, 3);
    if (financialContract === "legacy") {
      const beforeScope = paymentIntentScopeClause(scope, 2);
      const before = await queryOne<Record<string, unknown>>(client, `SELECT * FROM app.payment_intents WHERE id=$1${beforeScope.clause} FOR UPDATE`,
        [intentId, ...beforeScope.values]);
      if (before) assertLegacyPaymentIntentFinancialReadV1(rowToPaymentIntent(before));
    }
    const row = await queryOne<Record<string, unknown>>(client, `
      UPDATE app.payment_intents
      SET status = 'cancelled', updated_at = now(), metadata = metadata || jsonb_build_object('cancelledBy', $2::text)
      WHERE id = $1 AND status = 'pending'${clause}
      RETURNING *
    `, [intentId, actor.operatorId, ...values]);
    if (!row) throw new PlatformError("invalid_payment_intent_state", "Only pending payment intents can be cancelled", 409);
    await releaseScanGoPaymentIntentClaim(client, intentId, row.order_input);
    return { data: rowToPaymentIntent(row) };
    });
    if (financialContract === "legacy") assertLegacyPaymentIntentFinancialReadV1(result.response.data);
    return result;
  });
}

export async function settleMockPaymentIntent(headers: HeadersLike, intentId: string, actor: OperatorContext, scope: PaymentIntentReadScope = {}, financialContract: PaymentFeeHttpContractV1 = "legacy") {
  if (process.env.NODE_ENV === "production") {
    throw new PlatformError("provider_disabled", "Local mock settlement is disabled in production", 403);
  }
  const tenantId = scope.merchantId;
  if (!tenantId) {
    throw new PlatformError("scope_required", "settleMockPaymentIntent requires tenantId for scoped idempotency", 409);
  }
  return withTransaction(async (client) => {
    await lockActivePaymentIntentCommandScope(client, intentId, scope);
    const result = await withScopedIdempotency(client, headers, { intentId }, tenantId, PI_OPS.settleMockPaymentIntent, async () => {
    const { clause, values } = paymentIntentScopeClause(scope, 2);
    const intent = await queryOne<Record<string, unknown>>(client, `
      SELECT * FROM app.payment_intents
      WHERE id = $1${clause}
    `, [intentId, ...values]);
    if (!intent) throw new PlatformError("resource_not_found", "Payment intent not found", 404);
    if (financialContract === "legacy") assertLegacyPaymentIntentFinancialReadV1(rowToPaymentIntent(intent));
    const provider = intent.provider as PaymentIntentProvider;
    const availability = getPaymentProviderAvailability();
    const providerAvailability = provider === "sepay_va" ? availability.sepay_va : provider === "nowpayments" ? availability.nowpayments : null;
    if (providerAvailability?.mode === "live") {
      throw new PlatformError("provider_disabled", "Local mock settlement is disabled for live providers", 403, { provider });
    }
    const eventId = `mock:${intentId}:settled`;
    return resolveProviderPaymentEventInTransaction(client, {
      provider,
      providerEventId: eventId,
      eventType: "mock.settled",
      amount: Number(intent.amount),
      currencyCode: String(intent.currency_code),
      referenceCode: String(intent.reference_code),
      payload: { settledBy: actor.operatorId, local: true },
    });
    });
    if (financialContract === "legacy") assertLegacyPaymentIntentFinancialReadV1(result.response.data);
    return result;
  });
}

export async function handleProviderPaymentEvent(input: ProviderPaymentEventInput) {
  return withTransaction((client) => resolveProviderPaymentEventInTransaction(client, input));
}

async function resolveProviderPaymentEventInTransaction(client: PoolClient, input: ProviderPaymentEventInput) {
  const ref = input.referenceCode || referenceFromContent(input.content || "");
  const candidate = ref ? await queryOne<{ id: string; order_input: SaleInput }>(client,
    "SELECT id,order_input FROM app.payment_intents WHERE provider=$1 AND reference_code=$2", [input.provider, ref]) : null;
  if (candidate) {
    // Portal checkout holds this advisory lock while another connection creates the order.
    await lockTelegramSalesDraftConfirmationForClient(client, candidate.order_input);
    await lockProviderIntentScopeForClient(client, candidate.id);
  }
  const intent = ref ? await queryOne<Record<string, unknown>>(client, `
    SELECT * FROM app.payment_intents
    WHERE provider = $1 AND reference_code = $2
    FOR UPDATE
  `, [input.provider, ref]) : null;

  if (!intent) {
    const event = await claimProviderEvent(client, input, null, null);
    const incomingFingerprint = providerIdentityFingerprint(input);
    const reason = providerPaymentEventIdentityConflictV1(input, event.payload)
      ? "conflicting_provider_event"
      : "payment_intent_not_found";
    await updateProviderEvent(client, input, {
      status: "manual_review",
      error: reason,
      evidenceFingerprint: incomingFingerprint,
    });
    return providerEventManualReviewResponse(input, reason, ref);
  }

  const intentId = String(intent.id);
  const intentProvenance = {
    merchantId: intent.merchant_id ? String(intent.merchant_id) : null,
    storeId: intent.store_id ? String(intent.store_id) : null,
  };
  const providerEvent = await claimProviderEvent(client, input, intentId, intentProvenance);
  if (providerEvent.payment_intent_id && String(providerEvent.payment_intent_id) !== intentId) {
    return markConflictingProviderEvent(client, input, intentId, "provider_event_intent_conflict");
  }
  // A SePay transaction id represents one immutable bank transaction. A
  // NOWPayments payment id is intentionally reused across waiting -> finished
  // lifecycle callbacks, so its mutable inbox row cannot use this exact-
  // payload replay check before terminal evidence is snapshotted.
  if (
    input.provider === "sepay_va"
    && providerPaymentEventIdentityConflictV1(input, providerEvent.payload)
  ) {
    return markConflictingProviderEvent(client, input, intentId, "conflicting_provider_event");
  }

  const isLocalMockSettlement = input.eventType === "mock.settled" && input.payload?.local === true;
  const isLocalProviderSimulation = isLocalMockSettlement
    || (process.env.NODE_ENV === "test" && input.verification?.mode === "test");
  const incomingTerminal = input.provider === "nowpayments"
    && !isLocalMockSettlement
    && input.verification?.terminal === true;
  if (String(providerEvent.status) === "matched") {
    if (!incomingTerminal) return matchedProviderEventResponse(client, intentId, providerEvent);
    const evidenceResult = buildCryptoReceiptEvidence(intent, input);
    if ("reason" in evidenceResult) {
      return markConflictingProviderEvent(client, input, intentId, "conflicting_provider_event");
    }
    const incomingFingerprint = cryptoEvidenceFingerprint(evidenceResult.evidence);
    if (providerEvent.evidence_fingerprint && String(providerEvent.evidence_fingerprint) !== incomingFingerprint) {
      return markConflictingProviderEvent(client, input, intentId, "conflicting_provider_event");
    }
    return matchedProviderEventResponse(client, intentId, providerEvent);
  }
  if (String(providerEvent.status) === "manual_review") {
    return getPaymentIntentInTransaction(client, intentId);
  }

  // ── SePay: require incoming transfer direction. ───────────────────────────
  // Outgoing and unknown-direction events must never mark an intent paid.
  if (input.provider === "sepay_va" && !isLocalMockSettlement && input.direction !== "in") {
    return moveIntentAndEventToManualReview(client, input, intentId, "wrong_transfer_direction");
  }

  // ── NOWPayments: require a terminal success status. ───────────────────────
  // Non-terminal events (waiting, confirming, partially_paid, etc.) are
  // persisted but must never create an order or mark the intent paid.
  if (input.provider === "nowpayments" && !isLocalMockSettlement) {
    const verification = input.verification || {};
    const terminal = verification.terminal === true;
    const assetRejected = verification.assetRejected === true;
    if (assetRejected) {
      const reason = String(verification.reason || "unsupported_asset_network");
      return moveIntentAndEventToManualReview(client, input, intentId, reason);
    }
    if (!terminal) {
      await updateProviderEvent(client, input, { status: "received", error: null });
      return providerEventManualReviewResponse(input, "non_terminal_payment_status", ref);
    }
  }

  const expectedAmount = Number(intent.amount);
  const expectedProvider = expectedProviderPayment(intent);
  const rawReceivedAmount = input.provider === "nowpayments"
    ? String(input.grossQuantity || input.amount || "")
    : String(input.amount || 0);
  const receivedCurrency = String(input.currencyCode || intent.currency_code || "vnd").toLowerCase();
  if (expectedProvider.currencyCode && receivedCurrency !== expectedProvider.currencyCode) {
    return moveIntentAndEventToManualReview(client, input, intentId, "currency_mismatch");
  }
  if (!amountsEqual(rawReceivedAmount, expectedProvider.amount, expectedProvider.currencyCode || String(intent.currency_code || "vnd"))) {
    return moveIntentAndEventToManualReview(client, input, intentId, "amount_mismatch");
  }
  if (new Date(String(intent.expires_at)).getTime() < Date.now()) {
    return moveIntentAndEventToManualReview(client, input, intentId, "payment_intent_expired");
  }
  if (intent.completed_order_id) {
    return { data: rowToPaymentIntent(intent) };
  }

  const cryptoEvidenceResult = input.provider === "nowpayments" && !isLocalMockSettlement
    ? buildCryptoReceiptEvidence(intent, input)
    : null;
  if (cryptoEvidenceResult && "reason" in cryptoEvidenceResult) {
    return moveIntentAndEventToManualReview(client, input, intentId, cryptoEvidenceResult.reason);
  }

  // Persist the exact terminal callback before the order writer reads and
  // locks provider evidence. This is essential for providers that reuse one
  // event identity across waiting -> finished transitions.
  await updateProviderEvent(client, input, {
    status: "received",
    error: null,
    evidenceFingerprint: providerIdentityFingerprint(input),
  });

  const paid = await queryOne<Record<string, unknown>>(client, `
    UPDATE app.payment_intents
    SET status = 'paid', paid_at = now(), updated_at = now()
    WHERE id = $1 AND status = 'pending'
    RETURNING *
  `, [intentId]);
  if (!paid) {
    return moveIntentAndEventToManualReview(client, input, intentId, "invalid_payment_intent_state");
  }

  const actor = await actorForPaymentIntent(client, paid);
  // The settlement must use the stock location captured at intent creation,
  // never the current actor headers or a LIMIT 1 inventory_level pick. The
  // intent row carries stock_location_id which was frozen at createPaymentIntent.
  const capturedStockLocationId = paid.stock_location_id
    ? String(paid.stock_location_id)
    : (intent.stock_location_id ? String(intent.stock_location_id) : null);
  if (!capturedStockLocationId) {
    return moveIntentAndEventToManualReview(client, input, intentId, "missing_captured_stock_location");
  }
  try {
    await assertTelegramSalesDraftCanSettlePaymentIntent(client, paid.order_input as SaleInput, intentProvenance);
  } catch (error) {
    if (error instanceof PlatformError && ["invalid_draft_status", "resource_not_found", "scope_required"].includes(error.code)) {
      return moveIntentAndEventToManualReview(client, input, intentId, "telegram_sales_draft_unavailable");
    }
    throw error;
  }
  let orderResult: Awaited<ReturnType<typeof createProviderPaidOrderForClient>>;
  await client.query("SAVEPOINT provider_order_creation");
  try {
    orderResult = await createProviderPaidOrderForClient(client, paid.order_input as SaleInput, actor, {
      paymentIntentId: intentId,
      paymentProvider: input.provider,
      providerEventId: input.providerEventId,
      providerReference: paid.provider_reference,
      referenceCode: paid.reference_code,
      amountReceived: expectedAmount,
      providerPaidAmount: Number(rawReceivedAmount),
      providerPaidCurrency: receivedCurrency,
      providerTransactionId: input.providerTransactionId,
      providerTransactionHash: input.providerTransactionHash,
      providerNetwork: input.providerNetwork,
      providerPayCurrency: input.providerPayCurrency,
      providerFeeAmount: input.providerFeeAmount,
      providerFeeCurrency: input.providerFeeCurrency,
      merchantId: intentProvenance.merchantId,
      storeId: intentProvenance.storeId,
      providerConfigPurpose: "merchant_retail",
      providerConfigId: paid.provider_config_id || null,
      localMockSettlement: isLocalProviderSimulation,
    }, { stockLocationId: capturedStockLocationId,
      commercialContext: frozenPaymentFeeQuoteContext(objectValue(paid.metadata), paid.order_input as SaleInput) });
    await client.query("RELEASE SAVEPOINT provider_order_creation");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT provider_order_creation");
    await client.query("RELEASE SAVEPOINT provider_order_creation");
    if (error instanceof PlatformError && ["payment_intent_quote_invalid", "variant_price_unavailable", "cart_quote_changed"].includes(error.code)) {
      return moveIntentAndEventToManualReview(client,input,intentId,"payment_intent_quote_invalid");
    }
    if (error instanceof PlatformError && error.code === "payment_intent_lifecycle_invalid") {
      return moveIntentAndEventToManualReview(client, input, intentId, "payment_intent_lifecycle_invalid");
    }
    if (isStockConflictAfterPayment(error)) {
      return moveIntentAndEventToManualReview(client, input, intentId, "stock_unavailable_after_payment");
    }
    if (error instanceof PlatformError && ["scan_go_cart_unavailable", "scan_go_cart_not_redeemed"].includes(error.code)) {
      return moveIntentAndEventToManualReview(client, input, intentId, "scan_go_cart_unavailable");
    }
    throw error;
  }
  const orderId = String((orderResult.data as Record<string, unknown>).id || (orderResult.data as Record<string, unknown>).orderId || "");
  await convertTelegramSalesDraftForPaidOrder(
    client,
    paid.order_input as SaleInput,
    orderResult.data as Record<string, unknown>,
    actor,
    intentProvenance,
  );
  await client.query(`
    UPDATE public."order"
    SET merchant_id = $2,
        store_id = $3,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'paymentIntentId', $1::text,
          'providerEventId', $4::text,
          'merchantId', $2::text,
          'storeId', $3::text
        )
    WHERE id = $5
  `, [intentId, intentProvenance.merchantId, intentProvenance.storeId, input.providerEventId, orderId]);
  const paymentEntry = await queryOne<{ id: string }>(client, `
    SELECT id::text
    FROM app.payment_entries
    WHERE order_id = $1 AND direction = 'charge'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE
  `, [orderId]);
  if (!paymentEntry) throw new PlatformError("internal_error", "Provider-paid order is missing its payment entry", 500);

  const cryptoReceiptEvidence = cryptoEvidenceResult && "evidence" in cryptoEvidenceResult
    ? cryptoEvidenceResult.evidence
    : null;
  await client.query(`
    UPDATE app.payment_entries
    SET merchant_id = $2,
        store_id = $3,
        payment_intent_id = $1,
        provider_event_id = $4,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'merchantId', $2::text,
          'storeId', $3::text,
          'paymentIntentId', $1::text,
          'providerEventId', $4::text,
          'cryptoReceiptEvidenceId', $5::text
        )
    WHERE id = $6::uuid
  `, [
    intentId,
    intentProvenance.merchantId,
    intentProvenance.storeId,
    input.providerEventId,
    cryptoReceiptEvidence?.evidenceId || null,
    paymentEntry.id,
  ]);
  await updateProviderEvent(client, input, {
    status: "matched",
    error: null,
    paymentEntryId: paymentEntry.id,
    orderId,
    evidenceFingerprint: cryptoReceiptEvidence ? cryptoEvidenceFingerprint(cryptoReceiptEvidence) : providerIdentityFingerprint(input),
    cryptoReceiptEvidence,
  });
  const completed = await queryOne<Record<string, unknown>>(client, `
    UPDATE app.payment_intents
    SET status = 'completed',
        completed_order_id = $2,
        metadata = metadata || jsonb_build_object(
          'providerEventId', $3::text,
          'paymentEntryId', $4::text,
          'cryptoReceiptEvidence', $5::jsonb
        ),
        updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [intentId, orderId, input.providerEventId, paymentEntry.id, JSON.stringify(cryptoReceiptEvidence)]);
  return {
    data: rowToPaymentIntent(completed || paid),
    order: orderResult.data,
    cryptoReceiptEvidence: cryptoReceiptEvidence || undefined,
  };
}

async function matchedProviderEventResponse(
  client: PoolClient,
  intentId: string,
  providerEvent: Record<string, unknown>,
) {
  const result = await getPaymentIntentInTransaction(client, intentId);
  const evidence = providerEvent.crypto_receipt_evidence;
  return evidence ? { ...result, cryptoReceiptEvidence: evidence as CryptoReceiptEvidence } : result;
}

async function getPaymentIntentInTransaction(client: PoolClient, intentId: string) {
  const row = await queryOne<Record<string, unknown>>(client, "SELECT * FROM app.payment_intents WHERE id = $1 FOR UPDATE", [intentId]);
  if (!row) throw new PlatformError("resource_not_found", "Payment intent not found", 404);
  return { data: rowToPaymentIntent(await expirePendingIntentIfNeeded(client, row)) };
}

async function expirePendingIntentIfNeeded(client: PoolClient, row: Record<string, unknown>) {
  if (String(row.status) !== "pending") return row;
  if (new Date(String(row.expires_at)).getTime() >= Date.now()) return row;
  const expired = await queryOne<Record<string, unknown>>(client, `
    UPDATE app.payment_intents
    SET status = 'expired',
        manual_review_reason = COALESCE(manual_review_reason, 'payment_intent_expired'),
        updated_at = now()
    WHERE id = $1 AND status = 'pending'
    RETURNING *
  `, [String(row.id)]) || row;
  await releaseScanGoPaymentIntentClaim(client, String(expired.id), expired.order_input);
  return expired;
}

async function expirePendingIntentsForList(client: PoolClient, scope: PaymentIntentReadScope) {
  const { clause, values } = paymentIntentScopeClause(scope, 1);
  const expired = await client.query<Record<string, unknown>>(`
    UPDATE app.payment_intents
    SET status = 'expired',
        manual_review_reason = COALESCE(manual_review_reason, 'payment_intent_expired'),
        updated_at = now()
    WHERE status = 'pending' AND expires_at < now()${clause}
    RETURNING id, order_input
  `, values);
  for (const row of expired.rows) {
    await releaseScanGoPaymentIntentClaim(client, String(row.id), row.order_input);
  }
}

function providerEventManualReviewResponse(
  input: ProviderPaymentEventInput,
  reason: string,
  referenceCode: string | null = input.referenceCode || null,
) {
  return {
    data: {
      provider: input.provider,
      providerEventId: input.providerEventId,
      status: "manual_review",
      manualReviewReason: reason,
      referenceCode,
    },
  };
}

async function claimProviderEvent(
  client: PoolClient,
  input: ProviderPaymentEventInput,
  paymentIntentId: string | null,
  provenance?: { merchantId?: string | null; storeId?: string | null } | null,
): Promise<Record<string, unknown>> {
  await client.query(`
    INSERT INTO app.payment_provider_events (
      provider, provider_event_id, payment_intent_id, event_type, amount, currency_code, status, error, payload,
      merchant_id, store_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'received', NULL, $7::jsonb, $8, $9)
    ON CONFLICT (provider, provider_event_id) DO NOTHING
  `, [
    input.provider,
    input.providerEventId,
    paymentIntentId,
    input.eventType,
    Number.isFinite(input.amount) ? input.amount : null,
    input.currencyCode || "vnd",
    JSON.stringify(normalizedProviderPayload(input)),
    provenance?.merchantId || null,
    provenance?.storeId || null,
  ]);
  const event = await queryOne<Record<string, unknown>>(client, `
    SELECT *
    FROM app.payment_provider_events
    WHERE provider = $1 AND provider_event_id = $2
    FOR UPDATE
  `, [input.provider, input.providerEventId]);
  if (!event) throw new PlatformError("internal_error", "Provider event could not be locked", 500);
  return event;
}

async function updateProviderEvent(
  client: PoolClient,
  input: ProviderPaymentEventInput,
  update: {
    status: "matched" | "manual_review" | "failed" | "ignored" | "received";
    error: string | null;
    paymentEntryId?: string;
    orderId?: string;
    evidenceFingerprint?: string;
    cryptoReceiptEvidence?: CryptoReceiptEvidence | null;
  },
) {
  await client.query(`
    UPDATE app.payment_provider_events
    SET status = $3,
        error = $4,
        payload = $5::jsonb,
        payment_entry_id = COALESCE($6::uuid, payment_entry_id),
        order_id = COALESCE($7, order_id),
        evidence_fingerprint = COALESCE($8, evidence_fingerprint),
        crypto_receipt_evidence = COALESCE($9::jsonb, crypto_receipt_evidence),
        event_revision = event_revision + 1,
        updated_at = now()
    WHERE provider = $1 AND provider_event_id = $2
  `, [
    input.provider,
    input.providerEventId,
    update.status,
    update.error,
    JSON.stringify(normalizedProviderPayload(input)),
    update.paymentEntryId || null,
    update.orderId || null,
    update.evidenceFingerprint || null,
    update.cryptoReceiptEvidence ? JSON.stringify(update.cryptoReceiptEvidence) : null,
  ]);
}

async function moveIntentAndEventToManualReview(
  client: PoolClient,
  input: ProviderPaymentEventInput,
  intentId: string,
  reason: string,
) {
  await updateProviderEvent(client, input, {
    status: "manual_review",
    error: reason,
    evidenceFingerprint: providerIdentityFingerprint(input),
  });
  const row = await markManualReview(client, intentId, reason);
  return { data: rowToPaymentIntent(row) };
}

async function markConflictingProviderEvent(
  client: PoolClient,
  input: ProviderPaymentEventInput,
  intentId: string,
  reason: string,
) {
  return moveIntentAndEventToManualReview(client, input, intentId, reason);
}

async function markManualReview(client: PoolClient, intentId: string, reason: string) {
  const row = await queryOne<Record<string, unknown>>(client, `
    UPDATE app.payment_intents
    SET status = 'manual_review', manual_review_reason = $2, updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [intentId, reason]);
  if (!row) throw new PlatformError("resource_not_found", "Payment intent not found", 404);
  return row;
}

function isStockConflictAfterPayment(error: unknown): boolean {
  return error instanceof PlatformError
    && ["insufficient_stock", "stock_shortage_requires_confirmation"].includes(error.code);
}

async function actorForPaymentIntent(client: PoolClient, row: Record<string, unknown>): Promise<OperatorContext> {
  const staff = await queryOne<{ operator_id: string; role: Role; display_name: string; organization_id: string }>(client, `
    SELECT operator_id, role, display_name, organization_id
    FROM medusa.staff_users
    WHERE operator_id = $1 AND is_active = true
    LIMIT 1
  `, [String(row.created_by)]);
  return {
    operatorId: staff?.operator_id || String(row.created_by),
    role: staff?.role || "staff",
    displayName: staff?.display_name || String(row.created_by),
    organizationId: staff?.organization_id || "org_default",
  };
}

function referenceFromContent(content: string): string | null {
  const normalized = content.toUpperCase();
  const match = normalized.match(/\bPI[A-Z0-9]{4,20}\b/);
  return match?.[0] || null;
}

function expectedProviderPayment(row: Record<string, unknown>): { amount: string; currencyCode: string } {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
  const provider = metadata.provider && typeof metadata.provider === "object" ? metadata.provider as Record<string, unknown> : {};
  const expectedAmount = decimalText(provider.expectedProviderAmount);
  const expectedCurrency = typeof provider.expectedProviderCurrency === "string" ? provider.expectedProviderCurrency.toLowerCase() : "";
  if (expectedAmount && decimalGreaterThanZero(expectedAmount) && expectedCurrency) {
    return { amount: expectedAmount, currencyCode: expectedCurrency };
  }
  return { amount: String(row.amount), currencyCode: String(row.currency_code || "vnd").toLowerCase() };
}

function amountsEqual(received: string | number, expected: string | number, currencyCode: string): boolean {
  const receivedText = decimalText(received);
  const expectedText = decimalText(expected);
  if (!receivedText || !expectedText) return false;
  if (currencyCode.toLowerCase() === "vnd") {
    return Math.round(Number(receivedText)) === Math.round(Number(expectedText));
  }
  return canonicalDecimal(receivedText) === canonicalDecimal(expectedText);
}

function normalizedProviderPayload(input: ProviderPaymentEventInput): Record<string, unknown> {
  return {
    ...(input.payload || {}),
    _identityFingerprintVersion: 2,
    _identityFingerprint: providerIdentityFingerprint(input),
    _normalized: {
      providerTransactionId: input.providerTransactionId || null,
      providerTransactionHash: input.providerTransactionHash || null,
      providerNetwork: input.providerNetwork || null,
      providerPayCurrency: input.providerPayCurrency || null,
      providerOccurredAt: input.providerOccurredAt || null,
      providerFeeAmount: input.providerFeeAmount ?? null,
      providerFeeCurrency: input.providerFeeCurrency || null,
      grossQuantity: input.grossQuantity || null,
      providerFeeQuantity: input.providerFeeQuantity ?? null,
      retailCryptoAsset: input.retailCryptoAsset || null,
      direction: input.direction || null,
    },
    _verification: input.verification || {},
  };
}

export function providerPaymentEventIdentityFingerprintV1(
  input: ProviderPaymentEventInput,
  version: 1 | 2 = 2,
): string {
  const legacyIdentity = {
    provider: input.provider,
    providerEventId: input.providerEventId,
    referenceCode: input.referenceCode || null,
    amount: decimalText(input.grossQuantity || input.amount) || null,
    currencyCode: String(input.currencyCode || "").toLowerCase(),
    providerTransactionId: input.providerTransactionId || null,
    providerTransactionHash: input.providerTransactionHash || null,
    providerPayCurrency: input.providerPayCurrency || null,
    providerNetwork: input.providerNetwork || null,
  };
  if (version === 1) return sha256(legacyIdentity);
  const verification = input.verification || {};
  return sha256({
    ...legacyIdentity,
    identityVersion: 2,
    eventType: input.eventType,
    direction: input.direction || null,
    providerOccurredAt: input.providerOccurredAt || null,
    verification: {
      authenticated: verification.authenticated === true,
      signatureAlgorithm: verification.signatureAlgorithm || null,
      signedPayloadSha256:
        verification.signedPayloadSha256 || verification.payloadSha256 || null,
      providerConfigPurpose: verification.providerConfigPurpose || null,
      providerConfigId: verification.providerConfigId || null,
      terminal: verification.terminal === true,
      paymentStatus: verification.paymentStatus || null,
    },
  });
}

function providerIdentityFingerprint(input: ProviderPaymentEventInput): string {
  return providerPaymentEventIdentityFingerprintV1(input, 2);
}

export function providerPaymentEventIdentityConflictV1(
  input: ProviderPaymentEventInput,
  value: unknown,
): boolean {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  const fingerprint = payload._identityFingerprint;
  if (typeof fingerprint !== "string") return false;
  const version = payload._identityFingerprintVersion === 2 ? 2 : 1;
  return fingerprint !== providerPaymentEventIdentityFingerprintV1(input, version);
}

function cryptoEvidenceFingerprint(evidence: CryptoReceiptEvidence): string {
  return sha256(evidence);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortCanonical(value))).digest("hex");
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = sortCanonical((value as Record<string, unknown>)[key]);
    return result;
  }, {});
}

function buildCryptoReceiptEvidence(
  intent: Record<string, unknown>,
  input: ProviderPaymentEventInput,
): { evidence: CryptoReceiptEvidence } | { reason: string } {
  const metadata = objectValue(intent.metadata);
  const provider = objectValue(metadata.provider);
  const quote = objectValue(provider.quote);
  const merchantId = textValue(intent.merchant_id);
  const storeId = textValue(intent.store_id);
  const asset = input.retailCryptoAsset;
  const expectedAsset = normalizeRetailAsset(provider.payCurrency);
  const grossQuantity = decimalText(input.grossQuantity);
  const providerFeeQuantity = decimalText(input.providerFeeQuantity);
  const transactionHash = textValue(input.providerTransactionHash);
  const destinationWalletRef = textValue(provider.destinationWalletRef);
  const valuationRate = decimalText(quote.vndUsdRate);
  const valuationRateSource = textValue(quote.exchangeRateSource);
  const valuationTimestamp = textValue(quote.quotedAt);

  if (!merchantId || !storeId) return { reason: "missing_tenant_provenance" };
  if (!asset || !expectedAsset || asset !== expectedAsset) return { reason: "asset_mismatch" };
  if (!networkMatchesAsset(input.providerNetwork, asset)) return { reason: "unsupported_asset_network" };
  if (!grossQuantity || !decimalGreaterThanZero(grossQuantity)) return { reason: "missing_gross_quantity_evidence" };
  if (input.verification?.providerFeeResolved !== true || providerFeeQuantity === undefined) {
    return { reason: "missing_provider_fee_evidence" };
  }
  if (!transactionHash) return { reason: "missing_transaction_hash_evidence" };
  if (!destinationWalletRef) return { reason: "missing_destination_wallet_provenance" };
  if (!valuationRate || !decimalGreaterThanZero(valuationRate) || !valuationRateSource || !valuationTimestamp) {
    return { reason: "missing_valuation_provenance" };
  }
  const netQuantity = subtractDecimals(grossQuantity, providerFeeQuantity);
  if (!netQuantity) return { reason: "provider_fee_exceeds_gross_quantity" };
  const evidence: CryptoReceiptEvidence = {
    evidenceId: `crypto_${sha256(`nowpayments:${input.providerEventId}`).slice(0, 32)}`,
    businessPurpose: "retail_order",
    merchantId,
    storeId,
    paymentIntentId: String(intent.id),
    providerEventId: input.providerEventId,
    asset,
    transactionHash,
    destinationWalletRef,
    grossQuantity: canonicalDecimal(grossQuantity),
    providerFeeQuantity: canonicalDecimal(providerFeeQuantity),
    netQuantity,
    grossVndValue: Math.round(Number(intent.amount)),
    feeVndValue: multiplyDecimalToInteger(providerFeeQuantity, valuationRate),
    valuationRateSource,
    valuationTimestamp,
  };
  const parsed = CryptoReceiptEvidenceSchema.safeParse(evidence);
  return parsed.success ? { evidence: parsed.data } : { reason: "invalid_crypto_receipt_evidence" };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function normalizeRetailAsset(value: unknown): RetailCryptoAsset | null {
  const currency = textValue(value).toLowerCase();
  if (currency === "usdttrc20") return "USDTTRC20";
  if (currency === "usdcmatic") return "USDCMATIC";
  return null;
}

function networkMatchesAsset(network: unknown, asset: RetailCryptoAsset): boolean {
  const normalized = textValue(network).toLowerCase().replace(/[\s_-]+/g, "");
  return asset === "USDTTRC20"
    ? ["trc20", "tron"].includes(normalized)
    : ["matic", "polygon", "polygonpos"].includes(normalized);
}

function decimalText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return /^(0|[1-9]\d*)(\.\d+)?$/.test(text) ? text : undefined;
}

function canonicalDecimal(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole;
}

function decimalGreaterThanZero(value: string): boolean {
  return BigInt(value.replace(".", "")) > 0n;
}

function decimalParts(value: string): { units: bigint; scale: number } {
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function subtractDecimals(gross: string, fee: string): string | null {
  const left = decimalParts(gross);
  const right = decimalParts(fee);
  const scale = Math.max(left.scale, right.scale);
  const leftUnits = left.units * 10n ** BigInt(scale - left.scale);
  const rightUnits = right.units * 10n ** BigInt(scale - right.scale);
  if (rightUnits > leftUnits) return null;
  const result = leftUnits - rightUnits;
  const digits = result.toString().padStart(scale + 1, "0");
  const formatted = scale === 0
    ? digits
    : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return canonicalDecimal(formatted);
}

function multiplyDecimalToInteger(leftValue: string, rightValue: string): number {
  const left = decimalParts(leftValue);
  const right = decimalParts(rightValue);
  const denominator = 10n ** BigInt(left.scale + right.scale);
  const numerator = left.units * right.units;
  return Number((numerator + denominator / 2n) / denominator);
}
