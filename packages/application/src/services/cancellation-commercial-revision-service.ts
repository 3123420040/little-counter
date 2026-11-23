import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { resolvePaymentFee } from "./payment-fee-calculation";

export interface CancellationCommercialRevisionInputV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  sourceId: string;
  sourceOccurredAt: string;
  reason: string;
}

export interface CancellationCommercialRevisionResultV1 {
  outcome: "inserted" | "replayed";
  revisionId: string;
  revision: number;
  totalMinor: number;
}

function uuid(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw new PlatformError("financial_invariant_error", `${field} is invalid`, 409);
  }
  return value;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlatformError("financial_invariant_error", `${field} is invalid`, 409);
  }
  return parsed;
}

export async function appendCancellationCommercialRevisionV1(
  client: PoolClient,
  input: CancellationCommercialRevisionInputV1,
): Promise<CancellationCommercialRevisionResultV1> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`commercial-revision:${input.merchantId}:${input.storeId}:${input.orderId}`],
  );
  const existing = await client.query<Record<string, unknown>>(`
    SELECT revisions.id::text AS id, revisions.revision, components.total_minor
    FROM app.order_commercial_revisions revisions
    JOIN app.order_commercial_revision_components components
      ON components.revision_id = revisions.id
    WHERE revisions.merchant_id = $1 AND revisions.store_id = $2
      AND revisions.order_id = $3 AND revisions.source_type = 'order_cancellation'
      AND revisions.source_id = $4
  `, [input.merchantId, input.storeId, input.orderId, input.sourceId]);
  if (existing.rows.length > 1) {
    throw new PlatformError("financial_invariant_error", "Cancellation revision identity is ambiguous", 409);
  }
  if (existing.rows.length === 1) {
    return {
      outcome: "replayed",
      revisionId: uuid(existing.rows[0]!.id, "cancellation revision id"),
      revision: nonnegativeInteger(existing.rows[0]!.revision, "cancellation revision"),
      totalMinor: nonnegativeInteger(existing.rows[0]!.total_minor, "cancellation total"),
    };
  }

  const latest = await client.query<Record<string, unknown>>(`
    SELECT revisions.*, components.*
    FROM app.order_commercial_revisions revisions
    JOIN app.order_commercial_revision_components components
      ON components.revision_id = revisions.id
    WHERE revisions.merchant_id = $1 AND revisions.store_id = $2
      AND revisions.order_id = $3
    ORDER BY revisions.revision DESC, revisions.effective_at DESC, revisions.id DESC
    LIMIT 1
    FOR UPDATE OF revisions
  `, [input.merchantId, input.storeId, input.orderId]);
  if (latest.rows.length !== 1) {
    throw new PlatformError("financial_invariant_error", "Active commercial revision is unavailable", 409);
  }
  const previous = latest.rows[0]!;
  if (previous.commercial_state !== "active") {
    throw new PlatformError("invalid_state_transition", "Order commercial state is already cancelled", 409);
  }
  const revision = nonnegativeInteger(previous.revision, "commercial revision") + 1;
  const componentVersion = nonnegativeInteger(previous.component_version ?? 1, "component version");
  if (componentVersion !== 1 && componentVersion !== 2) {
    throw new PlatformError("financial_invariant_error", "Cancellation component version is unsupported", 409);
  }
  let feeMetadata: Record<string, unknown> = {};
  if (componentVersion === 2) {
    try {
      const metadata = previous.metadata as Record<string, unknown>;
      const descriptor = metadata.paymentFee as Record<string, unknown>;
      const fee = resolvePaymentFee(nonnegativeInteger(previous.merchandise_net_minor, "merchandise basis"), {
        paymentFeeType: descriptor.paymentFeeType as "percent" | "amount", paymentFeeValue: descriptor.paymentFeeValue as number,
      }, { taxMode: previous.tax_mode as "inclusive" | "exclusive", vatRatePpm: metadata.vatRatePpm as number });
      if (metadata.bundleVersion !== 2 || metadata.commercialCalculationVersion !== 2
        || descriptor.paymentFeeBasisMinor !== fee.paymentFeeBasisMinor
        || nonnegativeInteger(previous.payment_fee_minor, "payment fee") !== fee.paymentFeeMinor
        || nonnegativeInteger(previous.payment_fee_vat_minor, "payment fee VAT") !== fee.paymentFeeVatMinor) {
        throw new Error("fee snapshot drift");
      }
      feeMetadata = { bundleVersion: 2, commercialCalculationVersion: 2, vatRatePpm: metadata.vatRatePpm,
        componentContract: "order-commercial-components.v2-payment-fee",
        paymentFee: { paymentFeeType: fee.paymentFeeType, paymentFeeValue: fee.paymentFeeValue, paymentFeeBasisMinor: fee.paymentFeeBasisMinor } };
    } catch {
      throw new PlatformError("financial_invariant_error", "Cancellation fee snapshot is invalid", 409);
    }
  }
  const inserted = await client.query<{ id: unknown }>(`
    INSERT INTO app.order_commercial_revisions (
      merchant_id, store_id, order_id, revision, source_type, source_id,
      commercial_state, currency_code, minor_unit_exponent, effective_at,
      idempotency_key, data_quality, metadata
    ) VALUES (
      $1, $2, $3, $4, 'order_cancellation', $5, 'cancelled',
      $6, $7, $8::timestamptz, $9, $10,
      jsonb_build_object('reason', $11::text, 'previousRevisionId', $12::text) || $13::jsonb
    ) RETURNING id::text AS id
  `, [
    input.merchantId,
    input.storeId,
    input.orderId,
    revision,
    input.sourceId,
    previous.currency_code,
    previous.minor_unit_exponent,
    input.sourceOccurredAt,
    `order-cancellation:${input.sourceId}`,
    previous.data_quality,
    input.reason,
    String(previous.revision_id || previous.id),
    JSON.stringify(feeMetadata),
  ]);
  if (inserted.rows.length !== 1) {
    throw new PlatformError("financial_invariant_error", "Cancellation revision insert coverage drift", 409);
  }
  const revisionId = uuid(inserted.rows[0]!.id, "cancellation revision id");
  const componentInsert = await client.query(`
    INSERT INTO app.order_commercial_revision_components (
      revision_id, merchant_id, store_id, order_id, revision,
      currency_code, minor_unit_exponent, tax_mode,
      merchandise_gross_minor, discount_minor, merchandise_net_minor,
      shipping_minor, merchandise_vat_minor, shipping_vat_minor, vat_minor,
      unclassified_minor, total_minor
      ${componentVersion === 2 ? ", component_version, payment_fee_minor, payment_fee_vat_minor" : ""}
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, $16, $17
      ${componentVersion === 2 ? ", 2, $18, $19" : ""}
    )
  `, [
    revisionId,
    input.merchantId,
    input.storeId,
    input.orderId,
    revision,
    previous.currency_code,
    previous.minor_unit_exponent,
    previous.tax_mode,
    previous.merchandise_gross_minor,
    previous.discount_minor,
    previous.merchandise_net_minor,
    previous.shipping_minor,
    previous.merchandise_vat_minor,
    previous.shipping_vat_minor,
    previous.vat_minor,
    previous.unclassified_minor,
    previous.total_minor,
    ...(componentVersion === 2 ? [previous.payment_fee_minor, previous.payment_fee_vat_minor] : []),
  ]);
  if (componentInsert.rowCount !== 1) {
    throw new PlatformError("financial_invariant_error", "Cancellation component coverage drift", 409);
  }
  const copiedLines = await client.query(`
    INSERT INTO app.order_commercial_revision_lines (
      revision_id, merchant_id, store_id, order_id, revision, line_key,
      source_line_id, product_id, variant_id, sku_snapshot, title_snapshot,
      archived_variant, quantity, unit_price_minor, line_total_minor,
      cost_minor, cost_evidence_id
    )
    SELECT $1, merchant_id, store_id, order_id, $2, line_key,
      source_line_id, product_id, variant_id, sku_snapshot, title_snapshot,
      archived_variant, quantity, unit_price_minor, line_total_minor,
      cost_minor, cost_evidence_id
    FROM app.order_commercial_revision_lines
    WHERE revision_id = $3
  `, [revisionId, revision, uuid(previous.revision_id || previous.id, "previous revision id")]);
  if (!copiedLines.rowCount || copiedLines.rowCount < 1) {
    throw new PlatformError("financial_invariant_error", "Cancellation line coverage drift", 409);
  }
  return {
    outcome: "inserted",
    revisionId,
    revision,
    totalMinor: nonnegativeInteger(previous.total_minor, "cancellation total"),
  };
}
