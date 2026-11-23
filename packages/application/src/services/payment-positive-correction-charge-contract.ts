import { createHash } from "node:crypto";
import {
  OrderCommercialComponentsV1Schema,
  OrderCommercialComponentsV2Schema,
  SUPPORTED_CURRENCY_REGISTRY_V1,
  type OrderCommercialComponentsV1,
  type OrderCommercialComponentsV2,
} from "@medusa-snus/contracts";

export interface PositiveCorrectionChargeContractInputV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  correctionId: string;
  baseCommercialRevisionId: string;
  baseCommercialRevision: number;
  effectiveCommercialRevisionId: string;
  effectiveCommercialRevision: number;
  currencyCode: string;
  minorUnitExponent: number;
  sourceOccurredAt: string;
  beforeComponents: OrderCommercialComponentsV1;
  effectiveComponents: OrderCommercialComponentsV1;
}

export interface SignedPositiveCorrectionComponentDeltaV1 {
  taxMode: "inclusive" | "exclusive";
  merchandiseGrossMinor: number;
  discountMinor: number;
  merchandiseNetMinor: number;
  shippingMinor: number;
  merchandiseVatMinor: number;
  shippingVatMinor: number;
  vatMinor: number;
  vatIncludedInPriceMinor: number;
  vatAddedToPriceMinor: number;
  unclassifiedMinor: number;
  totalMinor: number;
}

export interface PositiveCorrectionChargeContractV1 {
  schemaVersion: 1;
  contractFingerprint: string;
  sourceType: "order_correction";
  sourceId: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  correctionId: string;
  baseCommercialRevisionId: string;
  baseCommercialRevision: number;
  effectiveCommercialRevisionId: string;
  effectiveCommercialRevision: number;
  currencyCode: string;
  minorUnitExponent: number;
  sourceOccurredAt: string;
  roundingPolicy: "persisted_minor_snapshot_difference_no_recalculation";
  beforeComponentsFingerprint: string;
  effectiveComponentsFingerprint: string;
  beforeComponents: OrderCommercialComponentsV1;
  effectiveComponents: OrderCommercialComponentsV1;
  componentDelta: SignedPositiveCorrectionComponentDeltaV1;
  collectionAllocation: {
    obligationKind: "order_correction_charge";
    allocationKind: "collection";
    amountMinor: number;
    componentAttribution: "signed_commercial_delta";
    obligationIdempotencyKey: string;
    eventIdempotencyKey: string;
    allocationIdempotencyKey: string;
  };
}

export type PositiveCorrectionChargeContractInputV2 = Omit<
  PositiveCorrectionChargeContractInputV1,
  "beforeComponents" | "effectiveComponents"
> & {
  beforeComponents: OrderCommercialComponentsV2;
  effectiveComponents: OrderCommercialComponentsV2;
};
export type SignedPositiveCorrectionComponentDeltaV2 =
  SignedPositiveCorrectionComponentDeltaV1 & {
    paymentFeeMinor: number;
    paymentFeeVatMinor: number;
  };
export type PositiveCorrectionChargeContractV2 = Omit<
  PositiveCorrectionChargeContractV1,
  | "schemaVersion"
  | "beforeComponents"
  | "effectiveComponents"
  | "componentDelta"
> & {
  schemaVersion: 2;
  beforeComponents: OrderCommercialComponentsV2;
  effectiveComponents: OrderCommercialComponentsV2;
  componentDelta: SignedPositiveCorrectionComponentDeltaV2;
};

export class PositiveCorrectionChargeContractValidationErrorV1 extends Error {
  readonly code = "positive_correction_charge_contract_invalid";

  constructor(message: string) {
    super(message);
    this.name = "PositiveCorrectionChargeContractValidationErrorV1";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function token(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      `${field} is invalid`,
    );
  }
  return value;
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      `${field} is invalid`,
    );
  }
  return Number(value);
}

function canonicalInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      "source occurrence is invalid",
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      "source occurrence is invalid",
    );
  }
  return value;
}

function components(
  value: unknown,
  field: string,
): OrderCommercialComponentsV1 {
  const parsed = OrderCommercialComponentsV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      `${field} is invalid`,
    );
  }
  return parsed.data;
}

function signedDifference(
  after: number,
  before: number,
  field: string,
): number {
  const result = after - before;
  if (!Number.isSafeInteger(result)) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      `${field} overflows`,
    );
  }
  return result;
}

