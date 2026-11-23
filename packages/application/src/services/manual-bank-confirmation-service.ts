import { createHash } from "node:crypto";
import { OrderCommercialComponentsV2Schema, type OperatingScope } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { withConnectedClient } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import type { OperatorContext } from "./auth-service";
import {
  PaymentLaterConfirmationContractErrorV1,
  createPaymentLaterConfirmationTaskV1,
  createPaymentLaterConfirmationTaskV2,
  type PaymentLaterConfirmationInputV1,
} from "./payment-later-confirmation-contract";
import { PostgresPaymentLaterConfirmationRepositoryV1 } from "./postgres-payment-later-confirmation-repository";
import { confirmCorrectionManualBankPaymentWithClientV1 } from "./manual-bank-correction-confirmation-service";

export interface ManualBankConfirmationBodyV1 {
  sourceReference: string;
  confirmedAt: string;
}

export interface ManualBankConfirmationConfigV1 {
  enabled: boolean;
}

type PendingManualBankRow = {
  component_version?: string | number;
  payment_fee_minor?: string | number | bigint;
  payment_fee_vat_minor?: string | number | bigint;
  pending_event_id: string;
  pending_idempotency_key: string;
  pending_source_id: string;
  pending_source_occurred_at: Date | string;
  obligation_id: string;
  obligation_idempotency_key: string;
  obligation_amount_minor: string | number | bigint;
  commercial_revision_id: string;
  commercial_revision: string | number;
  currency_code: string;
  minor_unit_exponent: string | number;
  tax_mode: "inclusive" | "exclusive";
  merchandise_gross_minor: string | number | bigint;
  discount_minor: string | number | bigint;
  merchandise_net_minor: string | number | bigint;
  shipping_minor: string | number | bigint;
  merchandise_vat_minor: string | number | bigint;
  shipping_vat_minor: string | number | bigint;
  vat_minor: string | number | bigint;
  unclassified_minor: string | number | bigint;
  total_minor: string | number | bigint;
};

export const MANUAL_BANK_CONFIRMATION_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: false,
});

export function readManualBankConfirmationRuntimeConfigV1(): ManualBankConfirmationConfigV1 {
  return { enabled: process.env.MANUAL_BANK_CONFIRMATION_ENABLED === "true" };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function token(value: unknown, field: string, minimum = 1, maximum = 255): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length < minimum
    || value.length > maximum
    || hasControlCharacter(value)
  ) {
    throw new PlatformError("manual_bank_confirmation_invalid", `${field} is invalid`, 422);
  }
  return value;
}

function canonicalInstant(value: unknown): string {
  const text = token(value, "confirmedAt", 24, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) {
    throw new PlatformError("manual_bank_confirmation_invalid", "confirmedAt must be a canonical UTC instant", 422);
  }
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new PlatformError("manual_bank_confirmation_invalid", "confirmedAt is invalid", 422);
  }
  if (parsed.getTime() > Date.now() + 5 * 60_000) {
    throw new PlatformError("manual_bank_confirmation_invalid", "confirmedAt cannot be in the future", 422);
  }
  return text;
}

function safeMinor(value: unknown, field: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlatformError("manual_bank_confirmation_state_invalid", `${field} is invalid`, 409);
  }
  return parsed;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactBody(body: ManualBankConfirmationBodyV1): ManualBankConfirmationBodyV1 {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PlatformError("manual_bank_confirmation_invalid", "Request body is invalid", 422);
  }
  const keys = Object.keys(body).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["confirmedAt", "sourceReference"])) {
    throw new PlatformError(
      "manual_bank_confirmation_invalid",
      "Only sourceReference and confirmedAt are accepted",
      422,
    );
  }
  return {
    sourceReference: token(body.sourceReference, "sourceReference", 3, 128),
    confirmedAt: canonicalInstant(body.confirmedAt),
  };
}

