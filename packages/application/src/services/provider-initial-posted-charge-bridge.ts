import { createHash } from "node:crypto";
import { OrderCommercialComponentsV2Schema, type OrderCommercialComponentsV1, type OrderCommercialComponentsV2 } from "@medusa-snus/contracts";
import {
  createPaymentChargeBundleTaskV1,
  createPaymentChargeBundleTaskV2,
  type PaymentChargeBundleRepositoryV1,
  type PaymentChargeBundleRepositoryV2,
  type PaymentChargeBundleTaskV1,
} from "./payment-charge-bundle-service";

export const PROVIDER_INITIAL_POSTED_CHARGE_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: true,
});

type ProviderKeyV1 = "sepay_va" | "nowpayments";

export interface CurrentTransactionPaymentChargeBundleRepositoryV1
  extends PaymentChargeBundleRepositoryV1 {
  readonly transactionOwnership: "caller";
}

export interface CurrentTransactionPaymentChargeBundleRepositoryV2 extends PaymentChargeBundleRepositoryV2 {
  readonly transactionOwnership: "caller";
}

export interface ProviderSettlementVerificationV1 {
  authenticated: boolean;
  signatureAlgorithm: "hmac-sha256" | "api-key" | "hmac-sha512";
  signedPayloadSha256?: string;
  payloadSha256?: string;
  rawBodyPreserved?: boolean;
  providerConfigPurpose?: string;
  providerConfigId?: string | null;
  terminal?: boolean;
  paymentStatus?: string;
}

export interface ProviderInitialPostedChargeInputV1 {
  merchantId: string;
  storeId: string;
  paymentIntentId: string;
  orderId: string;
  orderCreatedInCurrentTransaction: boolean;
  commercialRevisionId: string;
  commercialRevision: number;
  currencyCode: string;
  minorUnitExponent: number;
  components: OrderCommercialComponentsV1;
  intentAmountMinor: number;
  provider: ProviderKeyV1;
  providerConfigPurpose: "merchant_retail";
  providerConfigId: string;
  providerEventId: string;
  referenceCode: string;
  providerAmount: string;
  providerCurrencyCode: string;
  expectedProviderAmount: string;
  expectedProviderCurrencyCode: string;
  direction?: "in" | "out" | "unknown";
  providerTransactionId?: string;
  providerTransactionHash?: string;
  providerNetwork?: string;
  providerPayCurrency?: string;
  settlementOccurredAt: string;
  verification: ProviderSettlementVerificationV1;
}

export interface ProviderInitialPostedChargeDependenciesV1 {
  repository: CurrentTransactionPaymentChargeBundleRepositoryV1;
  config?: {
    enabled: boolean;
  };
}

export type ProviderInitialPostedChargeInputV2 = Omit<ProviderInitialPostedChargeInputV1, "components"> & {
  components: OrderCommercialComponentsV2;
};
export interface ProviderInitialPostedChargeDependenciesV2 {
  repository: CurrentTransactionPaymentChargeBundleRepositoryV2;
  config?: { enabled: boolean };
}

export type ProviderInitialPostedChargeTaskV1 = PaymentChargeBundleTaskV1;

export class ProviderInitialPostedChargeValidationErrorV1 extends Error {
  readonly code = "provider_initial_posted_charge_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ProviderInitialPostedChargeValidationErrorV1";
  }
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new ProviderInitialPostedChargeValidationErrorV1(`${field} is invalid`);
  }
  return value;
}

function optionalToken(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredToken(value, field);
}

function canonicalInstant(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new ProviderInitialPostedChargeValidationErrorV1("settlementOccurredAt is invalid");
  }
  try {
    if (new Date(value).toISOString() !== value) {
      throw new ProviderInitialPostedChargeValidationErrorV1("settlementOccurredAt is invalid");
    }
  } catch (error) {
    if (error instanceof ProviderInitialPostedChargeValidationErrorV1) throw error;
    throw new ProviderInitialPostedChargeValidationErrorV1("settlementOccurredAt is invalid");
  }
  return value;
}

function canonicalDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    throw new ProviderInitialPostedChargeValidationErrorV1(`${field} is invalid`);
  }
  const [whole, fraction = ""] = value.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const result = trimmedFraction ? `${whole}.${trimmedFraction}` : whole!;
  if (Number(result) <= 0 || !Number.isFinite(Number(result))) {
    throw new ProviderInitialPostedChargeValidationErrorV1(`${field} is invalid`);
  }
  return result;
}

function canonicalCurrency(value: unknown, field: string): string {
  const token = requiredToken(value, field).toLowerCase();
  if (!/^[a-z0-9]{3,20}$/.test(token)) {
    throw new ProviderInitialPostedChargeValidationErrorV1(`${field} is invalid`);
  }
  return token;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
      return result;
    }, {});
}

function sha256(value: object): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function digest(value: unknown, field: string): string {
  const token = requiredToken(value, field);
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new ProviderInitialPostedChargeValidationErrorV1(`${field} is invalid`);
  }
  return token;
}

export type ProviderSettlementEvidenceInputV1 = Pick<ProviderInitialPostedChargeInputV1,
  "provider" | "providerConfigPurpose" | "providerConfigId" | "intentAmountMinor" | "providerAmount"
  | "expectedProviderAmount" | "providerCurrencyCode" | "expectedProviderCurrencyCode" | "direction" | "verification">;

export function validateProviderSettlementEvidenceV1(input: { [K in keyof ProviderSettlementEvidenceInputV1]: unknown }) {
  const providerConfigId = requiredToken(input.providerConfigId, "providerConfigId");
  if (input.providerConfigPurpose !== "merchant_retail") {
    throw new ProviderInitialPostedChargeValidationErrorV1("provider config purpose is invalid");
  }
  if (typeof input.intentAmountMinor !== "number" || !Number.isSafeInteger(input.intentAmountMinor) || input.intentAmountMinor <= 0) {
    throw new ProviderInitialPostedChargeValidationErrorV1("intentAmountMinor is invalid");
  }
  const providerAmount = canonicalDecimal(input.providerAmount, "providerAmount");
  const expectedProviderAmount = canonicalDecimal(
    input.expectedProviderAmount,
    "expectedProviderAmount",
  );
  const providerCurrencyCode = canonicalCurrency(
    input.providerCurrencyCode,
    "providerCurrencyCode",
  );
  const expectedProviderCurrencyCode = canonicalCurrency(
    input.expectedProviderCurrencyCode,
    "expectedProviderCurrencyCode",
  );
  if (
    providerAmount !== expectedProviderAmount
    || providerCurrencyCode !== expectedProviderCurrencyCode
  ) {
    throw new ProviderInitialPostedChargeValidationErrorV1(
      "provider amount or currency differs from locked intent evidence",
    );
  }

  if (!input.verification || typeof input.verification !== "object" || Array.isArray(input.verification)) {
    throw new ProviderInitialPostedChargeValidationErrorV1("provider evidence is unauthenticated");
  }
  const verification = input.verification as Record<string, unknown>;
  if (verification.authenticated !== true) {
    throw new ProviderInitialPostedChargeValidationErrorV1("provider evidence is unauthenticated");
  }
  const signatureAlgorithm = requiredToken(
    verification.signatureAlgorithm,
    "signatureAlgorithm",
  );
  const authenticatedPayloadSha256 = digest(
    verification.signedPayloadSha256 ?? verification.payloadSha256,
    "authenticatedPayloadSha256",
  );

  if (input.provider === "sepay_va") {
    if (input.direction !== "in") {
      throw new ProviderInitialPostedChargeValidationErrorV1("SePay direction is not incoming");
    }
    if (!new Set(["hmac-sha256", "api-key"]).has(signatureAlgorithm)) {
      throw new ProviderInitialPostedChargeValidationErrorV1("SePay authentication algorithm is invalid");
    }
    if (signatureAlgorithm === "hmac-sha256" && verification.rawBodyPreserved !== true) {
      throw new ProviderInitialPostedChargeValidationErrorV1("SePay HMAC raw body is unproven");
    }
    if (
      verification.providerConfigPurpose !== "merchant_retail"
      || verification.providerConfigId !== providerConfigId
    ) {
      throw new ProviderInitialPostedChargeValidationErrorV1(
        "SePay verification config differs from locked intent",
      );
    }
    if (
      providerCurrencyCode !== "vnd"
      || providerAmount !== String(input.intentAmountMinor)
    ) {
      throw new ProviderInitialPostedChargeValidationErrorV1(
        "SePay amount does not equal the locked VND intent",
      );
    }
  } else if (input.provider === "nowpayments") {
    if (
      signatureAlgorithm !== "hmac-sha512"
      || verification.terminal !== true
      || verification.paymentStatus !== "finished"
    ) {
      throw new ProviderInitialPostedChargeValidationErrorV1(
        "NOWPayments evidence is not terminal finished",
      );
    }
    if (
      verification.providerConfigPurpose !== "merchant_retail"
      || verification.providerConfigId !== providerConfigId
    ) {
      throw new ProviderInitialPostedChargeValidationErrorV1(
        "NOWPayments verification config differs from locked intent",
      );
    }
  } else {
    throw new ProviderInitialPostedChargeValidationErrorV1("provider is unsupported");
  }

  return { providerAmount, expectedProviderAmount, providerCurrencyCode, expectedProviderCurrencyCode,
    verification, signatureAlgorithm, authenticatedPayloadSha256 };
}

