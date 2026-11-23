import type {
  BillingOrderStatus,
  BillingOrderPurpose,
  PackageKey,
  MoneyVnd,
  PackageCatalogVersionSnapshot,
} from "@medusa-snus/contracts";
import {
  vndPackagePrices,
  subscriptionPolicySnapshot,
  packageCatalogVersion,
} from "@medusa-snus/contracts";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { id } from "../utils/id";
import { getCatalogEntryInMemory } from "./package-catalog-service";

export type BillingOrderRow = {
  [key: string]: unknown;
  id: string;
  merchant_id: string;
  purpose: BillingOrderPurpose;
  current_package_key: PackageKey | null;
  target_package_key: PackageKey;
  catalog_version_id: string;
  policy_version: string;
  period_start: Date | string;
  period_end: Date | string;
  amount_vnd: string;
  provider: string;
  provider_payment_id: string | null;
  provider_quote_json: Record<string, unknown>;
  status: BillingOrderStatus;
  manual_review_reason: string | null;
  requested_by: string | null;
  quote_expires_at: Date | string;
  paid_at: Date | string | null;
  applied_at: Date | string | null;
  idempotency_key: string;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToSnapshot(row: BillingOrderRow): BillingOrderSnapshot {
  return {
    billingOrderId: String(row.id),
    merchantId: String(row.merchant_id),
    purpose: row.purpose as BillingOrderPurpose,
    status: row.status as BillingOrderStatus,
    businessPurpose: "platform_subscription",
    providerConfigPurpose: "platform_billing",
    currentPackageKey: (row.current_package_key as PackageKey | null) ?? null,
    targetPackageKey: row.target_package_key as PackageKey,
    amount: { currencyCode: "vnd", amountVnd: row.amount_vnd },
    periodStart: iso(row.period_start),
    periodEnd: iso(row.period_end),
    catalogSnapshot: JSON.parse(JSON.stringify(row.metadata?.catalogSnapshot || {})) as PackageCatalogVersionSnapshot,
    policySnapshot: subscriptionPolicySnapshot,
    idempotencyKey: String(row.idempotency_key),
  };
}

export interface BillingOrderSnapshot {
  billingOrderId: string;
  merchantId: string;
  purpose: BillingOrderPurpose;
  status: BillingOrderStatus;
  businessPurpose: "platform_subscription";
  providerConfigPurpose: "platform_billing";
  currentPackageKey: PackageKey | null;
  targetPackageKey: PackageKey;
  amount: MoneyVnd;
  periodStart: string;
  periodEnd: string;
  catalogSnapshot: PackageCatalogVersionSnapshot;
  policySnapshot: typeof subscriptionPolicySnapshot;
  idempotencyKey: string;
}

export interface NOWPaymentsQuote {
  vndAmount: string;
  providerCurrency: string;
  providerNetwork: string;
  providerAmount: string;
  providerPaymentId: string | null;
  quoteExpiresAt: string;
}

export interface CreateBillingOrderInput {
  merchantId: string;
  purpose: BillingOrderPurpose;
  currentPackageKey?: PackageKey | null;
  targetPackageKey: PackageKey;
  periodStart: Date;
  periodEnd: Date;
  amountVnd: string;
  idempotencyKey?: string;
  requestedBy?: string;
  quote?: NOWPaymentsQuote;
  metadata?: Record<string, unknown>;
}

function catalogVersionId(packageKey: PackageKey): string {
  const prefix = packageCatalogVersion.replace(/\./g, "_").replace(/-/g, "_");
  return `pcv_${prefix}_${packageKey}`;
}

export async function createBillingOrder(input: CreateBillingOrderInput): Promise<{
  data: BillingOrderSnapshot;
}> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    return createBillingOrderTx(client, input);
  });
}

