import { createHash } from "node:crypto";
import {
  PaymentCashEventV1Schema,
  SUPPORTED_CURRENCY_REGISTRY_V1,
  type PaymentCashEventV1,
} from "@medusa-snus/contracts";
import type { PaymentChargeBundleEvidenceInputV1 } from "./payment-charge-bundle-service";

export const PAYMENT_METHOD_LIFECYCLE_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: false,
});

type ChargeMethodV1 = PaymentCashEventV1["method"];

interface ConfirmationProofV1 {
  evidenceFingerprint: string;
  sourceSystem: string;
  sourceReference: string;
  confirmedAt: string;
}

export type OrderCreatedChargeConfirmationV1 =
  | (ConfirmationProofV1 & {
      kind: "cash_tender_confirmed";
      amountReceivedMinor: number;
      changeMinor: number;
    })
  | (ConfirmationProofV1 & {
      kind: "manual_bank_verified";
    })
  | (ConfirmationProofV1 & {
      kind: "provider_success";
    });

export interface OrderCreatedChargeLifecycleInputV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  currencyCode: string;
  minorUnitExponent: number;
  chargeAmountMinor: number;
  sourceType: "order_created";
  sourceId: string;
  sourceOccurredAt: string;
  method: ChargeMethodV1;
  confirmation?: OrderCreatedChargeConfirmationV1;
}

export type OrderCreatedChargeLifecycleDecisionV1 =
  | { enabled: false; status: "disabled" }
  | {
      enabled: true;
      status: "blocked";
      method: "cash" | "unknown";
      reason: "cash_tender_confirmation_required" | "unknown_payment_method";
    }
  | {
      enabled: true;
      status: "pending";
      method: "manual_bank" | "provider";
      assurance: "awaiting_manual_verification" | "awaiting_provider_success";
      evidence: null;
    }
  | {
      enabled: true;
      status: "posted";
      method: Exclude<ChargeMethodV1, "unknown">;
      assurance:
        | "recorded_order_created_policy"
        | "cash_tender_confirmed"
        | "manual_bank_verified"
        | "provider_confirmed";
      evidence: PaymentChargeBundleEvidenceInputV1;
    };

export class PaymentMethodLifecyclePolicyErrorV1 extends Error {
  readonly code = "payment_method_lifecycle_policy_invalid";

  constructor(message: string) {
    super(message);
    this.name = "PaymentMethodLifecyclePolicyErrorV1";
  }
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new PaymentMethodLifecyclePolicyErrorV1(`${field} is invalid`);
  }
  return value;
}

function canonicalInstant(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new PaymentMethodLifecyclePolicyErrorV1(`${field} is invalid`);
  }
  try {
    if (new Date(value).toISOString() !== value) {
      throw new PaymentMethodLifecyclePolicyErrorV1(`${field} is invalid`);
    }
  } catch (error) {
    if (error instanceof PaymentMethodLifecyclePolicyErrorV1) throw error;
    throw new PaymentMethodLifecyclePolicyErrorV1(`${field} is invalid`);
  }
  return value;
}

function safeNonnegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PaymentMethodLifecyclePolicyErrorV1(`${field} is invalid`);
  }
  return value as number;
}

function exactKeys(value: object, expected: string[], field: string): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new PaymentMethodLifecyclePolicyErrorV1(`${field} shape is invalid`);
  }
}

