/**
 * subscription-billing-service.ts
 * Platform package billing through NOWPayments.
 *
 * Orchestrates:
 *  1. New annual subscription purchase (Basic → Plus/AI Fan)
 *  2. Plus → AI Fan upgrade with remaining-term proration
 *  3. Extra-store add-on (1,188,000 VND/year prorated; 10-store cap)
 *  4. Renewal: before/during grace extends prior period_end; after grace starts at applied time
 *  5. Billing order lifecycle: draft → waiting_payment → paid → applied / manual_review / expired
 *
 * INVARIANTS (enforced here):
 *  - No public.order, inventory, loyalty or merchant retail accounting row is ever created.
 *  - Tax is already included; no tax is added.
 *  - Provider fee is absorbed; entitlement is applied on original VND amount.
 *  - Concurrent callbacks cannot apply the subscription twice (DB FOR UPDATE + applied_at guard).
 *  - Package remains unchanged on any provider failure.
 */

import type { PackageKey } from "@medusa-snus/contracts";
import {
  vndPackagePrices,
  calculateAnnualProration,
  subscriptionPolicySnapshot,
  packageCatalogVersion,
} from "@medusa-snus/contracts";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { id } from "../utils/id";
import {
  createBillingOrderTx,
  getBillingOrderByProviderPaymentId,
  updateBillingOrderStatus,
  insertBillingProviderEvent,
  upsertBillingProviderEvent,
  setBillingOrderManualReview,
  type BillingOrderSnapshot,
  type NOWPaymentsQuote,
} from "./billing-order-service";
import {
  getMerchantSubscriptionStatus,
  applySubscriptionPurchase,
  appendSubscriptionEvent,
  addCalendarYearsClamped,
  addCalendarDays,
} from "./subscription-service";
import { findCatalogVersionIdByPackageKey, getCatalogEntryInMemory } from "./package-catalog-service";

// ── Terminal NOWPayments payment statuses that represent a verified payment ──
const NOWPAYMENTS_TERMINAL_SUCCESS_STATUSES = new Set([
  "finished",
  "confirmed",
]);

const NOWPAYMENTS_TERMINAL_FAILURE_STATUSES = new Set([
  "failed",
  "refunded",
  "expired",
  "partially_paid",
  "sending",
  "waiting",
  "confirming",
]);

// Max active stores enforced by the spec (10).
const MAX_ACTIVE_STORES = 10;
const EXTRA_STORE_ANNUAL_VND = BigInt(vndPackagePrices.extra_store);

// ── Helpers ──────────────────────────────────────────────────────────────────

function intBigInt(value: string | number): bigint {
  const parsed = typeof value === "string" ? BigInt(value) : BigInt(Math.round(value));
  if (parsed < 0n) throw new PlatformError("invalid_amount", "Amount cannot be negative", 400);
  return parsed;
}

/** Ceil-to-integer-VND-thousand rounding (spec 5.4). */
function ceilTo1000(amount: bigint): bigint {
  return amount === 0n ? 0n : ((amount + 999n) / 1000n) * 1000n;
}

/** Calendar-year proration: (delta × remaining_ms) / total_ms, ceil to 1000. */
function prorateAmount(
  annualPriceDelta: bigint,
  periodStart: Date,
  periodEnd: Date,
  now: Date,
): bigint {
  const totalMs = BigInt(periodEnd.getTime() - periodStart.getTime());
  if (totalMs <= 0n) return annualPriceDelta;
  const elapsed = BigInt(Math.max(0, now.getTime() - periodStart.getTime()));
  const remaining = totalMs - (elapsed > totalMs ? totalMs : elapsed);
  if (remaining <= 0n) return 0n;
  const raw = (annualPriceDelta * remaining + totalMs - 1n) / totalMs;
  return ceilTo1000(raw);
}

async function activeStoreCount(client: PoolClient, merchantId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(client, `
    SELECT count(*)::text AS count FROM app.stores
    WHERE merchant_id = $1 AND status = 'active'
  `, [merchantId]);
  return row ? Number(row.count) : 0;
}

// ── 1. New Subscription Purchase (Basic → Plus | AI Fan) ─────────────────────