export async function createBillingOrderTx(
  client: PoolClient,
  input: CreateBillingOrderInput,
): Promise<{ data: BillingOrderSnapshot }> {
  const billingOrderId = id("bo");
  const idempotencyKey = input.idempotencyKey || id("bo_idem");
  const catalogVersionId_ = catalogVersionId(input.targetPackageKey);
  const quoteExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  const providerQuoteJson: Record<string, unknown> = input.quote
    ? {
        vndAmount: input.quote.vndAmount,
        providerCurrency: input.quote.providerCurrency,
        providerNetwork: input.quote.providerNetwork,
        providerAmount: input.quote.providerAmount,
        providerPaymentId: input.quote.providerPaymentId ?? null,
        quoteExpiresAt: input.quote.quoteExpiresAt || quoteExpiresAt.toISOString(),
        quotedAt: new Date().toISOString(),
      }
    : {};

  const catalogEntry = getCatalogEntryInMemory(input.targetPackageKey);
  const metadata: Record<string, unknown> = {
    ...(input.metadata || {}),
    source: "billing_order_service",
    catalogSnapshot: {
      catalogVersionId: catalogVersionId_,
      catalogVersion: catalogEntry.catalogVersion,
      packageKey: catalogEntry.packageKey,
      annualPrice: catalogEntry.annualPrice,
      includedStores: catalogEntry.includedStores,
      staffLimit: catalogEntry.staffLimit,
      researchRunsPerMonth: catalogEntry.researchRunsPerMonth,
      telegramAiDraftsPerMonth: catalogEntry.telegramAiDraftsPerMonth,
      featureKeys: catalogEntry.featureKeys,
      effectiveFrom: "2026-06-20T00:00:00.000Z",
    },
  };

  const row = await queryOne<BillingOrderRow>(client, `
    INSERT INTO app.billing_orders (
      id, merchant_id, purpose, current_package_key, target_package_key,
      catalog_version_id, policy_version, period_start, period_end,
      amount_vnd, provider, provider_payment_id, provider_quote_json, status,
      requested_by, quote_expires_at, idempotency_key, metadata
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'nowpayments',$11,$12,'waiting_payment',$13,$14,$15,$16::jsonb)
    ON CONFLICT (merchant_id, idempotency_key) DO UPDATE SET updated_at = now()
    RETURNING *
  `, [
    billingOrderId,
    input.merchantId,
    input.purpose,
    input.currentPackageKey ?? null,
    input.targetPackageKey,
    catalogVersionId_,
    subscriptionPolicySnapshot.policyVersion,
    input.periodStart.toISOString(),
    input.periodEnd.toISOString(),
    input.amountVnd,
    input.quote?.providerPaymentId ?? null,
    JSON.stringify(providerQuoteJson),
    input.requestedBy ?? null,
    (input.quote?.quoteExpiresAt ? new Date(input.quote.quoteExpiresAt) : quoteExpiresAt).toISOString(),
    idempotencyKey,
    JSON.stringify(metadata),
  ]);

  if (!row) {
    throw new PlatformError("billing_order_create_failed", "Could not create billing order", 500);
  }

  return { data: rowToSnapshot(row) };
}

export async function getBillingOrder(
  billingOrderId: string,
  options?: { client?: PoolClient },
): Promise<BillingOrderSnapshot | null> {
  const run = async (client: PoolClient) => {
    const row = await queryOne<BillingOrderRow>(client, `
      SELECT * FROM app.billing_orders WHERE id = $1 LIMIT 1
    `, [billingOrderId]);
    return row ? rowToSnapshot(row) : null;
  };

  if (options?.client) return run(options.client);
  await ensurePlatformSchema();
  return withConnectedClient(run);
}

export async function getBillingOrderByIdempotencyKey(
  merchantId: string,
  idempotencyKey: string,
  options?: { client?: PoolClient },
): Promise<BillingOrderSnapshot | null> {
  const run = async (client: PoolClient) => {
    const row = await queryOne<BillingOrderRow>(client, `
      SELECT * FROM app.billing_orders
      WHERE merchant_id = $1 AND idempotency_key = $2
      LIMIT 1
    `, [merchantId, idempotencyKey]);
    return row ? rowToSnapshot(row) : null;
  };

  if (options?.client) return run(options.client);
  await ensurePlatformSchema();
  return withConnectedClient(run);
}