function safeSum(values: number[], field: string): number {
  let result = 0;
  for (const value of values) {
    result += value;
    if (!Number.isSafeInteger(result)) {
      throw new PositiveCorrectionChargeContractValidationErrorV1(
        `${field} overflows`,
      );
    }
  }
  return result;
}

function buildDelta(
  before: OrderCommercialComponentsV1 | OrderCommercialComponentsV2,
  effective: OrderCommercialComponentsV1 | OrderCommercialComponentsV2,
  version: 1 | 2 = 1,
):
  | SignedPositiveCorrectionComponentDeltaV1
  | SignedPositiveCorrectionComponentDeltaV2 {
  if (before.taxMode !== effective.taxMode) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      "tax mode transition requires a separately approved tax contract",
    );
  }
  const taxMode = before.taxMode;
  const merchandiseGrossMinor = signedDifference(
    effective.merchandiseGrossMinor,
    before.merchandiseGrossMinor,
    "merchandise gross delta",
  );
  const discountMinor = signedDifference(
    effective.discountMinor,
    before.discountMinor,
    "discount delta",
  );
  const merchandiseNetMinor = signedDifference(
    effective.merchandiseNetMinor,
    before.merchandiseNetMinor,
    "merchandise net delta",
  );
  const shippingMinor = signedDifference(
    effective.shippingMinor,
    before.shippingMinor,
    "shipping delta",
  );
  const merchandiseVatMinor = signedDifference(
    effective.merchandiseVatMinor,
    before.merchandiseVatMinor,
    "merchandise VAT delta",
  );
  const shippingVatMinor = signedDifference(
    effective.shippingVatMinor,
    before.shippingVatMinor,
    "shipping VAT delta",
  );
  const vatMinor = signedDifference(
    effective.vatMinor,
    before.vatMinor,
    "VAT delta",
  );
  const unclassifiedMinor = signedDifference(
    effective.unclassifiedMinor,
    before.unclassifiedMinor,
    "unclassified delta",
  );
  const totalMinor = signedDifference(
    effective.totalMinor,
    before.totalMinor,
    "total delta",
  );
  const feeBefore =
    version === 2 ? OrderCommercialComponentsV2Schema.parse(before) : null;
  const feeAfter =
    version === 2 ? OrderCommercialComponentsV2Schema.parse(effective) : null;
  const paymentFeeMinor =
    feeBefore && feeAfter
      ? signedDifference(
          feeAfter.paymentFeeMinor,
          feeBefore.paymentFeeMinor,
          "payment fee delta",
        )
      : 0;
  const paymentFeeVatMinor =
    feeBefore && feeAfter
      ? signedDifference(
          feeAfter.paymentFeeVatMinor,
          feeBefore.paymentFeeVatMinor,
          "payment fee VAT delta",
        )
      : 0;

  if (
    signedDifference(
      merchandiseGrossMinor,
      discountMinor,
      "merchandise net delta",
    ) !== merchandiseNetMinor
  ) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      "merchandise delta arithmetic is invalid",
    );
  }
  if (
    safeSum(
      [
        merchandiseVatMinor,
        shippingVatMinor,
        ...(version === 2 ? [paymentFeeVatMinor] : []),
      ],
      "VAT delta",
    ) !== vatMinor
  ) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      "VAT delta arithmetic is invalid",
    );
  }
  if (
    safeSum(
      [
        merchandiseNetMinor,
        shippingMinor,
        unclassifiedMinor,
        taxMode === "exclusive" ? vatMinor : 0,
        ...(version === 2 ? [paymentFeeMinor] : []),
      ],
      "total delta",
    ) !== totalMinor
  ) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      "charged component delta does not equal the correction headline",
    );
  }
  if (totalMinor <= 0) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      "positive correction charge requires a positive headline",
    );
  }

  return {
    taxMode,
    merchandiseGrossMinor,
    discountMinor,
    merchandiseNetMinor,
    shippingMinor,
    merchandiseVatMinor,
    shippingVatMinor,
    vatMinor,
    vatIncludedInPriceMinor: taxMode === "inclusive" ? vatMinor : 0,
    vatAddedToPriceMinor: taxMode === "exclusive" ? vatMinor : 0,
    unclassifiedMinor,
    totalMinor,
    ...(version === 2 ? { paymentFeeMinor, paymentFeeVatMinor } : {}),
  };
}