export interface InitiateNewSubscriptionInput {
  merchantId: string;
  targetPackageKey: "plus" | "ai_fan";
  requestedBy?: string;
  idempotencyKey?: string;
  quote?: NOWPaymentsQuote;
}

export async function initiateNewSubscription(input: InitiateNewSubscriptionInput): Promise<{
  data: BillingOrderSnapshot;
}> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: input.merchantId });
    const sub = await getMerchantSubscriptionStatus(input.merchantId, { client });
    if (sub.packageKey !== "basic") {
      throw new PlatformError(
        "invalid_billing_transition",
        "New-subscription purchase requires current package to be basic",
        409,
        { current: sub.packageKey },
      );
    }

    const catalog = getCatalogEntryInMemory(input.targetPackageKey);
    const amountVnd = catalog.annualPrice.amountVnd;
    const periodStart = new Date();
    const periodEnd = addCalendarYearsClamped(periodStart, 1);

    return createBillingOrderTx(client, {
      merchantId: input.merchantId,
      purpose: "new_subscription",
      currentPackageKey: "basic",
      targetPackageKey: input.targetPackageKey,
      periodStart,
      periodEnd,
      amountVnd,
      requestedBy: input.requestedBy,
      idempotencyKey: input.idempotencyKey,
      quote: input.quote,
      metadata: {
        catalogVersion: packageCatalogVersion,
        policyVersion: subscriptionPolicySnapshot.policyVersion,
        taxInclusive: true,
      },
    });
  });
}

// ── 2. Upgrade (Plus → AI Fan) with remaining-term proration ─────────────────

export interface InitiateUpgradeInput {
  merchantId: string;
  requestedBy?: string;
  idempotencyKey?: string;
  quote?: NOWPaymentsQuote;
}

export async function initiateUpgrade(input: InitiateUpgradeInput): Promise<{
  data: BillingOrderSnapshot;
}> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: input.merchantId });
    const sub = await getMerchantSubscriptionStatus(input.merchantId, { client });
    if (sub.packageKey !== "plus") {
      throw new PlatformError(
        "invalid_billing_transition",
        "Upgrade to AI Fan requires current package to be plus",
        409,
        { current: sub.packageKey },
      );
    }
    if (sub.status === "expired") {
      throw new PlatformError("subscription_expired", "Cannot upgrade an expired subscription", 409);
    }

    const plusPrice = BigInt(vndPackagePrices.plus);
    const aiFanPrice = BigInt(vndPackagePrices.ai_fan);
    const now = new Date();
    const periodStart = new Date(sub.currentPeriodStart);
    const periodEnd = new Date(sub.currentPeriodEnd);

    const proratedAmount = prorateAmount(aiFanPrice - plusPrice, periodStart, periodEnd, now);

    return createBillingOrderTx(client, {
      merchantId: input.merchantId,
      purpose: "upgrade",
      currentPackageKey: "plus",
      targetPackageKey: "ai_fan",
      periodStart,
      periodEnd, // keeps the common renewal date
      amountVnd: proratedAmount.toString(),
      requestedBy: input.requestedBy,
      idempotencyKey: input.idempotencyKey,
      quote: input.quote,
      metadata: {
        catalogVersion: packageCatalogVersion,
        policyVersion: subscriptionPolicySnapshot.policyVersion,
        taxInclusive: true,
        prorationNote: "remaining_term_proration_plus_to_ai_fan",
      },
    });
  });
}

// ── 3. Extra Store Add-On ─────────────────────────────────────────────────────

export interface InitiateStoreAddonInput {
  merchantId: string;
  requestedBy?: string;
  idempotencyKey?: string;
  quote?: NOWPaymentsQuote;
}