export async function getBillingOrderByProviderPaymentId(
  provider: string,
  providerPaymentId: string,
  options?: { client?: PoolClient },
): Promise<BillingOrderSnapshot | null> {
  const run = async (client: PoolClient) => {
    const row = await queryOne<BillingOrderRow>(client, `
      SELECT * FROM app.billing_orders
      WHERE provider = $1 AND provider_payment_id = $2
      LIMIT 1
    `, [provider, providerPaymentId]);
    return row ? rowToSnapshot(row) : null;
  };

  if (options?.client) return run(options.client);
  await ensurePlatformSchema();
  return withConnectedClient(run);
}

export async function listBillingOrdersForMerchant(
  merchantId: string,
  options?: { client?: PoolClient; limit?: number },
): Promise<{ data: BillingOrderSnapshot[] }> {
  const run = async (client: PoolClient) => {
    const limit = options?.limit ?? 50;
    const result = await client.query<BillingOrderRow>(`
      SELECT * FROM app.billing_orders
      WHERE merchant_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [merchantId, limit]);
    return { data: result.rows.map(rowToSnapshot) };
  };

  if (options?.client) return run(options.client);
  await ensurePlatformSchema();
  return withConnectedClient(run);
}

export type BillingOrderReadModel = {
  billingOrderId: string;
  merchantId: string;
  purpose: BillingOrderPurpose;
  targetPackageKey: PackageKey;
  amountVnd: string;
  status: BillingOrderStatus;
  quoteExpiresAt: string;
  providerPaymentId: string | null;
  paidAt: string | null;
  appliedAt: string | null;
  manualReviewReason: string | null;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
};

function rowToReadModel(row: BillingOrderRow): BillingOrderReadModel {
  return {
    billingOrderId: String(row.id),
    merchantId: String(row.merchant_id),
    purpose: row.purpose as BillingOrderPurpose,
    targetPackageKey: row.target_package_key as PackageKey,
    amountVnd: row.amount_vnd,
    status: row.status as BillingOrderStatus,
    quoteExpiresAt: iso(row.quote_expires_at),
    providerPaymentId: row.provider_payment_id as string | null,
    paidAt: row.paid_at ? iso(row.paid_at) : null,
    appliedAt: row.applied_at ? iso(row.applied_at) : null,
    manualReviewReason: row.manual_review_reason as string | null,
    periodStart: iso(row.period_start),
    periodEnd: iso(row.period_end),
    createdAt: iso(row.created_at),
  };
}

export async function getBillingOrderReadModels(
  merchantId: string,
  options?: { client?: PoolClient },
): Promise<{ data: BillingOrderReadModel[] }> {
  const run = async (client: PoolClient) => {
    const result = await client.query<BillingOrderRow>(`
      SELECT * FROM app.billing_orders
      WHERE merchant_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [merchantId]);
    return { data: result.rows.map(rowToReadModel) };
  };

  if (options?.client) return run(options.client);
  await ensurePlatformSchema();
  return withConnectedClient(run);
}

export type UpdateBillingOrderStatusInput =
  | { status: "paid"; providerPaymentId: string; paidAt?: Date }
  | { status: "applied"; appliedAt?: Date }
  | { status: "expired" }
  | { status: "cancelled" }
  | { status: "failed" }
  | { status: "manual_review"; reason: string }
  | { status: "waiting_payment"; quote?: NOWPaymentsQuote };