function buildPositiveContract(
  input: PositiveCorrectionChargeContractInputV1,
  version: 1,
): PositiveCorrectionChargeContractV1;
function buildPositiveContract(
  input: PositiveCorrectionChargeContractInputV2,
  version: 2,
): PositiveCorrectionChargeContractV2;
function buildPositiveContract(
  input:
    | PositiveCorrectionChargeContractInputV1
    | PositiveCorrectionChargeContractInputV2,
  version: 1 | 2,
): PositiveCorrectionChargeContractV1 | PositiveCorrectionChargeContractV2 {
  const merchantId = token(input.merchantId, "merchant id");
  const storeId = token(input.storeId, "store id");
  const orderId = token(input.orderId, "order id");
  const correctionId = token(input.correctionId, "correction id");
  const baseCommercialRevisionId = token(
    input.baseCommercialRevisionId,
    "base commercial revision id",
  );
  const effectiveCommercialRevisionId = token(
    input.effectiveCommercialRevisionId,
    "effective commercial revision id",
  );
  if (baseCommercialRevisionId === effectiveCommercialRevisionId) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      "commercial revision identities must differ",
    );
  }
  const baseCommercialRevision = revision(
    input.baseCommercialRevision,
    "base commercial revision",
  );
  const effectiveCommercialRevision = revision(
    input.effectiveCommercialRevision,
    "effective commercial revision",
  );
  if (effectiveCommercialRevision !== baseCommercialRevision + 1) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      "positive correction requires the next commercial revision",
    );
  }
  const currency = SUPPORTED_CURRENCY_REGISTRY_V1.find(
    (item) => item.currencyCode === input.currencyCode,
  );
  if (
    !currency ||
    !currency.writeSupported ||
    input.minorUnitExponent !== currency.minorUnitExponent
  ) {
    throw new PositiveCorrectionChargeContractValidationErrorV1(
      "correction currency is unsupported",
    );
  }
  const sourceOccurredAt = canonicalInstant(input.sourceOccurredAt);
  const beforeComponents =
    version === 2
      ? OrderCommercialComponentsV2Schema.parse(input.beforeComponents)
      : components(input.beforeComponents, "before components");
  const effectiveComponents =
    version === 2
      ? OrderCommercialComponentsV2Schema.parse(input.effectiveComponents)
      : components(input.effectiveComponents, "effective components");
  const componentDelta = buildDelta(
    beforeComponents,
    effectiveComponents,
    version,
  );

  const valueWithoutFingerprint = {
    schemaVersion: version,
    sourceType: "order_correction" as const,
    sourceId: correctionId,
    merchantId,
    storeId,
    orderId,
    correctionId,
    baseCommercialRevisionId,
    baseCommercialRevision,
    effectiveCommercialRevisionId,
    effectiveCommercialRevision,
    currencyCode: currency.currencyCode,
    minorUnitExponent: currency.minorUnitExponent,
    sourceOccurredAt,
    roundingPolicy:
      "persisted_minor_snapshot_difference_no_recalculation" as const,
    beforeComponentsFingerprint: sha256(beforeComponents),
    effectiveComponentsFingerprint: sha256(effectiveComponents),
    beforeComponents,
    effectiveComponents,
    componentDelta,
    collectionAllocation: {
      obligationKind: "order_correction_charge" as const,
      allocationKind: "collection" as const,
      amountMinor: componentDelta.totalMinor,
      componentAttribution: "signed_commercial_delta" as const,
      obligationIdempotencyKey: `payment:${orderId}:correction:${correctionId}:obligation`,
      eventIdempotencyKey: `payment:${orderId}:correction:${correctionId}:charge`,
      allocationIdempotencyKey: `payment:${orderId}:correction:${correctionId}:allocation`,
    },
  };

  return {
    ...valueWithoutFingerprint,
    contractFingerprint: sha256(valueWithoutFingerprint),
  } as PositiveCorrectionChargeContractV1 | PositiveCorrectionChargeContractV2;
}

export function buildPositiveCorrectionChargeContractV1(
  input: PositiveCorrectionChargeContractInputV1,
): PositiveCorrectionChargeContractV1 {
  return buildPositiveContract(input, 1);
}

export function buildPositiveCorrectionChargeContractV2(
  input: PositiveCorrectionChargeContractInputV2,
): PositiveCorrectionChargeContractV2 {
  return buildPositiveContract(input, 2);
}
