import { createHash } from "node:crypto";
import {
  OrderCommercialComponentsV1Schema,
  OrderCommercialComponentsV2Schema,
  PaymentCashEventV1Schema,
  SUPPORTED_CURRENCY_REGISTRY_V1,
  type OrderCommercialComponentsV1,
  type OrderCommercialComponentsV2,
} from "@medusa-snus/contracts";

export const PAYMENT_LATER_CONFIRMATION_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: false,
});

type LaterMethodV1 = "manual_bank" | "provider";
type LaterEvidenceTypeV1 = "manual_verified" | "provider_webhook_success";

export interface PaymentLaterConfirmationInputV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  commercialRevisionId: string;
  commercialRevision: number;
  currencyCode: string;
  minorUnitExponent: number;
  components: OrderCommercialComponentsV1;
  obligation: {
    obligationId: string;
    obligationIdempotencyKey: string;
    amountMinor: number;
    collectedMinor: number;
  };
  pendingAttempt: {
    paymentEventId: string;
    idempotencyKey: string;
    method: LaterMethodV1;
    status: "pending";
    amountMinor: number;
    sourceType: "order_created";
    sourceId: string;
    sourceOccurredAt: string;
    evidenceType: null;
    evidenceFingerprint: null;
  };
  confirmation: {
    kind: "manual_bank_verified" | "provider_success";
    evidenceFingerprint: string;
    sourceSystem: string;
    sourceReference: string;
    confirmedAt: string;
  };
}

export interface NormalizedPaymentLaterConfirmationV1 {
  bundleVersion: 1;
  bundleFingerprint: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  commercialRevisionId: string;
  commercialRevision: number;
  currencyCode: string;
  minorUnitExponent: number;
  components: OrderCommercialComponentsV1;
  priorPendingPaymentEventId: string;
  priorPendingIdempotencyKey: string;
  priorPendingSourceType: "order_created";
  priorPendingSourceId: string;
  priorPendingSourceOccurredAt: string;
  obligationId: string;
  obligationIdempotencyKey: string;
  event: {
    kind: "charge";
    status: "posted";
    method: LaterMethodV1;
    evidenceType: LaterEvidenceTypeV1;
    evidenceFingerprint: string;
    amountMinor: number;
    idempotencyKey: string;
    sourceType: "manual_bank_confirmation" | "provider_confirmation";
    sourceId: string;
    sourceOccurredAt: string;
  };
  evidence: {
    evidenceType: LaterEvidenceTypeV1;
    evidenceFingerprint: string;
    sourceSystem: string;
    sourceReference: string;
    verificationStatus: "verified";
    sourceOccurredAt: string;
  };
  componentAllocation: OrderCommercialComponentsV1;
  allocation: {
    allocationKind: "collection";
    amountMinor: number;
    idempotencyKey: string;
    allocatedAt: string;
  };
}

export type PaymentLaterConfirmationTaskV1 =
  | { enabled: false; status: "disabled" }
  | { enabled: true; bundle: NormalizedPaymentLaterConfirmationV1 };

export interface PersistedPaymentLaterConfirmationV1 {
  outcome: "inserted" | "replayed";
  bundleFingerprint: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  commercialRevisionId: string;
  eventIdempotencyKey: string;
  priorPendingPaymentEventId: string;
  obligationId: string;
  paymentEventId: string;
}

export interface PaymentLaterConfirmationRepositoryV1 {
  appendLaterConfirmation(
    bundle: NormalizedPaymentLaterConfirmationV1,
  ): Promise<PersistedPaymentLaterConfirmationV1>;
}

export type PaymentLaterConfirmationInputV2 = Omit<PaymentLaterConfirmationInputV1, "components"> & { components: OrderCommercialComponentsV2 };
export type NormalizedPaymentLaterConfirmationV2 = Omit<NormalizedPaymentLaterConfirmationV1, "bundleVersion" | "components" | "componentAllocation"> & {
  bundleVersion: 2;
  components: OrderCommercialComponentsV2;
  componentAllocation: OrderCommercialComponentsV2;
};
export interface PaymentLaterConfirmationRepositoryV2 {
  appendLaterConfirmation(bundle: NormalizedPaymentLaterConfirmationV2): Promise<PersistedPaymentLaterConfirmationV1>;
}

export class PaymentLaterConfirmationContractErrorV1 extends Error {
  readonly code = "payment_later_confirmation_invalid";

  constructor(message: string) {
    super(message);
    this.name = "PaymentLaterConfirmationContractErrorV1";
  }
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new PaymentLaterConfirmationContractErrorV1(`${field} is invalid`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw new PaymentLaterConfirmationContractErrorV1(`${field} is invalid`);
  }
  return value;
}

function safeNonnegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PaymentLaterConfirmationContractErrorV1(`${field} is invalid`);
  }
  return value as number;
}

function canonicalInstant(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new PaymentLaterConfirmationContractErrorV1(`${field} is invalid`);
  }
  try {
    if (new Date(value).toISOString() !== value) {
      throw new PaymentLaterConfirmationContractErrorV1(`${field} is invalid`);
    }
  } catch (error) {
    if (error instanceof PaymentLaterConfirmationContractErrorV1) throw error;
    throw new PaymentLaterConfirmationContractErrorV1(`${field} is invalid`);
  }
  return value;
}

function exactKeys(value: object, expected: string[], field: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new PaymentLaterConfirmationContractErrorV1(`${field} shape is invalid`);
  }
}

function fingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedBundle(input: PaymentLaterConfirmationInputV1): NormalizedPaymentLaterConfirmationV1;
function normalizedBundle(input: PaymentLaterConfirmationInputV2, componentVersion: 2): NormalizedPaymentLaterConfirmationV2;
function normalizedBundle(input: PaymentLaterConfirmationInputV1 | PaymentLaterConfirmationInputV2, componentVersion: 1 | 2 = 1): NormalizedPaymentLaterConfirmationV1 | NormalizedPaymentLaterConfirmationV2 {
  const merchantId = requiredToken(input.merchantId, "merchantId");
  const storeId = requiredToken(input.storeId, "storeId");
  const orderId = requiredToken(input.orderId, "orderId");
  const commercialRevisionId = uuid(input.commercialRevisionId, "commercialRevisionId");
  const commercialRevision = safeNonnegative(input.commercialRevision, "commercialRevision");
  const currency = SUPPORTED_CURRENCY_REGISTRY_V1.find(
    (item) => item.currencyCode === input.currencyCode,
  );
  if (
    !currency
    || !currency.writeSupported
    || currency.minorUnitExponent !== input.minorUnitExponent
  ) {
    throw new PaymentLaterConfirmationContractErrorV1("confirmation currency is unsupported");
  }
  const parsedComponents = (componentVersion === 2 ? OrderCommercialComponentsV2Schema : OrderCommercialComponentsV1Schema).safeParse(input.components);
  if (!parsedComponents.success || parsedComponents.data.totalMinor <= 0) {
    throw new PaymentLaterConfirmationContractErrorV1("confirmation components are invalid");
  }
  const components = parsedComponents.data;

  if (!input.obligation || typeof input.obligation !== "object") {
    throw new PaymentLaterConfirmationContractErrorV1("obligation is invalid");
  }
  exactKeys(input.obligation, [
    "obligationId",
    "obligationIdempotencyKey",
    "amountMinor",
    "collectedMinor",
  ], "obligation");
  const obligationId = uuid(input.obligation.obligationId, "obligationId");
  const obligationIdempotencyKey = requiredToken(
    input.obligation.obligationIdempotencyKey,
    "obligationIdempotencyKey",
  );
  const obligationAmountMinor = safeNonnegative(
    input.obligation.amountMinor,
    "obligation.amountMinor",
  );
  const collectedMinor = safeNonnegative(
    input.obligation.collectedMinor,
    "obligation.collectedMinor",
  );
  if (obligationAmountMinor !== components.totalMinor || collectedMinor !== 0) {
    throw new PaymentLaterConfirmationContractErrorV1(
      "later confirmation requires the full uncollected original obligation",
    );
  }

  if (!input.pendingAttempt || typeof input.pendingAttempt !== "object") {
    throw new PaymentLaterConfirmationContractErrorV1("pendingAttempt is invalid");
  }
  exactKeys(input.pendingAttempt, [
    "paymentEventId",
    "idempotencyKey",
    "method",
    "status",
    "amountMinor",
    "sourceType",
    "sourceId",
    "sourceOccurredAt",
    "evidenceType",
    "evidenceFingerprint",
  ], "pendingAttempt");
  const priorPendingPaymentEventId = uuid(
    input.pendingAttempt.paymentEventId,
    "pendingAttempt.paymentEventId",
  );
  const priorPendingIdempotencyKey = requiredToken(
    input.pendingAttempt.idempotencyKey,
    "pendingAttempt.idempotencyKey",
  );
  if (input.pendingAttempt.sourceType !== "order_created") {
    throw new PaymentLaterConfirmationContractErrorV1(
      "pendingAttempt.sourceType is invalid",
    );
  }
  const priorPendingSourceId = requiredToken(
    input.pendingAttempt.sourceId,
    "pendingAttempt.sourceId",
  );
  const priorPendingSourceOccurredAt = canonicalInstant(
    input.pendingAttempt.sourceOccurredAt,
    "pendingAttempt.sourceOccurredAt",
  );
  if (
    input.pendingAttempt.status !== "pending"
    || (input.pendingAttempt.method !== "manual_bank" && input.pendingAttempt.method !== "provider")
    || input.pendingAttempt.evidenceType !== null
    || input.pendingAttempt.evidenceFingerprint !== null
    || safeNonnegative(input.pendingAttempt.amountMinor, "pendingAttempt.amountMinor")
      !== components.totalMinor
  ) {
    throw new PaymentLaterConfirmationContractErrorV1("prior payment attempt is not exact pending");
  }

  if (!input.confirmation || typeof input.confirmation !== "object") {
    throw new PaymentLaterConfirmationContractErrorV1("confirmation is invalid");
  }
  exactKeys(input.confirmation, [
    "kind",
    "evidenceFingerprint",
    "sourceSystem",
    "sourceReference",
    "confirmedAt",
  ], "confirmation");
  const expected = input.pendingAttempt.method === "provider"
    ? {
        kind: "provider_success" as const,
        evidenceType: "provider_webhook_success" as const,
        sourceType: "provider_confirmation" as const,
      }
    : {
        kind: "manual_bank_verified" as const,
        evidenceType: "manual_verified" as const,
        sourceType: "manual_bank_confirmation" as const,
      };
  if (input.confirmation.kind !== expected.kind) {
    throw new PaymentLaterConfirmationContractErrorV1("confirmation does not match pending method");
  }
  const evidenceFingerprint = requiredToken(
    input.confirmation.evidenceFingerprint,
    "evidenceFingerprint",
  );
  if (!/^[a-f0-9]{64}$/.test(evidenceFingerprint)) {
    throw new PaymentLaterConfirmationContractErrorV1("evidenceFingerprint is invalid");
  }
  const sourceSystem = requiredToken(input.confirmation.sourceSystem, "sourceSystem");
  const sourceReference = requiredToken(input.confirmation.sourceReference, "sourceReference");
  const sourceOccurredAt = canonicalInstant(input.confirmation.confirmedAt, "confirmedAt");
  if (Date.parse(sourceOccurredAt) < Date.parse(priorPendingSourceOccurredAt)) {
    throw new PaymentLaterConfirmationContractErrorV1(
      "confirmation cannot precede the pending attempt",
    );
  }

  const confirmationIdentity = fingerprint({
    schemaVersion: 1,
    merchantId,
    storeId,
    orderId,
    method: input.pendingAttempt.method,
    sourceSystem,
    sourceReference,
    evidenceFingerprint,
  });
  const idempotencyKey = `payment_confirmation:v1:${confirmationIdentity}`;
  const event = {
    kind: "charge" as const,
    status: "posted" as const,
    method: input.pendingAttempt.method,
    evidenceType: expected.evidenceType,
    evidenceFingerprint,
    amountMinor: components.totalMinor,
    idempotencyKey,
    sourceType: expected.sourceType,
    sourceId: confirmationIdentity,
    sourceOccurredAt,
  };
  const eventContract = PaymentCashEventV1Schema.safeParse({
    schemaVersion: 1,
    eventId: idempotencyKey,
    idempotencyKey,
    orderId,
    method: event.method,
    kind: event.kind,
    status: event.status,
    evidenceType: event.evidenceType,
    currencyCode: currency.currencyCode,
    amountMinor: event.amountMinor,
    eventAt: event.sourceOccurredAt,
  });
  if (!eventContract.success) {
    throw new PaymentLaterConfirmationContractErrorV1(
      "later confirmation payment event contract is invalid",
    );
  }

  const body = {
    bundleVersion: componentVersion,
    merchantId,
    storeId,
    orderId,
    commercialRevisionId,
    commercialRevision,
    currencyCode: currency.currencyCode,
    minorUnitExponent: currency.minorUnitExponent,
    components,
    priorPendingPaymentEventId,
    priorPendingIdempotencyKey,
    priorPendingSourceType: "order_created" as const,
    priorPendingSourceId,
    priorPendingSourceOccurredAt,
    obligationId,
    obligationIdempotencyKey,
    event,
    evidence: {
      evidenceType: expected.evidenceType,
      evidenceFingerprint,
      sourceSystem,
      sourceReference,
      verificationStatus: "verified" as const,
      sourceOccurredAt,
    },
    componentAllocation: { ...components },
    allocation: {
      allocationKind: "collection" as const,
      amountMinor: components.totalMinor,
      idempotencyKey: `${idempotencyKey}:allocation:${obligationId}`,
      allocatedAt: sourceOccurredAt,
    },
  };
  if (componentVersion === 2) {
    const components = OrderCommercialComponentsV2Schema.parse(body.components);
    const versioned = { ...body, bundleVersion: 2 as const, components, componentAllocation: { ...components } };
    return { ...versioned, bundleFingerprint: fingerprint(versioned) };
  }
  const versioned = { ...body, bundleVersion: 1 as const };
  return { ...versioned, bundleFingerprint: fingerprint(versioned) };
}