function buildEvidencePayload(input: ProviderInitialPostedChargeInputV1) {
  const merchantId = requiredToken(input.merchantId, "merchantId");
  const storeId = requiredToken(input.storeId, "storeId");
  const paymentIntentId = requiredToken(input.paymentIntentId, "paymentIntentId");
  const orderId = requiredToken(input.orderId, "orderId");
  const providerConfigId = requiredToken(input.providerConfigId, "providerConfigId");
  const providerEventId = requiredToken(input.providerEventId, "providerEventId");
  const referenceCode = requiredToken(input.referenceCode, "referenceCode");
  const settlementOccurredAt = canonicalInstant(input.settlementOccurredAt);
  if (input.providerConfigPurpose !== "merchant_retail") {
    throw new ProviderInitialPostedChargeValidationErrorV1("provider config purpose is invalid");
  }
  if (input.orderCreatedInCurrentTransaction !== true) {
    throw new ProviderInitialPostedChargeValidationErrorV1(
      "provider order must be created in the same settlement transaction",
    );
  }
  if (!Number.isSafeInteger(input.intentAmountMinor) || input.intentAmountMinor <= 0) {
    throw new ProviderInitialPostedChargeValidationErrorV1("intentAmountMinor is invalid");
  }
  if (input.components.totalMinor !== input.intentAmountMinor) {
    throw new ProviderInitialPostedChargeValidationErrorV1("commercial total differs from locked intent");
  }

  const { providerAmount, expectedProviderAmount, providerCurrencyCode, expectedProviderCurrencyCode,
    verification, signatureAlgorithm, authenticatedPayloadSha256 } = validateProviderSettlementEvidenceV1(input);

  const evidencePayload: Record<string, unknown> = {
    schemaVersion: 1,
    merchantId,
    storeId,
    paymentIntentId,
    orderId,
    provider: input.provider,
    providerConfigPurpose: input.providerConfigPurpose,
    providerConfigId,
    providerEventId,
    referenceCode,
    providerAmount,
    providerCurrencyCode,
    expectedProviderAmount,
    expectedProviderCurrencyCode,
    authenticated: true,
    signatureAlgorithm,
    signedPayloadSha256: authenticatedPayloadSha256,
    settlementOccurredAt,
  };
  for (const [key, value] of Object.entries({
    direction: input.direction,
    providerTransactionId: optionalToken(input.providerTransactionId, "providerTransactionId"),
    providerTransactionHash: optionalToken(input.providerTransactionHash, "providerTransactionHash"),
    providerNetwork: optionalToken(input.providerNetwork, "providerNetwork"),
    providerPayCurrency: optionalToken(input.providerPayCurrency, "providerPayCurrency"),
    terminal: verification.terminal,
    paymentStatus: verification.paymentStatus,
  })) {
    if (value !== undefined) evidencePayload[key] = value;
  }

  return {
    merchantId,
    storeId,
    paymentIntentId,
    orderId,
    providerConfigId,
    providerEventId,
    settlementOccurredAt,
    evidencePayload,
  };
}

