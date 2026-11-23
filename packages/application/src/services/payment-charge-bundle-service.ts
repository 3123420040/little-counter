import { createHash } from "node:crypto";
import {
  OrderCommercialComponentsV1Schema,
  OrderCommercialComponentsV2Schema,
  PaymentCashEventV1Schema,
  SUPPORTED_CURRENCY_REGISTRY_V1,
  type OrderCommercialComponentsV1,
  type OrderCommercialComponentsV2,
  type PaymentCashEventV1,
} from "@medusa-snus/contracts";

export const PAYMENT_CHARGE_BUNDLE_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: false,
});

type PaymentMethodV1 = PaymentCashEventV1["method"];
type PaymentStatusV1 = PaymentCashEventV1["status"];
type EvidenceTypeV1 = NonNullable<PaymentCashEventV1["evidenceType"]>;

export interface PaymentChargeBundleEvidenceInputV1 {
  evidenceType: EvidenceTypeV1;
  evidenceFingerprint: string;
  sourceSystem: string;
  sourceReference: string;
  evidencePayload?: Record<string, unknown>;
}

export interface PaymentChargeBundleInputV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  commercialRevisionId: string;
  commercialRevision: number;
  currencyCode: string;
  minorUnitExponent: number;
  method: PaymentMethodV1;
  status: PaymentStatusV1;
  components: OrderCommercialComponentsV1;
  evidence?: PaymentChargeBundleEvidenceInputV1;
  idempotencyKey: string;
  sourceType: string;
  sourceId: string;
  sourceOccurredAt: string;
}

export interface NormalizedPaymentChargeBundleV1 {
  bundleVersion: 1;
  bundleFingerprint: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  commercialRevisionId: string;
  commercialRevision: number;
  currencyCode: string;
  minorUnitExponent: number;
  sourceType: string;
  sourceId: string;
  sourceOccurredAt: string;
  components: OrderCommercialComponentsV1;
  obligation: {
    obligationKind: "order_charge";
    amountMinor: number;
    idempotencyKey: string;
  };
  event: {
    kind: "charge";
    status: PaymentStatusV1;
    method: PaymentMethodV1;
    evidenceType: EvidenceTypeV1 | null;
    evidenceFingerprint: string | null;
    amountMinor: number;
    idempotencyKey: string;
  };
  evidence: {
    evidenceType: EvidenceTypeV1;
    evidenceFingerprint: string;
    sourceSystem: string;
    sourceReference: string;
    verificationStatus: "verified";
    sourceOccurredAt: string;
    evidencePayload: Record<string, unknown>;
  } | null;
  componentAllocation: OrderCommercialComponentsV1;
  allocation: {
    allocationKind: "collection";
    amountMinor: number;
    idempotencyKey: string;
    allocatedAt: string;
  } | null;
}

export interface PersistedPaymentChargeBundleV1 {
  outcome: "inserted" | "replayed";
  bundleFingerprint: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  commercialRevisionId: string;
  eventIdempotencyKey: string;
  obligationId: string;
  paymentEventId: string;
}

export interface PaymentChargeBundleRepositoryV1 {
  appendChargeBundle(
    bundle: NormalizedPaymentChargeBundleV1,
  ): Promise<PersistedPaymentChargeBundleV1>;
}

export type PaymentChargeBundleInputV2 = Omit<PaymentChargeBundleInputV1, "components"> & { components: OrderCommercialComponentsV2 };
export type NormalizedPaymentChargeBundleV2 = Omit<NormalizedPaymentChargeBundleV1, "bundleVersion" | "components" | "componentAllocation"> & {
  bundleVersion: 2;
  components: OrderCommercialComponentsV2;
  componentAllocation: OrderCommercialComponentsV2;
};
export interface PaymentChargeBundleRepositoryV2 {
  appendChargeBundle(bundle: NormalizedPaymentChargeBundleV2): Promise<PersistedPaymentChargeBundleV1>;
}

export interface PaymentChargeBundleDependenciesV1 {
  repository: PaymentChargeBundleRepositoryV1;
  config?: {
    enabled: boolean;
  };
}