export async function updateBillingOrderStatus(
  billingOrderId: string,
  input: UpdateBillingOrderStatusInput,
  options?: { client?: PoolClient },
): Promise<{ data: BillingOrderSnapshot }> {
  const run = async (client: PoolClient) => {
    let setClauses: string[] = ["status = $2", "updated_at = now()"];
    const params: unknown[] = [billingOrderId, input.status];

    if (input.status === "paid" && "providerPaymentId" in input) {
      setClauses.push("provider_payment_id = $3");
      params.push(input.providerPaymentId);
      setClauses.push("paid_at = $4");
      params.push((input.paidAt || new Date()).toISOString());
    }
    if (input.status === "applied" && "appliedAt" in input) {
      setClauses.push("applied_at = $3");
      params.push(input.appliedAt?.toISOString() ?? new Date().toISOString());
    }
    if (input.status === "manual_review" && "reason" in input) {
      setClauses.push("manual_review_reason = $3");
      params.push(input.reason);
    }
    if (input.status === "waiting_payment" && "quote" in input && input.quote) {
      setClauses.push("provider_quote_json = $3");
      setClauses.push("quote_expires_at = $4");
      setClauses.push("provider_payment_id = COALESCE($5, provider_payment_id)");
      params.push(JSON.stringify({
        vndAmount: input.quote.vndAmount,
        providerCurrency: input.quote.providerCurrency,
        providerNetwork: input.quote.providerNetwork,
        providerAmount: input.quote.providerAmount,
        providerPaymentId: input.quote.providerPaymentId ?? null,
        quoteExpiresAt: input.quote.quoteExpiresAt,
        quotedAt: new Date().toISOString(),
      }));
      params.push(new Date(input.quote.quoteExpiresAt).toISOString());
      params.push(input.quote.providerPaymentId ?? null);
    }

    const row = await queryOne<BillingOrderRow>(client, `
      UPDATE app.billing_orders
      SET ${setClauses.join(", ")}
      WHERE id = $1
      RETURNING *
    `, params);

    if (!row) throw new PlatformError("resource_not_found", "Billing order not found", 404);
    return { data: rowToSnapshot(row) };
  };

  if (options?.client) return run(options.client);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => run(client));
}

export async function expireBillingOrder(
  billingOrderId: string,
  options?: { client?: PoolClient },
): Promise<{ data: BillingOrderSnapshot }> {
  return updateBillingOrderStatus(billingOrderId, { status: "expired" }, options);
}

export async function setBillingOrderManualReview(
  billingOrderId: string,
  reason: string,
  options?: { client?: PoolClient },
): Promise<{ data: BillingOrderSnapshot }> {
  return updateBillingOrderStatus(billingOrderId, { status: "manual_review", reason }, options);
}

export async function insertBillingProviderEvent(
  client: PoolClient,
  event: {
    provider: string;
    providerEventId: string;
    billingOrderId?: string | null;
    eventType: string;
    providerPaymentId?: string | null;
    status: "received" | "matched" | "ignored" | "manual_review" | "applied";
    error?: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(`
    INSERT INTO app.billing_provider_events (
      provider, provider_event_id, billing_order_id, event_type,
      provider_payment_id, status, error, payload
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT (provider, provider_event_id) DO NOTHING
  `, [
    event.provider,
    event.providerEventId,
    event.billingOrderId ?? null,
    event.eventType,
    event.providerPaymentId ?? null,
    event.status,
    event.error ?? null,
    JSON.stringify(event.payload),
  ]);
}

export async function upsertBillingProviderEvent(
  client: PoolClient,
  event: {
    provider: string;
    providerEventId: string;
    billingOrderId?: string | null;
    eventType: string;
    providerPaymentId?: string | null;
    status: "received" | "matched" | "ignored" | "manual_review" | "applied";
    error?: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(`
    INSERT INTO app.billing_provider_events (
      provider, provider_event_id, billing_order_id, event_type,
      provider_payment_id, status, error, payload
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT (provider, provider_event_id) DO UPDATE SET
      billing_order_id = COALESCE(EXCLUDED.billing_order_id, billing_provider_events.billing_order_id),
      status = EXCLUDED.status,
      error = COALESCE(EXCLUDED.error, billing_provider_events.error)
  `, [
    event.provider,
    event.providerEventId,
    event.billingOrderId ?? null,
    event.eventType,
    event.providerPaymentId ?? null,
    event.status,
    event.error ?? null,
    JSON.stringify(event.payload),
  ]);
}