function inputFromNormalizedConfirmation(
  value: NormalizedPaymentLaterConfirmationV1 | NormalizedPaymentLaterConfirmationV2,
): PaymentLaterConfirmationInputV1 | PaymentLaterConfirmationInputV2 {
  return {
      merchantId: value.merchantId,
      storeId: value.storeId,
      orderId: value.orderId,
      commercialRevisionId: value.commercialRevisionId,
      commercialRevision: value.commercialRevision,
      currencyCode: value.currencyCode,
      minorUnitExponent: value.minorUnitExponent,
      components: value.components,
      obligation: {
        obligationId: value.obligationId,
        obligationIdempotencyKey: value.obligationIdempotencyKey,
        amountMinor: value.components.totalMinor,
        collectedMinor: 0,
      },
      pendingAttempt: {
        paymentEventId: value.priorPendingPaymentEventId,
        idempotencyKey: value.priorPendingIdempotencyKey,
        method: value.event.method,
        status: "pending",
        amountMinor: value.components.totalMinor,
        sourceType: value.priorPendingSourceType,
        sourceId: value.priorPendingSourceId,
        sourceOccurredAt: value.priorPendingSourceOccurredAt,
        evidenceType: null,
        evidenceFingerprint: null,
      },
      confirmation: {
        kind: value.event.method === "provider"
          ? "provider_success"
          : "manual_bank_verified",
        evidenceFingerprint: value.evidence.evidenceFingerprint,
        sourceSystem: value.evidence.sourceSystem,
        sourceReference: value.evidence.sourceReference,
        confirmedAt: value.evidence.sourceOccurredAt,
      },
  };
}