export type PaymentChargeBundleTaskV1 =
  | {
      enabled: false;
      status: "disabled";
    }
  | {
      enabled: true;
      bundleFingerprint: string;
      execute: () => Promise<{
        kind: "recorded";
        outcome: "inserted" | "replayed";
        obligationId: string;
        paymentEventId: string;
        amountMinor: number;
        status: PaymentStatusV1;
        method: PaymentMethodV1;
      }>;
    };

export class PaymentChargeBundleValidationErrorV1 extends Error {
  readonly code = "payment_charge_bundle_invalid";

  constructor(message: string) {
    super(message);
    this.name = "PaymentChargeBundleValidationErrorV1";
  }
}

export class PaymentChargeBundleIntegrityErrorV1 extends Error {
  readonly code = "payment_charge_bundle_integrity";

  constructor(message: string) {
    super(message);
    this.name = "PaymentChargeBundleIntegrityErrorV1";
  }
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new PaymentChargeBundleValidationErrorV1(`${field} is invalid`);
  }
  return value;
}

const FORBIDDEN_EVIDENCE_PAYLOAD_KEYS = new Set([
  "apikey",
  "authorization",
  "rawbody",
  "secret",
  "signature",
  "token",
  "webhooksecret",
]);

function normalizeEvidencePayloadValue(value: unknown, path: string, depth: number): unknown {
  if (depth > 6) {
    throw new PaymentChargeBundleValidationErrorV1("evidence payload is too deep");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 2_048) {
      throw new PaymentChargeBundleValidationErrorV1(`${path} is too long`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PaymentChargeBundleValidationErrorV1(`${path} is invalid`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) {
      throw new PaymentChargeBundleValidationErrorV1(`${path} has too many values`);
    }
    return value.map((item, index) => normalizeEvidencePayloadValue(
      item,
      `${path}[${index}]`,
      depth + 1,
    ));
  }
  if (!value || typeof value !== "object") {
    throw new PaymentChargeBundleValidationErrorV1(`${path} is invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PaymentChargeBundleValidationErrorV1(`${path} is invalid`);
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (!key || key.trim() !== key || key.length > 100) {
      throw new PaymentChargeBundleValidationErrorV1(`${path} key is invalid`);
    }
    const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
    if (FORBIDDEN_EVIDENCE_PAYLOAD_KEYS.has(normalizedKey)) {
      throw new PaymentChargeBundleValidationErrorV1(`${path}.${key} is forbidden`);
    }
    result[key] = normalizeEvidencePayloadValue(
      (value as Record<string, unknown>)[key],
      `${path}.${key}`,
      depth + 1,
    );
  }
  return result;
}

function normalizeEvidencePayload(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const normalized = normalizeEvidencePayloadValue(value, "evidencePayload", 0);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new PaymentChargeBundleValidationErrorV1("evidence payload is invalid");
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 16_384) {
    throw new PaymentChargeBundleValidationErrorV1("evidence payload is too large");
  }
  return normalized as Record<string, unknown>;
}

function canonicalInstant(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new PaymentChargeBundleValidationErrorV1(`${field} is invalid`);
  }
  try {
    if (new Date(value).toISOString() !== value) {
      throw new PaymentChargeBundleValidationErrorV1(`${field} is invalid`);
    }
  } catch (error) {
    if (error instanceof PaymentChargeBundleValidationErrorV1) throw error;
    throw new PaymentChargeBundleValidationErrorV1(`${field} is invalid`);
  }
  return value;
}

function normalizeCurrency(input: Pick<PaymentChargeBundleInputV1, "currencyCode" | "minorUnitExponent">): {
  currencyCode: string;
  minorUnitExponent: number;
} {
  const definition = SUPPORTED_CURRENCY_REGISTRY_V1.find(
    (item) => item.currencyCode === input.currencyCode,
  );
  if (
    !definition
    || !definition.writeSupported
    || input.minorUnitExponent !== definition.minorUnitExponent
  ) {
    throw new PaymentChargeBundleValidationErrorV1("charge currency is unsupported");
  }
  return {
    currencyCode: definition.currencyCode,
    minorUnitExponent: definition.minorUnitExponent,
  };
}

function normalizeComponents(input: unknown): OrderCommercialComponentsV1 {
  const parsed = OrderCommercialComponentsV1Schema.safeParse(input);
  if (!parsed.success || parsed.data.totalMinor <= 0) {
    throw new PaymentChargeBundleValidationErrorV1("charge components are invalid");
  }
  return parsed.data;
}

function normalizeRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PaymentChargeBundleValidationErrorV1("commercial revision is invalid");
  }
  return value as number;
}

function normalizeEvidence(
  input: Pick<PaymentChargeBundleInputV1, "status" | "method" | "evidence">,
  eventIdentity: {
    idempotencyKey: string;
    orderId: string;
    currencyCode: string;
    amountMinor: number;
    sourceOccurredAt: string;
  },
): NormalizedPaymentChargeBundleV1["evidence"] {
  if (input.status !== "pending" && input.status !== "posted") {
    throw new PaymentChargeBundleValidationErrorV1("charge status is invalid");
  }
  if (input.status === "pending") {
    if (input.evidence !== undefined) {
      throw new PaymentChargeBundleValidationErrorV1("pending charge cannot claim evidence");
    }
    const parsed = PaymentCashEventV1Schema.safeParse({
      schemaVersion: 1,
      eventId: eventIdentity.idempotencyKey,
      idempotencyKey: eventIdentity.idempotencyKey,
      orderId: eventIdentity.orderId,
      method: input.method,
      kind: "charge",
      status: "pending",
      currencyCode: eventIdentity.currencyCode,
      amountMinor: eventIdentity.amountMinor,
      eventAt: eventIdentity.sourceOccurredAt,
    });
    if (!parsed.success) {
      throw new PaymentChargeBundleValidationErrorV1("pending charge contract is invalid");
    }
    return null;
  }

  if (!input.evidence) {
    throw new PaymentChargeBundleValidationErrorV1("posted charge evidence is required");
  }
  const evidenceType = requiredToken(input.evidence.evidenceType, "evidenceType") as EvidenceTypeV1;
  const evidenceFingerprint = requiredToken(
    input.evidence.evidenceFingerprint,
    "evidenceFingerprint",
  );
  if (!/^[a-f0-9]{64}$/.test(evidenceFingerprint)) {
    throw new PaymentChargeBundleValidationErrorV1("evidence fingerprint is invalid");
  }
  const sourceSystem = requiredToken(input.evidence.sourceSystem, "evidence sourceSystem");
  const sourceReference = requiredToken(
    input.evidence.sourceReference,
    "evidence sourceReference",
  );
  const parsed = PaymentCashEventV1Schema.safeParse({
    schemaVersion: 1,
    eventId: eventIdentity.idempotencyKey,
    idempotencyKey: eventIdentity.idempotencyKey,
    orderId: eventIdentity.orderId,
    method: input.method,
    kind: "charge",
    status: "posted",
    evidenceType,
    currencyCode: eventIdentity.currencyCode,
    amountMinor: eventIdentity.amountMinor,
    eventAt: eventIdentity.sourceOccurredAt,
  });
  if (!parsed.success) {
    throw new PaymentChargeBundleValidationErrorV1("posted charge evidence is invalid");
  }
  return {
    evidenceType,
    evidenceFingerprint,
    sourceSystem,
    sourceReference,
    verificationStatus: "verified",
    sourceOccurredAt: eventIdentity.sourceOccurredAt,
    evidencePayload: normalizeEvidencePayload(input.evidence.evidencePayload),
  };
}

function fingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeBundle(input: PaymentChargeBundleInputV1): NormalizedPaymentChargeBundleV1;
function normalizeBundle(input: PaymentChargeBundleInputV2, version: 2): NormalizedPaymentChargeBundleV2;
function normalizeBundle(input: PaymentChargeBundleInputV1 | PaymentChargeBundleInputV2, version: 1 | 2 = 1) {
  const merchantId = requiredToken(input.merchantId, "merchantId");
  const storeId = requiredToken(input.storeId, "storeId");
  const orderId = requiredToken(input.orderId, "orderId");
  const commercialRevisionId = requiredToken(
    input.commercialRevisionId,
    "commercialRevisionId",
  );
  const commercialRevision = normalizeRevision(input.commercialRevision);
  const { currencyCode, minorUnitExponent } = normalizeCurrency(input);
  const components = version === 1 ? normalizeComponents(input.components) : OrderCommercialComponentsV2Schema.parse(input.components);
  if (components.totalMinor <= 0) throw new PaymentChargeBundleValidationErrorV1("charge components are invalid");
  const idempotencyKey = requiredToken(input.idempotencyKey, "idempotencyKey");
  const sourceType = requiredToken(input.sourceType, "sourceType");
  if (sourceType !== "order_created") {
    throw new PaymentChargeBundleValidationErrorV1(
      "PAY-01A supports order-created charge bundles only",
    );
  }
  const sourceId = requiredToken(input.sourceId, "sourceId");
  const sourceOccurredAt = canonicalInstant(input.sourceOccurredAt, "sourceOccurredAt");
  const eventIdentity = {
    idempotencyKey,
    orderId,
    currencyCode,
    amountMinor: components.totalMinor,
    sourceOccurredAt,
  };
  const evidence = normalizeEvidence(input, eventIdentity);
  const body = {
    bundleVersion: version,
    merchantId,
    storeId,
    orderId,
    commercialRevisionId,
    commercialRevision,
    currencyCode,
    minorUnitExponent,
    sourceType,
    sourceId,
    sourceOccurredAt,
    components,
    obligation: {
      obligationKind: "order_charge" as const,
      amountMinor: components.totalMinor,
      idempotencyKey: `${idempotencyKey}:obligation`,
    },
    event: {
      kind: "charge" as const,
      status: input.status,
      method: input.method,
      evidenceType: evidence?.evidenceType ?? null,
      evidenceFingerprint: evidence?.evidenceFingerprint ?? null,
      amountMinor: components.totalMinor,
      idempotencyKey,
    },
    evidence,
    componentAllocation: { ...components },
    allocation: input.status === "posted"
      ? {
          allocationKind: "collection" as const,
          amountMinor: components.totalMinor,
          idempotencyKey: `${idempotencyKey}:allocation`,
          allocatedAt: sourceOccurredAt,
        }
      : null,
  };
  return {
    ...body,
    bundleFingerprint: fingerprint(body),
  };
}

export function assertNormalizedPaymentChargeBundleV1(
  value: NormalizedPaymentChargeBundleV1,
): NormalizedPaymentChargeBundleV1 {
  let expected: NormalizedPaymentChargeBundleV1;
  try {
    expected = normalizeBundle({
      merchantId: value.merchantId,
      storeId: value.storeId,
      orderId: value.orderId,
      commercialRevisionId: value.commercialRevisionId,
      commercialRevision: value.commercialRevision,
      currencyCode: value.currencyCode,
      minorUnitExponent: value.minorUnitExponent,
      method: value.event.method,
      status: value.event.status,
      components: value.components,
      evidence: value.evidence ?? undefined,
      idempotencyKey: value.event.idempotencyKey,
      sourceType: value.sourceType,
      sourceId: value.sourceId,
      sourceOccurredAt: value.sourceOccurredAt,
    });
  } catch (error) {
    throw new PaymentChargeBundleIntegrityErrorV1(
      `normalized charge bundle is invalid: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  if (JSON.stringify(expected) !== JSON.stringify(value)) {
    throw new PaymentChargeBundleIntegrityErrorV1("normalized charge bundle identity drift");
  }
  return expected;
}

function persistedToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new PaymentChargeBundleIntegrityErrorV1(`${field} is invalid`);
  }
  return value;
}

function validatePersisted(
  value: PersistedPaymentChargeBundleV1,
  bundle: NormalizedPaymentChargeBundleV1 | NormalizedPaymentChargeBundleV2,
): PersistedPaymentChargeBundleV1 {
  if (
    !value
    || (value.outcome !== "inserted" && value.outcome !== "replayed")
    || value.bundleFingerprint !== bundle.bundleFingerprint
    || value.merchantId !== bundle.merchantId
    || value.storeId !== bundle.storeId
    || value.orderId !== bundle.orderId
    || value.commercialRevisionId !== bundle.commercialRevisionId
    || value.eventIdempotencyKey !== bundle.event.idempotencyKey
  ) {
    throw new PaymentChargeBundleIntegrityErrorV1("persisted charge bundle identity drift");
  }
  return {
    ...value,
    obligationId: persistedToken(value.obligationId, "obligationId"),
    paymentEventId: persistedToken(value.paymentEventId, "paymentEventId"),
  };
}

export function createPaymentChargeBundleTaskV1(
  dependencies: PaymentChargeBundleDependenciesV1,
  input: PaymentChargeBundleInputV1,
): PaymentChargeBundleTaskV1 {
  if (dependencies?.config?.enabled !== true) {
    return { enabled: false, status: "disabled" };
  }
  if (typeof dependencies.repository?.appendChargeBundle !== "function") {
    throw new PaymentChargeBundleValidationErrorV1("charge repository is unavailable");
  }
  const bundle = normalizeBundle(input);
  return {
    enabled: true,
    bundleFingerprint: bundle.bundleFingerprint,
    execute: async () => {
      const persisted = validatePersisted(
        await dependencies.repository.appendChargeBundle(structuredClone(bundle)),
        bundle,
      );
      return {
        kind: "recorded",
        outcome: persisted.outcome,
        obligationId: persisted.obligationId,
        paymentEventId: persisted.paymentEventId,
        amountMinor: bundle.event.amountMinor,
        status: bundle.event.status,
        method: bundle.event.method,
      };
    },
  };
}

export function assertNormalizedPaymentChargeBundleV2(value: NormalizedPaymentChargeBundleV2): NormalizedPaymentChargeBundleV2 {
  const expected = normalizeBundle({ merchantId: value.merchantId, storeId: value.storeId, orderId: value.orderId,
    commercialRevisionId: value.commercialRevisionId, commercialRevision: value.commercialRevision,
    currencyCode: value.currencyCode, minorUnitExponent: value.minorUnitExponent,
    method: value.event.method, status: value.event.status, components: value.components,
    evidence: value.evidence ?? undefined, idempotencyKey: value.event.idempotencyKey,
    sourceType: value.sourceType, sourceId: value.sourceId, sourceOccurredAt: value.sourceOccurredAt,
  }, 2);
  if (JSON.stringify(expected) !== JSON.stringify(value)) {
    throw new PaymentChargeBundleIntegrityErrorV1("normalized charge bundle identity drift");
  }
  return expected;
}

export function createPaymentChargeBundleTaskV2(
  dependencies: { repository: PaymentChargeBundleRepositoryV2; config?: { enabled: boolean } },
  input: PaymentChargeBundleInputV2,
): PaymentChargeBundleTaskV1 {
  if (dependencies?.config?.enabled !== true) return { enabled: false, status: "disabled" };
  if (typeof dependencies.repository?.appendChargeBundle !== "function") {
    throw new PaymentChargeBundleValidationErrorV1("charge repository is unavailable");
  }
  const bundle = normalizeBundle(input, 2);
  return { enabled: true, bundleFingerprint: bundle.bundleFingerprint, execute: async () => {
    const persisted = validatePersisted(await dependencies.repository.appendChargeBundle(structuredClone(bundle)), bundle);
    return { kind: "recorded", outcome: persisted.outcome, obligationId: persisted.obligationId,
      paymentEventId: persisted.paymentEventId, amountMinor: bundle.event.amountMinor,
      status: bundle.event.status, method: bundle.event.method };
  } };
}