async function authoritativePendingManualBank(
  client: PoolClient,
  orderId: string,
  scope: OperatingScope,
): Promise<PendingManualBankRow> {
  const result = await client.query<PendingManualBankRow>(`
    /* manual_bank_confirmation_authoritative_initial */
    SELECT pending.id::text AS pending_event_id,
           pending.idempotency_key AS pending_idempotency_key,
           pending.source_id AS pending_source_id,
           pending.source_occurred_at AS pending_source_occurred_at,
           obligations.id::text AS obligation_id,
           obligations.idempotency_key AS obligation_idempotency_key,
           obligations.amount_minor AS obligation_amount_minor,
           revisions.id::text AS commercial_revision_id,
           revisions.revision AS commercial_revision,
           pending.currency_code,
           pending.minor_unit_exponent,
           components.tax_mode,
           components.merchandise_gross_minor,
           components.discount_minor,
           components.merchandise_net_minor,
           components.shipping_minor,
           components.merchandise_vat_minor,
           components.shipping_vat_minor,
           components.vat_minor,
           components.unclassified_minor,
           components.total_minor,
           COALESCE((to_jsonb(components)->>'component_version')::int, 1) AS component_version,
           to_jsonb(components)->>'payment_fee_minor' AS payment_fee_minor,
           to_jsonb(components)->>'payment_fee_vat_minor' AS payment_fee_vat_minor
    FROM app.payment_events pending
    JOIN app.commercial_obligations obligations
      ON obligations.merchant_id = pending.merchant_id
     AND obligations.store_id = pending.store_id
     AND obligations.order_id = pending.order_id
     AND obligations.commercial_revision_id = pending.commercial_revision_id
     AND obligations.source_type = pending.source_type
     AND obligations.source_id = pending.source_id
     AND obligations.obligation_kind = 'order_charge'
    JOIN app.order_commercial_revisions revisions
      ON revisions.id = pending.commercial_revision_id
     AND revisions.merchant_id = pending.merchant_id
     AND revisions.store_id = pending.store_id
     AND revisions.order_id = pending.order_id
    JOIN app.payment_event_component_allocations components
      ON components.payment_event_id = pending.id
     AND components.merchant_id = pending.merchant_id
     AND components.store_id = pending.store_id
    WHERE pending.merchant_id = $1
      AND pending.store_id = $2
      AND pending.order_id = $3
      AND pending.kind = 'charge'
      AND pending.status = 'pending'
      AND pending.method = 'manual_bank'
      AND pending.source_type = 'order_created'
    ORDER BY pending.recorded_at, pending.id
  `, [scope.merchantId, scope.storeId, orderId]);
  if (result.rows.length !== 1) {
    throw new PlatformError(
      "manual_bank_confirmation_unavailable",
      "Exactly one initial pending manual-bank obligation is required",
      409,
      { pendingCount: result.rows.length },
    );
  }
  return result.rows[0]!;
}

