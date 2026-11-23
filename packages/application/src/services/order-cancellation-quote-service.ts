import { createHash } from "node:crypto";
import { CancellationQuoteV1Schema, type CancellationQuoteV1 } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { readCustomerRefundPositionV1 } from "./customer-refund-payable-service";

export interface CancellationQuoteScopeV1 {
  merchantId: string;
  storeId: string;
}

export interface CancellationQuoteReferenceV1 {
  quoteId: string;
  effectiveRevision: number;
  generatedAt: string;
}

type RevisionRow = Record<string, unknown>;

function safeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlatformError("financial_invariant_error", `${field} is invalid`, 409);
  }
  return parsed;
}

function stableQuoteId(value: unknown): string {
  return `cancel-quote-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function quoteFacts(
  client: PoolClient,
  orderId: string,
  scope: CancellationQuoteScopeV1,
  lock: boolean,
) {
  const revision = await client.query<RevisionRow>(`
    SELECT revisions.id::text AS revision_id, revisions.revision,
      revisions.commercial_state, revisions.currency_code,
      revisions.minor_unit_exponent, components.total_minor
    FROM app.order_commercial_revisions revisions
    JOIN app.order_commercial_revision_components components
      ON components.revision_id = revisions.id
    WHERE revisions.merchant_id = $1 AND revisions.store_id = $2
      AND revisions.order_id = $3
    ORDER BY revisions.revision DESC, revisions.effective_at DESC, revisions.id DESC
    LIMIT 1
    ${lock ? "FOR UPDATE OF revisions" : ""}
  `, [scope.merchantId, scope.storeId, orderId]);
  if (revision.rows.length !== 1 || revision.rows[0]!.commercial_state !== "active") {
    throw new PlatformError(
      "invalid_state_transition",
      "Order has no active canonical commercial revision to cancel",
      409,
    );
  }
  const current = revision.rows[0]!;
  if (current.currency_code !== "VND" || safeInteger(current.minor_unit_exponent, "minor exponent") !== 0) {
    throw new PlatformError("financial_invariant_error", "Cancellation currency is unsupported", 409);
  }
  const lines = await client.query<Record<string, unknown>>(`
    SELECT id::text AS line_id, quantity
    FROM app.order_commercial_revision_lines
    WHERE revision_id = $1::uuid
    ORDER BY line_key, id
  `, [current.revision_id]);
  if (lines.rows.length === 0) {
    throw new PlatformError("financial_invariant_error", "Cancellation has no effective stock lines", 409);
  }
  const paymentEvidence = await client.query<Record<string, unknown>>(`
    SELECT COUNT(*)::text AS event_count,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM app.payment_event_evidence evidence
        WHERE evidence.payment_event_id = events.id
          AND evidence.verification_status = 'verified'
          AND evidence.evidence_type = events.evidence_type
          AND evidence.evidence_fingerprint = events.evidence_fingerprint
      ))::text AS verified_count
    FROM app.payment_events events
    WHERE events.merchant_id = $1 AND events.store_id = $2
      AND events.order_id = $3 AND events.status = 'posted'
  `, [scope.merchantId, scope.storeId, orderId]);
  const loyalty = await client.query<Record<string, unknown>>(`
    SELECT GREATEST(0, COALESCE(SUM(points_earned - points_redeemed), 0))::text AS points
    FROM ai_module.loyalty_records
    WHERE merchant_id = $1 AND order_id = $2
  `, [scope.merchantId, orderId]);
  const position = await readCustomerRefundPositionV1(client, { ...scope, orderId });
  const payableToOpenMinor = Math.max(0, position.netCollectionsMinor - position.balanceMinor);
  const facts = {
    orderId,
    merchantId: scope.merchantId,
    storeId: scope.storeId,
    revision: safeInteger(current.revision, "effective revision"),
    totalMinor: safeInteger(current.total_minor, "effective total"),
    position,
    payableToOpenMinor,
    stock: lines.rows.map((line) => ({
      lineId: String(line.line_id),
      quantity: safeInteger(line.quantity, "effective line quantity"),
    })),
    pointsToReverse: safeInteger(loyalty.rows[0]?.points || 0, "loyalty points"),
    evidenceStatus: safeInteger(paymentEvidence.rows[0]?.event_count || 0, "payment event count")
      === safeInteger(paymentEvidence.rows[0]?.verified_count || 0, "verified payment event count")
      ? "verified" as const
      : "unavailable" as const,
  };
  return facts;
}

export async function createCancellationQuoteV1(
  client: PoolClient,
  orderId: string,
  scope: CancellationQuoteScopeV1,
): Promise<CancellationQuoteV1> {
  const facts = await quoteFacts(client, orderId, scope, false);
  const clock = await client.query<{ generated_at: Date | string }>(`
    SELECT transaction_timestamp() AS generated_at
  `);
  const generatedAt = new Date(clock.rows[0]!.generated_at).toISOString();
  const expiresAt = new Date(Date.parse(generatedAt) + 5 * 60_000).toISOString();
  const quoteId = stableQuoteId(facts);
  const payable = facts.payableToOpenMinor;
  return CancellationQuoteV1Schema.parse({
    schemaVersion: 1,
    quoteId,
    orderId,
    effectiveRevision: facts.revision,
    idempotencyKey: `cancel:${orderId}:rev-${facts.revision}:${quoteId.slice(-16)}`,
    generatedAt,
    expiresAt,
    paymentBalances: [{
      method: "unknown",
      currencyCode: "VND",
      collectedMinor: facts.position.recordedGrossCollectionsMinor,
      refundableMinor: facts.position.netCollectionsMinor,
      disposition: payable > 0 ? "customer_payable" : "no_action",
      evidenceStatus: facts.evidenceStatus,
    }],
    stockPreview: facts.stock.map((line) => ({ ...line, action: "restock" })),
    loyaltyPreview: { pointsToReverse: facts.pointsToReverse },
    journalPreview: payable > 0 ? [
      {
        kind: "revenue_vat_reverse",
        currencyCode: "VND",
        debitMinor: payable,
        creditMinor: payable,
      },
      {
        kind: "customer_payable_open",
        currencyCode: "VND",
        debitMinor: payable,
        creditMinor: payable,
      },
    ] : [],
    payablePreview: [{
      currencyCode: "VND",
      openMinor: payable,
      clearMinor: 0,
      balanceMinor: payable,
    }],
  });
}

export async function validateCancellationQuoteV1(
  client: PoolClient,
  orderId: string,
  scope: CancellationQuoteScopeV1,
  reference: CancellationQuoteReferenceV1,
): Promise<void> {
  const generatedAt = Date.parse(reference.generatedAt);
  const now = await client.query<{ now_at: Date | string }>(`SELECT transaction_timestamp() AS now_at`);
  const nowAt = new Date(now.rows[0]!.now_at).getTime();
  if (!Number.isFinite(generatedAt) || generatedAt > nowAt || nowAt - generatedAt > 5 * 60_000) {
    throw new PlatformError("cancellation_quote_expired", "Cancellation quote has expired", 409);
  }
  const facts = await quoteFacts(client, orderId, scope, true);
  if (
    reference.effectiveRevision !== facts.revision
    || reference.quoteId !== stableQuoteId(facts)
  ) {
    throw new PlatformError(
      "cancellation_quote_stale",
      "Order financial or stock state changed; refresh the cancellation quote",
      409,
      { currentRevision: facts.revision },
    );
  }
}