function normalizedContext(input: OrderCreatedChargeLifecycleInputV1) {
  const merchantId = requiredToken(input.merchantId, "merchantId");
  const storeId = requiredToken(input.storeId, "storeId");
  const orderId = requiredToken(input.orderId, "orderId");
  const sourceId = requiredToken(input.sourceId, "sourceId");
  const sourceOccurredAt = canonicalInstant(input.sourceOccurredAt, "sourceOccurredAt");
  if (input.sourceType !== "order_created") {
    throw new PaymentMethodLifecyclePolicyErrorV1("sourceType is invalid");
  }
  const currency = SUPPORTED_CURRENCY_REGISTRY_V1.find(
    (item) => item.currencyCode === input.currencyCode,
  );
  if (
    !currency
    || !currency.writeSupported
    || input.minorUnitExponent !== currency.minorUnitExponent
  ) {
    throw new PaymentMethodLifecyclePolicyErrorV1("charge currency is unsupported");
  }
  const chargeAmountMinor = safeNonnegative(input.chargeAmountMinor, "chargeAmountMinor");
  if (chargeAmountMinor === 0) {
    throw new PaymentMethodLifecyclePolicyErrorV1("chargeAmountMinor is invalid");
  }
  if (!["cash", "cod", "manual_bank", "provider", "unknown"].includes(input.method)) {
    throw new PaymentMethodLifecyclePolicyErrorV1("method is invalid");
  }
  return {
    merchantId,
    storeId,
    orderId,
    sourceId,
    sourceOccurredAt,
    currencyCode: currency.currencyCode,
    minorUnitExponent: currency.minorUnitExponent,
    chargeAmountMinor,
    method: input.method,
  };
}

function confirmationEvidence(
  confirmation: OrderCreatedChargeConfirmationV1,
  expectedKind: OrderCreatedChargeConfirmationV1["kind"],
  evidenceType: PaymentChargeBundleEvidenceInputV1["evidenceType"],
  sourceOccurredAt: string,
): PaymentChargeBundleEvidenceInputV1 {
  if (!confirmation || typeof confirmation !== "object" || confirmation.kind !== expectedKind) {
    throw new PaymentMethodLifecyclePolicyErrorV1("confirmation does not match method");
  }
  exactKeys(
    confirmation,
    expectedKind === "cash_tender_confirmed"
      ? [
          "kind",
          "evidenceFingerprint",
          "sourceSystem",
          "sourceReference",
          "confirmedAt",
          "amountReceivedMinor",
          "changeMinor",
        ]
      : ["kind", "evidenceFingerprint", "sourceSystem", "sourceReference", "confirmedAt"],
    "confirmation",
  );
  const evidenceFingerprint = requiredToken(
    confirmation.evidenceFingerprint,
    "evidenceFingerprint",
  );
  if (!/^[a-f0-9]{64}$/.test(evidenceFingerprint)) {
    throw new PaymentMethodLifecyclePolicyErrorV1("evidenceFingerprint is invalid");
  }
  if (canonicalInstant(confirmation.confirmedAt, "confirmedAt") !== sourceOccurredAt) {
    throw new PaymentMethodLifecyclePolicyErrorV1("confirmation time drift");
  }
  return {
    evidenceType,
    evidenceFingerprint,
    sourceSystem: requiredToken(confirmation.sourceSystem, "sourceSystem"),
    sourceReference: requiredToken(confirmation.sourceReference, "sourceReference"),
  };
}

function validateCashTender(
  confirmation: Extract<OrderCreatedChargeConfirmationV1, { kind: "cash_tender_confirmed" }>,
  chargeAmountMinor: number,
): void {
  const amountReceivedMinor = safeNonnegative(
    confirmation.amountReceivedMinor,
    "amountReceivedMinor",
  );
  const changeMinor = safeNonnegative(confirmation.changeMinor, "changeMinor");
  if (
    amountReceivedMinor < chargeAmountMinor
    || amountReceivedMinor - chargeAmountMinor !== changeMinor
  ) {
    throw new PaymentMethodLifecyclePolicyErrorV1("cash tender/change does not reconcile");
  }
}

function validateCashEvent(
  input: ReturnType<typeof normalizedContext>,
  status: "posted" | "pending",
  evidenceType?: PaymentChargeBundleEvidenceInputV1["evidenceType"],
): void {
  const parsed = PaymentCashEventV1Schema.safeParse({
    schemaVersion: 1,
    eventId: input.sourceId,
    idempotencyKey: input.sourceId,
    orderId: input.orderId,
    method: input.method,
    kind: "charge",
    status,
    ...(evidenceType ? { evidenceType } : {}),
    currencyCode: input.currencyCode,
    amountMinor: input.chargeAmountMinor,
    eventAt: input.sourceOccurredAt,
  });
  if (!parsed.success) {
    throw new PaymentMethodLifecyclePolicyErrorV1("charge lifecycle contract is invalid");
  }
}

