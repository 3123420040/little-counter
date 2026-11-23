import { createHash } from "node:crypto";
import type { OperatingScope } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import type { OperatorContext } from "./auth-service";
import type { ManualBankConfirmationBodyV1 } from "./manual-bank-confirmation-service";
import {
  PostgresManualBankCorrectionConfirmationRepositoryV1,
  type ManualBankCorrectionConfirmationBundleV1,
  type ManualBankCorrectionConfirmationBundleV2,
} from "./postgres-manual-bank-correction-confirmation-repository";

type PendingCorrectionRow = Record<string, unknown>;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function token(
  value: unknown,
  field: string,
  minimum = 1,
  maximum = 255,
): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    hasControlCharacter(value)
  )
    throw new PlatformError(
      "manual_bank_confirmation_invalid",
      `${field} is invalid`,
      422,
    );
  return value;
}

function canonicalInstant(value: unknown): string {
  const candidate = token(value, "confirmedAt", 24, 24);
  const parsed = new Date(candidate);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== candidate ||
    parsed.getTime() > Date.now() + 5 * 60_000
  )
    throw new PlatformError(
      "manual_bank_confirmation_invalid",
      "confirmedAt is invalid",
      422,
    );
  return candidate;
}

function integer(value: unknown, field: string, signed = false): number {
  const parsed = Number(String(value));
  if (!Number.isSafeInteger(parsed) || (!signed && parsed < 0)) {
    throw new PlatformError(
      "manual_bank_confirmation_state_invalid",
      `${field} is invalid`,
      409,
    );
  }
  return parsed;
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function body(value: ManualBankConfirmationBodyV1) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformError(
      "manual_bank_confirmation_invalid",
      "Request body is invalid",
      422,
    );
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify(["confirmedAt", "sourceReference"])
  ) {
    throw new PlatformError(
      "manual_bank_confirmation_invalid",
      "Only sourceReference and confirmedAt are accepted",
      422,
    );
  }
  return {
    sourceReference: token(value.sourceReference, "sourceReference", 3, 128),
    confirmedAt: canonicalInstant(value.confirmedAt),
  };
}

async function authoritative(
  client: PoolClient,
  scope: OperatingScope,
  orderId: string,
): Promise<PendingCorrectionRow> {
  const result = await client.query<PendingCorrectionRow>(
    `
    /* manual_bank_correction_confirmation_authoritative */
    SELECT pending.id::text AS pending_event_id,
           pending.source_id AS correction_id,
           pending.commercial_revision_id::text AS commercial_revision_id,
           pending.source_occurred_at,
           obligations.id::text AS obligation_id,
           pending.currency_code,
           pending.minor_unit_exponent,
           pending.amount_minor,
           deltas.base_commercial_revision_id::text AS base_commercial_revision_id,
           deltas.tax_mode,
           COALESCE((to_jsonb(deltas)->>'component_version')::int,1) AS component_version,
           COALESCE((to_jsonb(deltas)->>'payment_fee_delta_minor')::text,'0') AS payment_fee_delta_minor,
           COALESCE((to_jsonb(deltas)->>'payment_fee_vat_delta_minor')::text,'0') AS payment_fee_vat_delta_minor,
           deltas.merchandise_gross_delta_minor,
           deltas.discount_delta_minor,
           deltas.merchandise_net_delta_minor,
           deltas.shipping_delta_minor,
           deltas.merchandise_vat_delta_minor,
           deltas.shipping_vat_delta_minor,
           deltas.vat_delta_minor,
           deltas.unclassified_delta_minor,
           deltas.total_delta_minor,
           deltas.base_snapshot_fingerprint,
           deltas.effective_snapshot_fingerprint,
           deltas.contract_fingerprint
    FROM app.payment_events pending
    JOIN app.commercial_obligations obligations
      ON obligations.merchant_id = pending.merchant_id
     AND obligations.store_id = pending.store_id
     AND obligations.order_id = pending.order_id
     AND obligations.commercial_revision_id = pending.commercial_revision_id
     AND obligations.source_type = pending.source_type
     AND obligations.source_id = pending.source_id
     AND obligations.obligation_kind = 'order_correction_charge'
    JOIN app.payment_correction_component_deltas deltas
      ON deltas.payment_event_id = pending.id
    WHERE pending.merchant_id = $1
      AND pending.store_id = $2
      AND pending.order_id = $3
      AND pending.kind = 'charge'
      AND pending.status = 'pending'
      AND pending.method = 'manual_bank'
      AND pending.source_type = 'order_correction'
    ORDER BY pending.source_occurred_at, pending.id
  `,
    [scope.merchantId, scope.storeId, orderId],
  );
  if (result.rows.length !== 1) {
    throw new PlatformError(
      "manual_bank_confirmation_unavailable",
      "Exactly one uncollected correction manual-bank obligation is required",
      409,
      { pendingCount: result.rows.length },
    );
  }
  return result.rows[0]!;
}