export async function initiateStoreAddon(input: InitiateStoreAddonInput): Promise<{
  data: BillingOrderSnapshot;
}> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: input.merchantId });
    const sub = await getMerchantSubscriptionStatus(input.merchantId, { client });
    if (sub.packageKey === "basic") {
      throw new PlatformError(
        "invalid_billing_transition",
        "Extra store add-on requires Plus or AI Fan package",
        409,
        { current: sub.packageKey },
      );
    }
    if (sub.status === "expired") {
      throw new PlatformError("subscription_expired", "Cannot add store on an expired subscription", 409);
    }

    // Check current active store count against cap
    const currentStores = await activeStoreCount(client, input.merchantId);
    if (currentStores >= MAX_ACTIVE_STORES) {
      throw new PlatformError(
        "store_cap_reached",
        `Merchant already has ${currentStores} active stores; maximum is ${MAX_ACTIVE_STORES}`,
        409,
        { current: currentStores, max: MAX_ACTIVE_STORES },
      );
    }

    const now = new Date();
    const periodStart = new Date(sub.currentPeriodStart);
    const periodEnd = new Date(sub.currentPeriodEnd);
    const proratedAmount = prorateAmount(EXTRA_STORE_ANNUAL_VND, periodStart, periodEnd, now);

    return createBillingOrderTx(client, {
      merchantId: input.merchantId,
      purpose: "store_addon",
      currentPackageKey: sub.packageKey,
      targetPackageKey: sub.packageKey, // package itself does not change
      periodStart,
      periodEnd, // shares renewal date with subscription
      amountVnd: proratedAmount.toString(),
      requestedBy: input.requestedBy,
      idempotencyKey: input.idempotencyKey,
      quote: input.quote,
      metadata: {
        catalogVersion: packageCatalogVersion,
        policyVersion: subscriptionPolicySnapshot.policyVersion,
        taxInclusive: true,
        extraStoreAnnualVnd: EXTRA_STORE_ANNUAL_VND.toString(),
        prorationNote: "remaining_term_proration_extra_store",
        currentStoreCount: currentStores,
      },
    });
  });
}

// ── 4. Renewal ────────────────────────────────────────────────────────────────

export interface InitiateRenewalInput {
  merchantId: string;
  requestedBy?: string;
  idempotencyKey?: string;
  quote?: NOWPaymentsQuote;
}

export async function initiateRenewal(input: InitiateRenewalInput): Promise<{
  data: BillingOrderSnapshot;
}> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId: input.merchantId });
    const sub = await getMerchantSubscriptionStatus(input.merchantId, { client });
    if (sub.packageKey === "basic") {
      throw new PlatformError("invalid_billing_transition", "Basic is free; renewal is not required", 409);
    }

    // Renewal window: T-30 from period end
    const now = new Date();
    const periodEnd = new Date(sub.currentPeriodEnd);
    const renewalOpenAt = new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (now < renewalOpenAt) {
      throw new PlatformError(
        "renewal_not_open",
        "Renewal window opens 30 days before period end",
        409,
        { opensAt: renewalOpenAt.toISOString(), periodEnd: periodEnd.toISOString() },
      );
    }

    const catalog = getCatalogEntryInMemory(sub.packageKey);
    const amountVnd = catalog.annualPrice.amountVnd;

    // Period for the renewed term: depends on when it is applied (see applyBillingOrderToPurchase)
    // We record the anticipated period here; it is recalculated at application time.
    const anticipatedStart = periodEnd;
    const anticipatedEnd = addCalendarYearsClamped(anticipatedStart, 1);

    return createBillingOrderTx(client, {
      merchantId: input.merchantId,
      purpose: "renewal",
      currentPackageKey: sub.packageKey,
      targetPackageKey: sub.packageKey,
      periodStart: anticipatedStart,
      periodEnd: anticipatedEnd,
      amountVnd,
      requestedBy: input.requestedBy,
      idempotencyKey: input.idempotencyKey,
      quote: input.quote,
      metadata: {
        catalogVersion: packageCatalogVersion,
        policyVersion: subscriptionPolicySnapshot.policyVersion,
        taxInclusive: true,
        renewalNote: "renewal_from_period_end",
        currentStatus: sub.status,
        priorPeriodEnd: periodEnd.toISOString(),
      },
    });
  });
}

// ── 5. Apply billing order after verified NOWPayments payment ─────────────────
//
// Called inside the webhook handler once a terminal success status is confirmed
// and idempotency/quote checks pass. Uses SELECT FOR UPDATE to prevent double-apply.
//