export async function confirmInitialManualBankPaymentWithClientV1(
  client: PoolClient,
  headers: HeadersLike,
  orderIdValue: string,
  bodyValue: ManualBankConfirmationBodyV1,
  actor: OperatorContext,
  scope: OperatingScope,
  config: ManualBankConfirmationConfigV1 = MANUAL_BANK_CONFIRMATION_DEFAULT_CONFIG_V1,
) {
  if (config.enabled !== true) {
    throw new PlatformError("manual_bank_confirmation_disabled", "Manual-bank confirmation is disabled", 404);
  }
  const orderId = token(orderIdValue, "orderId", 1, 255);
  const body = exactBody(bodyValue);
  const operatorId = token(actor?.operatorId, "operatorId", 1, 255);
  const clientIntentKey = token(headerValue(headers, "idempotency-key"), "Idempotency-Key", 8, 200);
  const row = await authoritativePendingManualBank(client, orderId, scope);
  const priorOccurredAt = row.pending_source_occurred_at instanceof Date
    ? row.pending_source_occurred_at.toISOString()
    : new Date(row.pending_source_occurred_at).toISOString();
  const componentVersion = safeMinor(row.component_version ?? 1, "componentVersion");
  const paymentFeeMinor = safeMinor(componentVersion === 2 ? row.payment_fee_minor : row.payment_fee_minor ?? 0, "paymentFeeMinor");
  const paymentFeeVatMinor = safeMinor(componentVersion === 2 ? row.payment_fee_vat_minor : row.payment_fee_vat_minor ?? 0, "paymentFeeVatMinor");
  if ((componentVersion !== 1 && componentVersion !== 2) || (componentVersion === 1 && (paymentFeeMinor !== 0 || paymentFeeVatMinor !== 0))) {
    throw new PlatformError("manual_bank_confirmation_state_invalid", "Persisted payment fee component version is inconsistent", 409);
  }
  const components = {
    taxMode: row.tax_mode,
    merchandiseGrossMinor: safeMinor(row.merchandise_gross_minor, "merchandiseGrossMinor"),
    discountMinor: safeMinor(row.discount_minor, "discountMinor"),
    merchandiseNetMinor: safeMinor(row.merchandise_net_minor, "merchandiseNetMinor"),
    shippingMinor: safeMinor(row.shipping_minor, "shippingMinor"),
    merchandiseVatMinor: safeMinor(row.merchandise_vat_minor, "merchandiseVatMinor"),
    shippingVatMinor: safeMinor(row.shipping_vat_minor, "shippingVatMinor"),
    vatMinor: safeMinor(row.vat_minor, "vatMinor"),
    unclassifiedMinor: safeMinor(row.unclassified_minor, "unclassifiedMinor"),
    totalMinor: safeMinor(row.total_minor, "totalMinor"),
    ...(componentVersion === 2 ? { paymentFeeMinor, paymentFeeVatMinor } : {}),
  };
  const clientIntentFingerprint = sha256({
    schemaVersion: 1,
    merchantId: scope.merchantId,
    storeId: scope.storeId,
    orderId,
    operatorId,
    clientIntentKey,
    sourceReference: body.sourceReference,
    confirmedAt: body.confirmedAt,
  });
  const input: PaymentLaterConfirmationInputV1 = {
    merchantId: scope.merchantId,
    storeId: scope.storeId,
    orderId,
    commercialRevisionId: row.commercial_revision_id,
    commercialRevision: safeMinor(row.commercial_revision, "commercialRevision"),
    currencyCode: row.currency_code,
    minorUnitExponent: safeMinor(row.minor_unit_exponent, "minorUnitExponent"),
    components,
    obligation: {
      obligationId: row.obligation_id,
      obligationIdempotencyKey: row.obligation_idempotency_key,
      amountMinor: safeMinor(row.obligation_amount_minor, "obligationAmountMinor"),
      collectedMinor: 0,
    },
    pendingAttempt: {
      paymentEventId: row.pending_event_id,
      idempotencyKey: row.pending_idempotency_key,
      method: "manual_bank",
      status: "pending",
      amountMinor: components.totalMinor,
      sourceType: "order_created",
      sourceId: row.pending_source_id,
      sourceOccurredAt: priorOccurredAt,
      evidenceType: null,
      evidenceFingerprint: null,
    },
    confirmation: {
      kind: "manual_bank_verified",
      evidenceFingerprint: clientIntentFingerprint,
      sourceSystem: "manual_bank_operator_attestation",
      sourceReference: body.sourceReference,
      confirmedAt: body.confirmedAt,
    },
  };
  try {
    const task = componentVersion === 2
      ? createPaymentLaterConfirmationTaskV2({ ...input, components: OrderCommercialComponentsV2Schema.parse(components) }, { enabled: true })
      : createPaymentLaterConfirmationTaskV1(input, { enabled: true });
    if (!task.enabled) throw new Error("manual-bank confirmation task is unavailable");
    const result = await new PostgresPaymentLaterConfirmationRepositoryV1(client, {
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 1_000,
    }).appendLaterConfirmation(task.bundle, {
      actor,
      clientIntentFingerprint,
    });
    return {
      statusCode: result.outcome === "inserted" ? 201 : 200,
      response: {
        data: {
          orderId,
          status: "posted" as const,
          method: "manual_bank" as const,
          outcome: result.outcome,
          paymentEventId: result.paymentEventId,
          priorPendingPaymentEventId: result.priorPendingPaymentEventId,
          amountMinor: components.totalMinor,
          currencyCode: row.currency_code,
          minorUnitExponent: safeMinor(row.minor_unit_exponent, "minorUnitExponent"),
          sourceReference: body.sourceReference,
          confirmedAt: body.confirmedAt,
        },
      },
    };
  } catch (error) {
    if (error instanceof PaymentLaterConfirmationContractErrorV1) {
      throw new PlatformError("manual_bank_confirmation_conflict", error.message, 409);
    }
    throw error;
  }
}

export async function confirmInitialManualBankPaymentV1(
  headers: HeadersLike,
  orderId: string,
  body: ManualBankConfirmationBodyV1,
  actor: OperatorContext,
  scope: OperatingScope,
  config: ManualBankConfirmationConfigV1 = readManualBankConfirmationRuntimeConfigV1(),
) {
  return withConnectedClient(async (client) => {
    try {
      return await confirmInitialManualBankPaymentWithClientV1(
        client,
        headers,
        orderId,
        body,
        actor,
        scope,
        config,
      );
    } catch (error) {
      if (
        error instanceof PlatformError
        && (
          (error.code === "manual_bank_confirmation_unavailable"
            && error.details?.pendingCount === 0)
          || error.code === "manual_bank_confirmation_conflict"
        )
        && config.enabled === true
      ) {
        try {
          return await confirmCorrectionManualBankPaymentWithClientV1(
            client,
            headers,
            orderId,
            body,
            actor,
            scope,
          );
        } catch (correctionError) {
          if (
            correctionError instanceof PlatformError
            && correctionError.code === "manual_bank_confirmation_unavailable"
          ) throw error;
          throw correctionError;
        }
      }
      throw error;
    }
  });
}