export async function confirmCorrectionManualBankPaymentWithClientV1(
  client: PoolClient,
  headers: HeadersLike,
  orderIdValue: string,
  bodyValue: ManualBankConfirmationBodyV1,
  actor: OperatorContext,
  scope: OperatingScope,
) {
  const orderId = token(orderIdValue, "orderId");
  const input = body(bodyValue);
  const operatorId = token(actor.operatorId, "operatorId");
  const clientIntentKey = token(
    headerValue(headers, "idempotency-key"),
    "Idempotency-Key",
    8,
    200,
  );
  const row = await authoritative(client, scope, orderId);
  const version = integer(row.component_version ?? 1, "componentVersion");
  const paymentFeeMinor = integer(
    row.payment_fee_delta_minor ?? 0,
    "paymentFeeMinor",
    true,
  );
  const paymentFeeVatMinor = integer(
    row.payment_fee_vat_delta_minor ?? 0,
    "paymentFeeVatMinor",
    true,
  );
  if (
    (version !== 1 && version !== 2) ||
    (version === 1 && (paymentFeeMinor !== 0 || paymentFeeVatMinor !== 0))
  ) {
    throw new PlatformError(
      "manual_bank_confirmation_state_invalid",
      "Correction fee component version is invalid",
      409,
    );
  }
  const pendingOccurredAt = new Date(
    String(row.source_occurred_at),
  ).toISOString();
  if (Date.parse(input.confirmedAt) < Date.parse(pendingOccurredAt)) {
    throw new PlatformError(
      "manual_bank_confirmation_conflict",
      "Confirmation predates the correction",
      409,
    );
  }
  const clientIntentFingerprint = sha256({
    schemaVersion: version,
    merchantId: scope.merchantId,
    storeId: scope.storeId,
    orderId,
    operatorId,
    clientIntentKey,
    sourceReference: input.sourceReference,
    confirmedAt: input.confirmedAt,
  });
  const confirmationIdentity = sha256({
    schemaVersion: version,
    merchantId: scope.merchantId,
    storeId: scope.storeId,
    orderId,
    correctionId: row.correction_id,
    sourceSystem: "manual_bank_operator_attestation",
    sourceReference: input.sourceReference,
    evidenceFingerprint: clientIntentFingerprint,
  });
  const delta = {
    taxMode: token(row.tax_mode, "taxMode") as "inclusive" | "exclusive",
    merchandiseGrossMinor: integer(
      row.merchandise_gross_delta_minor,
      "merchandiseGrossMinor",
      true,
    ),
    discountMinor: integer(row.discount_delta_minor, "discountMinor", true),
    merchandiseNetMinor: integer(
      row.merchandise_net_delta_minor,
      "merchandiseNetMinor",
      true,
    ),
    shippingMinor: integer(row.shipping_delta_minor, "shippingMinor", true),
    merchandiseVatMinor: integer(
      row.merchandise_vat_delta_minor,
      "merchandiseVatMinor",
      true,
    ),
    shippingVatMinor: integer(
      row.shipping_vat_delta_minor,
      "shippingVatMinor",
      true,
    ),
    vatMinor: integer(row.vat_delta_minor, "vatMinor", true),
    unclassifiedMinor: integer(
      row.unclassified_delta_minor,
      "unclassifiedMinor",
      true,
    ),
    totalMinor: integer(row.total_delta_minor, "totalMinor", true),
    baseSnapshotFingerprint: token(
      row.base_snapshot_fingerprint,
      "baseSnapshotFingerprint",
      64,
      64,
    ),
    effectiveSnapshotFingerprint: token(
      row.effective_snapshot_fingerprint,
      "effectiveSnapshotFingerprint",
      64,
      64,
    ),
    contractFingerprint: token(
      row.contract_fingerprint,
      "contractFingerprint",
      64,
      64,
    ),
  };
  if (delta.taxMode !== "inclusive" && delta.taxMode !== "exclusive") {
    throw new PlatformError(
      "manual_bank_confirmation_state_invalid",
      "taxMode is invalid",
      409,
    );
  }
  const amountMinor = integer(row.amount_minor, "amountMinor");
  if (amountMinor <= 0 || amountMinor !== delta.totalMinor) {
    throw new PlatformError(
      "manual_bank_confirmation_state_invalid",
      "Correction amount is invalid",
      409,
    );
  }
  const base: Omit<
    ManualBankCorrectionConfirmationBundleV1,
    "bundleFingerprint"
  > = {
    merchantId: scope.merchantId,
    storeId: scope.storeId,
    orderId,
    correctionId: token(row.correction_id, "correctionId"),
    commercialRevisionId: token(
      row.commercial_revision_id,
      "commercialRevisionId",
    ),
    baseCommercialRevisionId: token(
      row.base_commercial_revision_id,
      "baseCommercialRevisionId",
    ),
    priorPendingPaymentEventId: token(
      row.pending_event_id,
      "pendingPaymentEventId",
    ),
    obligationId: token(row.obligation_id, "obligationId"),
    currencyCode: token(row.currency_code, "currencyCode", 3, 3),
    minorUnitExponent: integer(row.minor_unit_exponent, "minorUnitExponent"),
    amountMinor,
    eventIdempotencyKey: `payment_correction_confirmation:v${version}:${confirmationIdentity}`,
    eventSourceId: confirmationIdentity,
    evidenceFingerprint: clientIntentFingerprint,
    sourceSystem: "manual_bank_operator_attestation",
    sourceReference: input.sourceReference,
    confirmedAt: input.confirmedAt,
    clientIntentFingerprint,
    delta,
  };
  const versionedBase =
    version === 2
      ? {
          ...base,
          schemaVersion: 2 as const,
          delta: { ...delta, paymentFeeMinor, paymentFeeVatMinor },
        }
      : base;
  const bundle:
    | ManualBankCorrectionConfirmationBundleV1
    | ManualBankCorrectionConfirmationBundleV2 = {
    ...versionedBase,
    bundleFingerprint: sha256(versionedBase),
  };
  const result = await new PostgresManualBankCorrectionConfirmationRepositoryV1(
    client,
  ).append(bundle, actor);
  return {
    statusCode: result.outcome === "inserted" ? 201 : 200,
    response: {
      data: {
        orderId,
        correctionId: bundle.correctionId,
        status: "posted" as const,
        method: "manual_bank" as const,
        outcome: result.outcome,
        paymentEventId: result.paymentEventId,
        priorPendingPaymentEventId: result.priorPendingPaymentEventId,
        amountMinor,
        currencyCode: bundle.currencyCode,
        minorUnitExponent: bundle.minorUnitExponent,
        sourceReference: input.sourceReference,
        confirmedAt: input.confirmedAt,
      },
    },
  };
}