export async function applyBillingOrderToPurchase(
  billingOrderId: string,
  appliedAt: Date = new Date(),
): Promise<{ data: { subscriptionStatus: Awaited<ReturnType<typeof getMerchantSubscriptionStatus>> } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    // Lock the billing order row exclusively
    const orderRow = await queryOne<{
      id: string;
      merchant_id: string;
      purpose: string;
      current_package_key: string | null;
      target_package_key: string;
      amount_vnd: string;
      status: string;
      applied_at: string | null;
      period_start: string;
      period_end: string;
      provider_quote_json: Record<string, unknown>;
      metadata: Record<string, unknown>;
    }>(client, `
      SELECT * FROM app.billing_orders WHERE id = $1 FOR UPDATE
    `, [billingOrderId]);

    if (!orderRow) {
      throw new PlatformError("resource_not_found", "Billing order not found", 404);
    }
    // Idempotent: already applied
    if (orderRow.status === "applied") {
      const sub = await getMerchantSubscriptionStatus(orderRow.merchant_id, { client });
      return { data: { subscriptionStatus: sub } };
    }
    if (orderRow.status !== "paid") {
      throw new PlatformError(
        "billing_order_invalid_state",
        `Cannot apply billing order in status '${orderRow.status}'`,
        409,
      );
    }

    const purpose = orderRow.purpose as "new_subscription" | "renewal" | "upgrade" | "store_addon";
    const merchantId = orderRow.merchant_id;
    const targetPackageKey = orderRow.target_package_key as PackageKey;
    const meta = (orderRow.metadata || {}) as Record<string, unknown>;

    if (purpose === "store_addon") {
      // Store add-on: enforce 10-cap before allowing store creation flag
      const currentStores = await activeStoreCount(client, merchantId);
      if (currentStores >= MAX_ACTIVE_STORES) {
        await setBillingOrderManualReview(
          billingOrderId,
          `store_cap_reached: ${currentStores} active stores at apply time`,
          { client },
        );
        throw new PlatformError("store_cap_reached", "Store cap reached at apply time", 409);
      }

      await client.query(`
        UPDATE app.billing_orders
        SET status = 'applied', applied_at = $2, updated_at = now(),
            metadata = metadata || $3::jsonb
        WHERE id = $1
      `, [billingOrderId, appliedAt.toISOString(), JSON.stringify({ storeAddonApplied: true, appliedStoreCount: currentStores })]);

      const sub = await getMerchantSubscriptionStatus(merchantId, { client });
      return { data: { subscriptionStatus: sub } };
    }

    // Determine effective start/end for subscription
    const currentSub = await getMerchantSubscriptionStatus(merchantId, { client });

    if (purpose === "upgrade") {
      if (currentSub.status === "expired") {
        await setBillingOrderManualReview(billingOrderId, "subscription_expired_before_upgrade_apply", { client });
        throw new PlatformError("subscription_expired", "Cannot apply upgrade after subscription expiry", 409);
      }
      if (currentSub.packageKey !== "plus" || targetPackageKey !== "ai_fan") {
        await setBillingOrderManualReview(billingOrderId, "invalid_upgrade_state", { client });
        throw new PlatformError("invalid_billing_transition", "Upgrade requires Plus → AI Fan", 409);
      }

      const catalogVersionId = await findCatalogVersionIdByPackageKey("ai_fan", { client });
      await client.query(`
        UPDATE app.merchant_subscriptions
        SET package_key = 'ai_fan',
            catalog_version_id = $2,
            status = $3,
            updated_at = now(),
            metadata = metadata || $4::jsonb
        WHERE id = $1
      `, [
        currentSub.subscriptionId,
        catalogVersionId,
        currentSub.status,
        JSON.stringify({ upgradedFromBillingOrderId: billingOrderId }),
      ]);
      await appendSubscriptionEvent(
        client,
        merchantId,
        currentSub.subscriptionId,
        "subscription.upgraded",
        new Date(currentSub.currentPeriodEnd),
        null,
        {
          packageKey: "ai_fan",
          previousPackageKey: "plus",
          sourceBillingOrderId: billingOrderId,
          periodStart: currentSub.currentPeriodStart,
          periodEnd: currentSub.currentPeriodEnd,
        },
      );
      await client.query(`
        UPDATE app.billing_orders
        SET status = 'applied', applied_at = $2, updated_at = now()
        WHERE id = $1
      `, [billingOrderId, appliedAt.toISOString()]);
      const upgraded = await getMerchantSubscriptionStatus(merchantId, { client });
      return { data: { subscriptionStatus: upgraded } };
    }

    let effectiveAt: Date;

    if (purpose === "renewal") {
      const priorPeriodEnd = meta.priorPeriodEnd
        ? new Date(meta.priorPeriodEnd as string)
        : new Date(currentSub.currentPeriodEnd);

      if (currentSub.status === "active" || currentSub.status === "grace") {
        // Paid before or during grace: extend from prior period_end
        effectiveAt = priorPeriodEnd;
      } else {
        // After grace (expired): start from applied time
        effectiveAt = appliedAt;
      }
    } else {
      // new_subscription or upgrade: start now
      effectiveAt = appliedAt;
    }

    const eventTypeMap: Record<"new_subscription" | "renewal" | "upgrade", "subscription.activated" | "subscription.renewed" | "subscription.upgraded" | "subscription.reactivated"> = {
      new_subscription: currentSub.status === "expired" ? "subscription.reactivated" : "subscription.activated",
      renewal: currentSub.status === "expired" ? "subscription.reactivated" : "subscription.renewed",
      upgrade: "subscription.upgraded",
    };
    const eventType = eventTypeMap[purpose as "new_subscription" | "renewal" | "upgrade"];

    // Call applySubscriptionPurchase (does the actual DB mutation)
    const newSub = await applySubscriptionPurchase({
      merchantId,
      packageKey: targetPackageKey,
      effectiveAt,
      eventType,
    });

    // Mark billing order applied
    await client.query(`
      UPDATE app.billing_orders
      SET status = 'applied', applied_at = $2, updated_at = now()
      WHERE id = $1
    `, [billingOrderId, appliedAt.toISOString()]);

    return { data: { subscriptionStatus: newSub.data } };
  });
}