export function assertNormalizedPaymentLaterConfirmationV1(
  value: NormalizedPaymentLaterConfirmationV1,
): NormalizedPaymentLaterConfirmationV1 {
  let expected: NormalizedPaymentLaterConfirmationV1;
  try {
    expected = normalizedBundle(inputFromNormalizedConfirmation(value));
  } catch (error) {
    throw new PaymentLaterConfirmationContractErrorV1(
      `normalized later confirmation is invalid: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  if (JSON.stringify(expected) !== JSON.stringify(value)) {
    throw new PaymentLaterConfirmationContractErrorV1(
      "normalized later confirmation identity drift",
    );
  }
  return expected;
}

export function createPaymentLaterConfirmationTaskV1(
  input: PaymentLaterConfirmationInputV1,
  config: { enabled: boolean } = PAYMENT_LATER_CONFIRMATION_DEFAULT_CONFIG_V1,
): PaymentLaterConfirmationTaskV1 {
  if (config.enabled !== true) return { enabled: false, status: "disabled" };
  return { enabled: true, bundle: normalizedBundle(input) };
}

export function assertNormalizedPaymentLaterConfirmationV2(value: NormalizedPaymentLaterConfirmationV2): NormalizedPaymentLaterConfirmationV2 {
  let expected: NormalizedPaymentLaterConfirmationV2;
  try {
    expected = normalizedBundle({ ...inputFromNormalizedConfirmation(value), components: OrderCommercialComponentsV2Schema.parse(value.components) }, 2);
  } catch (error) {
    throw new PaymentLaterConfirmationContractErrorV1(`normalized later confirmation is invalid: ${error instanceof Error ? error.message : "unknown"}`);
  }
  if (JSON.stringify(expected) !== JSON.stringify(value)) throw new PaymentLaterConfirmationContractErrorV1("normalized later confirmation identity drift");
  return expected;
}

export function createPaymentLaterConfirmationTaskV2(
  input: PaymentLaterConfirmationInputV2,
  config: { enabled: boolean } = PAYMENT_LATER_CONFIRMATION_DEFAULT_CONFIG_V1,
): { enabled: false; status: "disabled" } | { enabled: true; bundle: NormalizedPaymentLaterConfirmationV2 } {
  if (config.enabled !== true) return { enabled: false, status: "disabled" };
  return { enabled: true, bundle: normalizedBundle(input, 2) };
}