function createProviderInitialPostedChargeTask(
  dependencies: ProviderInitialPostedChargeDependenciesV1 | ProviderInitialPostedChargeDependenciesV2,
  input: ProviderInitialPostedChargeInputV1 | ProviderInitialPostedChargeInputV2,
  componentVersion: 1 | 2,
): ProviderInitialPostedChargeTaskV1 {
  const config = dependencies?.config ?? PROVIDER_INITIAL_POSTED_CHARGE_DEFAULT_CONFIG_V1;
  if (config.enabled !== true) {
    return { enabled: false, status: "disabled" };
  }
  if (
    !dependencies.repository
    || dependencies.repository.transactionOwnership !== "caller"
    || typeof dependencies.repository.appendChargeBundle !== "function"
  ) {
    throw new ProviderInitialPostedChargeValidationErrorV1(
      "provider bridge requires a caller-owned transaction repository",
    );
  }
  const normalized = buildEvidencePayload(input);
  const sourceReference = [
    input.providerConfigPurpose,
    normalized.providerConfigId,
    normalized.providerEventId,
  ].join(":");
  const sourceId = [
    input.provider,
    normalized.providerConfigId,
    normalized.providerEventId,
    normalized.paymentIntentId,
  ].join(":");
  const chargeInput = {
    merchantId: normalized.merchantId,
    storeId: normalized.storeId,
    orderId: normalized.orderId,
    commercialRevisionId: input.commercialRevisionId,
    commercialRevision: input.commercialRevision,
    currencyCode: input.currencyCode,
    minorUnitExponent: input.minorUnitExponent,
    method: "provider" as const,
    status: "posted" as const,
    components: structuredClone(input.components),
    evidence: {
      evidenceType: "provider_webhook_success" as const,
      evidenceFingerprint: sha256(normalized.evidencePayload),
      sourceSystem: input.provider,
      sourceReference,
      evidencePayload: normalized.evidencePayload,
    },
    idempotencyKey: `payment:${normalized.orderId}:provider:${sourceReference}`,
    sourceType: "order_created",
    sourceId,
    sourceOccurredAt: normalized.settlementOccurredAt,
  };
  const task = componentVersion === 2
    ? createPaymentChargeBundleTaskV2({ config: { enabled: true },
      repository: dependencies.repository as CurrentTransactionPaymentChargeBundleRepositoryV2,
    }, { ...chargeInput, components: OrderCommercialComponentsV2Schema.parse(input.components) })
    : createPaymentChargeBundleTaskV1({ config: { enabled: true },
      repository: dependencies.repository as CurrentTransactionPaymentChargeBundleRepositoryV1,
    }, chargeInput);
  if (!task.enabled) {
    throw new ProviderInitialPostedChargeValidationErrorV1("provider bridge task is unavailable");
  }
  return task;
}

export function createProviderInitialPostedChargeTaskV1(
  dependencies: ProviderInitialPostedChargeDependenciesV1, input: ProviderInitialPostedChargeInputV1,
): ProviderInitialPostedChargeTaskV1 {
  return createProviderInitialPostedChargeTask(dependencies, input, 1);
}

export function createProviderInitialPostedChargeTaskV2(
  dependencies: ProviderInitialPostedChargeDependenciesV2, input: ProviderInitialPostedChargeInputV2,
): ProviderInitialPostedChargeTaskV1 {
  return createProviderInitialPostedChargeTask(dependencies, input, 2);
}