// ── 6. NOWPayments IPN handling for platform_billing ─────────────────────────
//
// Entry point called by the webhook route after HMAC is verified.
// Enforces: purpose isolation, payment identity, terminal status allowlist,
// exact quote, dedupe, and manual_review branching.
//

export interface PlatformNowPaymentsWebhookInput {
  providerEventId: string;
  eventType: string;
  paymentStatus: string;
  providerPaymentId: string;
  payCurrency: string;       // e.g. "usdttrc20"
  providerNetwork?: string;  // e.g. "trc20"
  payAmount: number;         // crypto amount received
  priceAmount: number;       // VND or USD quoted
  priceCurrency: string;
  orderId?: string;          // NOWPayments order_id, should match billing order id when present
  orderDescription?: string; // free-form provider description
  payload: Record<string, unknown>;
}

export async function handlePlatformNowPaymentsWebhook(
  input: PlatformNowPaymentsWebhookInput,
): Promise<{ success: boolean; status: string; billingOrderId?: string; reason?: string }> {
  await ensurePlatformSchema();
  const result = await withConnectedTransaction(async (client) => {
    const { providerEventId, paymentStatus, providerPaymentId, payCurrency, providerNetwork, payAmount, priceAmount, priceCurrency } = input;

    // Resolve billing order from provider_payment_id
    const billingOrderRow = await queryOne<{
      id: string;
      merchant_id: string;
      amount_vnd: string;
      status: string;
      applied_at: string | null;
      quote_expires_at: string;
      provider_quote_json: Record<string, unknown>;
      provider_payment_id: string | null;
      purpose: string;
    }>(client, `
      SELECT * FROM app.billing_orders
      WHERE provider = 'nowpayments' AND provider_payment_id = $1
      FOR UPDATE
    `, [providerPaymentId]);

    // Check for duplicate IPN (idempotent return)
    const existingEvent = await queryOne<{ id: string; status: string }>(client, `
      SELECT id, status FROM app.billing_provider_events
      WHERE provider = 'nowpayments' AND provider_event_id = $1
      LIMIT 1
    `, [providerEventId]);

    if (existingEvent) {
      // Duplicate event — return success without re-applying
      return { success: true, status: "duplicate_ignored", billingOrderId: billingOrderRow?.id };
    }

    if (!billingOrderRow) {
      await insertBillingProviderEvent(client, {
        provider: "nowpayments",
        providerEventId,
        billingOrderId: null,
        eventType: input.eventType,
        providerPaymentId,
        status: "ignored",
        error: "no_billing_order_for_payment_id",
        payload: input.payload,
      });
      return { success: true, status: "ignored", reason: "no_billing_order_for_payment_id" };
    }

    const billingOrderId = billingOrderRow.id;

    // Already applied — idempotent
    if (billingOrderRow.status === "applied") {
      await insertBillingProviderEvent(client, {
        provider: "nowpayments",
        providerEventId,
        billingOrderId,
        eventType: input.eventType,
        providerPaymentId,
        status: "ignored",
        error: "already_applied",
        payload: input.payload,
      });
      return { success: true, status: "already_applied", billingOrderId };
    }

    // Already in manual_review — record and return
    if (billingOrderRow.status === "manual_review") {
      await insertBillingProviderEvent(client, {
        provider: "nowpayments",
        providerEventId,
        billingOrderId,
        eventType: input.eventType,
        providerPaymentId,
        status: "manual_review",
        error: "order_already_in_manual_review",
        payload: input.payload,
      });
      return { success: true, status: "manual_review", billingOrderId };
    }

    // Non-terminal: record and wait
    if (!NOWPAYMENTS_TERMINAL_SUCCESS_STATUSES.has(paymentStatus) && !NOWPAYMENTS_TERMINAL_FAILURE_STATUSES.has(paymentStatus)) {
      await insertBillingProviderEvent(client, {
        provider: "nowpayments",
        providerEventId,
        billingOrderId,
        eventType: input.eventType,
        providerPaymentId,
        status: "received",
        error: null,
        payload: input.payload,
      });
      return { success: true, status: "pending_terminal", billingOrderId };
    }

    // Terminal failure
    if (NOWPAYMENTS_TERMINAL_FAILURE_STATUSES.has(paymentStatus)) {
      const failReason = `provider_terminal_failure:${paymentStatus}`;
      await upsertBillingProviderEvent(client, {
        provider: "nowpayments",
        providerEventId,
        billingOrderId,
        eventType: input.eventType,
        providerPaymentId,
        status: "manual_review",
        error: failReason,
        payload: input.payload,
      });
      if (billingOrderRow.status !== "expired" && billingOrderRow.status !== "cancelled") {
        await client.query(`
          UPDATE app.billing_orders
          SET status = 'manual_review', manual_review_reason = $2, updated_at = now()
          WHERE id = $1
        `, [billingOrderId, failReason]);
      }
      return { success: true, status: "manual_review", billingOrderId, reason: failReason };
    }

    // ── Terminal success: validate quote ─────────────────────────────────────
    const quote = billingOrderRow.provider_quote_json as Record<string, unknown>;
    const quoteExpiry = new Date(billingOrderRow.quote_expires_at);
    const now = new Date();
    const manualReviewReasons: string[] = [];

    // Quote expiry
    if (now > quoteExpiry) {
      manualReviewReasons.push("quote_expired");
    }

    // Payment identity/reference mismatch
    if (input.orderId && input.orderId !== billingOrderId) {
      manualReviewReasons.push(`conflicting_reference:received=${input.orderId},expected=${billingOrderId}`);
    }

    // Currency/network mismatch (must match what was quoted)
    const expectedCurrency = typeof quote.providerCurrency === "string"
      ? quote.providerCurrency.toLowerCase()
      : "";
    if (expectedCurrency && payCurrency.toLowerCase() !== expectedCurrency) {
      manualReviewReasons.push(`wrong_currency:received=${payCurrency},expected=${expectedCurrency}`);
    }
    const expectedNetwork = typeof quote.providerNetwork === "string"
      ? quote.providerNetwork.toLowerCase()
      : "";
    if (expectedNetwork && providerNetwork && providerNetwork.toLowerCase() !== expectedNetwork) {
      manualReviewReasons.push(`wrong_network:received=${providerNetwork},expected=${expectedNetwork}`);
    }

    // Amount mismatch: received crypto amount vs quoted
    const expectedCryptoAmount = typeof quote.providerAmount === "string"
      ? Number(quote.providerAmount)
      : 0;
    if (expectedCryptoAmount > 0) {
      const tolerance = expectedCryptoAmount * 0.0001; // 0.01% tolerance for dust
      if (Math.abs(payAmount - expectedCryptoAmount) > tolerance) {
        if (payAmount < expectedCryptoAmount) {
          manualReviewReasons.push(`underpayment:received=${payAmount},expected=${expectedCryptoAmount}`);
        } else {
          manualReviewReasons.push(`overpayment:received=${payAmount},expected=${expectedCryptoAmount}`);
        }
      }
    }

    // VND amount mismatch
    const expectedVndAmount = typeof billingOrderRow.amount_vnd === "string"
      ? BigInt(billingOrderRow.amount_vnd)
      : 0n;
    if (priceCurrency.toLowerCase() === "vnd" && priceAmount > 0) {
      const receivedVnd = BigInt(Math.round(priceAmount));
      if (receivedVnd !== expectedVndAmount) {
        manualReviewReasons.push(`vnd_amount_mismatch:received=${receivedVnd},expected=${expectedVndAmount}`);
      }
    }

    if (manualReviewReasons.length > 0) {
      const reason = manualReviewReasons.join("; ");
      await upsertBillingProviderEvent(client, {
        provider: "nowpayments",
        providerEventId,
        billingOrderId,
        eventType: input.eventType,
        providerPaymentId,
        status: "manual_review",
        error: reason,
        payload: input.payload,
      });
      await client.query(`
        UPDATE app.billing_orders
        SET status = 'manual_review', manual_review_reason = $2, updated_at = now()
        WHERE id = $1
      `, [billingOrderId, reason]);
      return { success: true, status: "manual_review", billingOrderId, reason };
    }

    // ── All checks passed: mark paid. Actual subscription application happens
    // after this transaction commits, avoiding a nested transaction while the
    // billing order row is locked.
    await upsertBillingProviderEvent(client, {
      provider: "nowpayments",
      providerEventId,
      billingOrderId,
      eventType: input.eventType,
      providerPaymentId,
      status: "matched",
      error: null,
      payload: input.payload,
    });

    await client.query(`
      UPDATE app.billing_orders
      SET status = 'paid', paid_at = now(), updated_at = now()
      WHERE id = $1 AND status NOT IN ('applied','manual_review','cancelled','failed')
    `, [billingOrderId]);

    return { success: true, status: "paid", billingOrderId };
  });

  if (result.status === "paid" && result.billingOrderId) {
    try {
      await applyBillingOrderToPurchase(result.billingOrderId, new Date());
      await ensurePlatformSchema();
      await withConnectedTransaction(async (client) => {
        await upsertBillingProviderEvent(client, {
          provider: "nowpayments",
          providerEventId: input.providerEventId,
          billingOrderId: result.billingOrderId,
          eventType: input.eventType,
          providerPaymentId: input.providerPaymentId,
          status: "applied",
          error: null,
          payload: input.payload,
        });
      });
      return { ...result, status: "applied" };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await ensurePlatformSchema();
      await withConnectedTransaction(async (client) => {
        await client.query(`
          UPDATE app.billing_orders
          SET status = 'manual_review', manual_review_reason = $2, updated_at = now()
          WHERE id = $1 AND status <> 'applied'
        `, [result.billingOrderId, `apply_failed: ${errMsg}`]);
        await upsertBillingProviderEvent(client, {
          provider: "nowpayments",
          providerEventId: input.providerEventId,
          billingOrderId: result.billingOrderId,
          eventType: input.eventType,
          providerPaymentId: input.providerPaymentId,
          status: "manual_review",
          error: `apply_failed: ${errMsg}`,
          payload: input.payload,
        });
      });
      return { ...result, status: "manual_review", reason: `apply_failed: ${errMsg}` };
    }
  }

  return result;
}

