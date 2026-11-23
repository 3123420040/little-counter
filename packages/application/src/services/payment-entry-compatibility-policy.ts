import type { PaymentEntryStatus } from "../repositories/payment-repository";
import type { OrderCreatedPaymentChargeCallerResultV1 } from "./order-created-payment-charge-caller";
import type { ProviderInitialPostedChargeCallerResultV1 } from "./provider-initial-posted-charge-caller";

export const PAYMENT_ENTRY_COMPATIBILITY_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: true,
});

export type CanonicalChargeResultV1 =
  | OrderCreatedPaymentChargeCallerResultV1
  | ProviderInitialPostedChargeCallerResultV1;

const INITIAL_POSTED_PROVIDER_METHODS_V1 = new Set([
  "mock",
  "sepay_va",
  "nowpayments",
]);

export interface PaymentEntryCompatibilityInputV1 {
  boundary: "order_created";
  paymentMethod: string;
  legacyStatus: PaymentEntryStatus;
  legacyAmountMinor: number;
  canonicalCharge?: CanonicalChargeResultV1;
}

export type PaymentEntryCompatibilityDecisionV1 = {
  enabled: false;
  writeMode: "legacy_only";
  legacyStatus: PaymentEntryStatus;
  aggregateReadSource: "app.payment_entries";
  legacyMetadata: Record<string, never>;
} | {
  enabled: true;
  writeMode: "canonical_plus_legacy_mirror";
  legacyStatus: "pending" | "posted";
  aggregateReadSource: "app.payment_events";
  legacyMetadata: {
    canonicalPaymentEventId: string;
    canonicalPaymentObligationId: string;
    canonicalPaymentWriteOutcome: "inserted" | "replayed";
    compatibilityVersion: 1;
    financialAggregateSource: "app.payment_events";
    providerChargeOwner?: "provider_initial_posted_charge_caller";
  };
};

export class PaymentEntryCompatibilityPolicyErrorV1 extends Error {
  readonly code = "payment_entry_compatibility_invalid";

  constructor(message: string) {
    super(message);
    this.name = "PaymentEntryCompatibilityPolicyErrorV1";
  }
}

function invalid(message: string): never {
  throw new PaymentEntryCompatibilityPolicyErrorV1(message);
}

function positiveMinor(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return invalid("legacy amount is invalid");
  }
  return Number(value);
}

function uuid(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  ) {
    return invalid(`${field} is invalid`);
  }
  return value;
}

function expectedCanonicalMethod(paymentMethod: string) {
  if (paymentMethod === "cash" || paymentMethod === "cod") return paymentMethod;
  if (paymentMethod === "bank_transfer") return "manual_bank";
  if (INITIAL_POSTED_PROVIDER_METHODS_V1.has(paymentMethod)) return "provider";
  return invalid("payment method is unsupported");
}

export function selectPaymentEntryCompatibilityV1(
  input: PaymentEntryCompatibilityInputV1,
  config: { enabled: boolean } = PAYMENT_ENTRY_COMPATIBILITY_DEFAULT_CONFIG_V1,
): PaymentEntryCompatibilityDecisionV1 {
  if (config.enabled !== true) {
    return {
      enabled: false,
      writeMode: "legacy_only",
      legacyStatus: input.legacyStatus,
      aggregateReadSource: "app.payment_entries",
      legacyMetadata: {},
    };
  }
  const boundary: unknown = input.boundary;
  if (boundary !== "order_created") {
    invalid("compatibility boundary is unsupported");
  }
  if (input.legacyStatus !== "pending" && input.legacyStatus !== "posted") {
    invalid("legacy status is invalid for an initial charge");
  }
  const legacyAmountMinor = positiveMinor(input.legacyAmountMinor);
  const expectedMethod = expectedCanonicalMethod(input.paymentMethod);
  const canonicalCharge = input.canonicalCharge;
  if (
    !canonicalCharge
    || canonicalCharge.enabled !== true
    || !("kind" in canonicalCharge)
    || canonicalCharge.kind !== "recorded"
  ) {
    invalid("canonical charge proof is required before the legacy mirror");
  }
  if (canonicalCharge.method !== expectedMethod) {
    invalid("canonical payment method drift");
  }
  // Manual bank is normally pending, but the order-created caller may carry
  // the narrow, trusted POS booking attestation which creates a canonical
  // posted receipt.  Mirror the already-validated canonical result exactly;
  // no payload can choose this because only that caller constructs the proof.
  const expectedStatus = expectedMethod === "manual_bank"
    ? canonicalCharge.status
    : "posted";
  if (canonicalCharge.status !== expectedStatus) {
    invalid("canonical payment status drift");
  }
  if (canonicalCharge.amountMinor !== legacyAmountMinor) {
    invalid("canonical payment amount drift");
  }
  const canonicalPaymentEventId = uuid(
    canonicalCharge.paymentEventId,
    "canonical payment event id",
  );
  const canonicalPaymentObligationId = uuid(
    canonicalCharge.obligationId,
    "canonical payment obligation id",
  );
  if (
    canonicalCharge.outcome !== "inserted"
    && canonicalCharge.outcome !== "replayed"
  ) {
    invalid("canonical payment write outcome is invalid");
  }

  return {
    enabled: true,
    writeMode: "canonical_plus_legacy_mirror",
    legacyStatus: expectedStatus,
    aggregateReadSource: "app.payment_events",
    legacyMetadata: {
      canonicalPaymentEventId,
      canonicalPaymentObligationId,
      canonicalPaymentWriteOutcome: canonicalCharge.outcome,
      compatibilityVersion: 1,
      financialAggregateSource: "app.payment_events",
      ...(expectedMethod === "provider"
        ? { providerChargeOwner: "provider_initial_posted_charge_caller" as const }
        : {}),
    },
  };
}