function codEvidence(input: ReturnType<typeof normalizedContext>): PaymentChargeBundleEvidenceInputV1 {
  const evidenceFingerprint = createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    evidenceType: "cod_order_created",
    merchantId: input.merchantId,
    storeId: input.storeId,
    orderId: input.orderId,
    sourceId: input.sourceId,
    sourceOccurredAt: input.sourceOccurredAt,
    currencyCode: input.currencyCode,
    chargeAmountMinor: input.chargeAmountMinor,
  })).digest("hex");
  return {
    evidenceType: "cod_order_created",
    evidenceFingerprint,
    sourceSystem: "order_service",
    sourceReference: input.sourceId,
  };
}

export function selectOrderCreatedChargeLifecycleV1(
  input: OrderCreatedChargeLifecycleInputV1,
  config: { enabled: boolean } = PAYMENT_METHOD_LIFECYCLE_DEFAULT_CONFIG_V1,
): OrderCreatedChargeLifecycleDecisionV1 {
  if (config.enabled !== true) return { enabled: false, status: "disabled" };
  const context = normalizedContext(input);

  if (context.method === "unknown") {
    if (input.confirmation !== undefined) {
      throw new PaymentMethodLifecyclePolicyErrorV1("unknown method cannot claim confirmation");
    }
    return {
      enabled: true,
      status: "blocked",
      method: "unknown",
      reason: "unknown_payment_method",
    };
  }

  if (context.method === "cod") {
    if (input.confirmation !== undefined) {
      throw new PaymentMethodLifecyclePolicyErrorV1(
        "COD order-created evidence is system-derived",
      );
    }
    const evidence = codEvidence(context);
    validateCashEvent(context, "posted", evidence.evidenceType);
    return {
      enabled: true,
      status: "posted",
      method: "cod",
      assurance: "recorded_order_created_policy",
      evidence,
    };
  }

  if (context.method === "cash") {
    if (input.confirmation === undefined) {
      return {
        enabled: true,
        status: "blocked",
        method: "cash",
        reason: "cash_tender_confirmation_required",
      };
    }
    if (input.confirmation.kind !== "cash_tender_confirmed") {
      throw new PaymentMethodLifecyclePolicyErrorV1("confirmation does not match method");
    }
    validateCashTender(input.confirmation, context.chargeAmountMinor);
    const evidence = confirmationEvidence(
      input.confirmation,
      "cash_tender_confirmed",
      "cash_receipt",
      context.sourceOccurredAt,
    );
    validateCashEvent(context, "posted", evidence.evidenceType);
    return {
      enabled: true,
      status: "posted",
      method: "cash",
      assurance: "cash_tender_confirmed",
      evidence,
    };
  }

  const expected = context.method === "manual_bank"
    ? {
        kind: "manual_bank_verified" as const,
        evidenceType: "manual_verified" as const,
        pendingAssurance: "awaiting_manual_verification" as const,
        postedAssurance: "manual_bank_verified" as const,
      }
    : {
        kind: "provider_success" as const,
        evidenceType: "provider_webhook_success" as const,
        pendingAssurance: "awaiting_provider_success" as const,
        postedAssurance: "provider_confirmed" as const,
      };
  if (input.confirmation === undefined) {
    validateCashEvent(context, "pending");
    return {
      enabled: true,
      status: "pending",
      method: context.method,
      assurance: expected.pendingAssurance,
      evidence: null,
    };
  }
  const evidence = confirmationEvidence(
    input.confirmation,
    expected.kind,
    expected.evidenceType,
    context.sourceOccurredAt,
  );
  validateCashEvent(context, "posted", evidence.evidenceType);
  return {
    enabled: true,
    status: "posted",
    method: context.method,
    assurance: expected.postedAssurance,
    evidence,
  };
}