// ── 7. Quote a NOWPayments crypto amount (platform_billing only) ──────────────

export interface QuoteNowPaymentsBillingInput {
  amountVnd: string;
  payCurrency?: string;  // e.g. "usdttrc20"
  orderId?: string;      // billing order id for NOWPayments order_id
}

export interface QuoteNowPaymentsBillingResult {
  providerPaymentId: string | null;
  providerCurrency: string;
  providerNetwork: string;
  providerAmount: string;
  quoteExpiresAt: string;
}

export async function quoteNowPaymentsBillingOrder(
  input: QuoteNowPaymentsBillingInput,
): Promise<QuoteNowPaymentsBillingResult> {
  const liveEnabled = process.env.NOWPAYMENTS_BILLING_LIVE_ENABLED === "true";
  const apiKey = platformBillingApiKey();
  const apiBase = process.env.NOWPAYMENTS_BILLING_API_BASE || "https://api.nowpayments.io/v1";
  const callbackUrl = process.env.NOWPAYMENTS_BILLING_IPN_CALLBACK_URL;
  const payCurrency = input.payCurrency || process.env.NOWPAYMENTS_BILLING_PAY_CURRENCY || "usdttrc20";

  if (!liveEnabled) {
    // Offline / test mode: return mock quote. This intentionally does not read
    // NOWPAYMENTS_API_KEY or any merchant_retail credential.
    const quoteExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    return {
      providerPaymentId: null,
      providerCurrency: payCurrency,
      providerNetwork: inferNetworkFromCurrency(payCurrency),
      providerAmount: "0.00",
      quoteExpiresAt,
    };
  }

  if (!apiKey) {
    throw new PlatformError("provider_config_missing", "NOWPAYMENTS_BILLING_API_KEY is required for live platform billing", 503);
  }
  if (!callbackUrl) {
    throw new PlatformError("provider_config_missing", "NOWPAYMENTS_BILLING_IPN_CALLBACK_URL is required", 503);
  }
  if (process.env.NOWPAYMENTS_BILLING_WALLET_READY !== "true") {
    throw new PlatformError("provider_config_missing", "NOWPAYMENTS_BILLING_WALLET_READY=true is required before live package billing", 503);
  }

  // Convert VND to USD equivalent (NOWPayments requires price_currency=usd)
  const vndToUsd = Number(process.env.NOWPAYMENTS_BILLING_VND_TO_USD_RATE || "25000");
  const priceAmountUsd = Number((BigInt(input.amountVnd) / BigInt(Math.round(vndToUsd))).toString()) +
    (Number(input.amountVnd) % vndToUsd) / vndToUsd;

  const response = await fetch(`${apiBase.replace(/\/$/, "")}/payment`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      price_amount: Math.max(0.01, Number(priceAmountUsd.toFixed(2))),
      price_currency: "usd",
      pay_currency: payCurrency,
      ipn_callback_url: callbackUrl,
      order_id: input.orderId || `billing_${Date.now()}`,
      order_description: `Platform package billing VND ${input.amountVnd}`,
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new PlatformError("provider_request_failed", `NOWPayments billing quote failed HTTP ${response.status}`, 502, { payload });
  }
  const quoteExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  return {
    providerPaymentId: String(payload.payment_id || ""),
    providerCurrency: String(payload.pay_currency || payCurrency),
    providerNetwork: inferNetworkFromCurrency(String(payload.pay_currency || payCurrency)),
    providerAmount: String(payload.pay_amount || "0"),
    quoteExpiresAt,
  };
}

function platformBillingApiKey(): string {
  return process.env.NOWPAYMENTS_BILLING_API_KEY || "";
}

export function platformBillingIpnSecret(): string {
  return process.env.NOWPAYMENTS_BILLING_IPN_SECRET || "";
}

function inferNetworkFromCurrency(currency: string): string {
  const normalized = currency.toLowerCase();
  if (normalized.endsWith("trc20")) return "trc20";
  if (normalized.endsWith("erc20")) return "erc20";
  if (normalized.endsWith("matic") || normalized.endsWith("polygon")) return "polygon";
  if (normalized.endsWith("bsc")) return "bsc";
  return normalized;
}
