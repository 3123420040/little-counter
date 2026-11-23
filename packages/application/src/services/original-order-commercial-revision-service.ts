import { createHash } from "node:crypto";
import {
  OrderCommercialComponentsV1Schema,
  OrderCommercialComponentsV2Schema,
  type OrderCommercialComponentsV1,
  type OrderCommercialComponentsV2,
  type PaymentFeeInputV1,
} from "@medusa-snus/contracts";
import { calculateVatMinor, resolvePaymentFee } from "./payment-fee-calculation";

export const ORIGINAL_ORDER_COMMERCIAL_REVISION_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: false,
});

export interface OriginalOrderCommercialLineInputV1 {
  lineKey: string;
  sourceLineId: string;
  productId: string | null;
  variantId: string | null;
  skuSnapshot: string;
  titleSnapshot: string;
  archivedVariant: boolean;
  quantity: number;
  unitPriceMinor: number;
  unitCostMinor: number | null;
  costEvidenceId: string | null;
}

export interface OriginalOrderCommercialTotalsInputV1 {
  taxMode: "inclusive" | "exclusive";
  vatRatePpm: number;
  commercialCalculationVersion: 1;
  subtotalMinor: number;
  discountMinor: number;
  merchandisePayableMinor: number;
  shippingMinor: number;
  merchandiseVatMinor: number;
  shippingVatMinor: number;
  vatMinor: number;
  unclassifiedMinor: number;
  totalMinor: number;
}

export interface OriginalOrderCommercialRevisionInputV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  orderCreatedInCurrentTransaction: true;
  currencyCode: "VND";
  minorUnitExponent: 0;
  sourceOccurredAt: string;
  totals: OriginalOrderCommercialTotalsInputV1;
  lines: OriginalOrderCommercialLineInputV1[];
}

export interface NormalizedOriginalOrderCommercialLineV1
  extends OriginalOrderCommercialLineInputV1 {
  lineTotalMinor: number;
}

export interface NormalizedOriginalOrderCommercialRevisionV1 {
  bundleVersion: 1;
  bundleFingerprint: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  revision: 0;
  sourceType: "original_order";
  sourceId: string;
  commercialState: "active";
  currencyCode: "VND";
  minorUnitExponent: 0;
  sourceOccurredAt: string;
  idempotencyKey: string;
  dataQuality: "complete" | "partial";
  vatRatePpm: number;
  commercialCalculationVersion: 1;
  roundingPolicy: "nearest_minor_half_toward_positive_infinity";
  components: OrderCommercialComponentsV1;
  lines: NormalizedOriginalOrderCommercialLineV1[];
}

export interface PersistedOriginalOrderCommercialRevisionV1 {
  outcome: "inserted" | "replayed";
  bundleFingerprint: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  revisionId: string;
  revision: 0;
  idempotencyKey: string;
}

export interface OriginalOrderCommercialRevisionRepositoryV1 {
  appendOriginalRevision(
    bundle: NormalizedOriginalOrderCommercialRevisionV1,
  ): Promise<PersistedOriginalOrderCommercialRevisionV1>;
}

export interface OriginalOrderCommercialRevisionDependenciesV1 {
  config?: { enabled: boolean };
  repository: OriginalOrderCommercialRevisionRepositoryV1;
}

export type OriginalOrderCommercialRevisionTaskV1 =
  | { enabled: false; status: "disabled" }
  | {
      enabled: true;
      bundle: NormalizedOriginalOrderCommercialRevisionV1;
      execute(): Promise<PersistedOriginalOrderCommercialRevisionV1>;
    };

export class OriginalOrderCommercialRevisionValidationErrorV1 extends Error {
  readonly code = "original_order_commercial_revision_invalid";

  constructor(message: string) {
    super(message);
    this.name = "OriginalOrderCommercialRevisionValidationErrorV1";
  }
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(`${field} is invalid`);
  }
  return value;
}

function nullableToken(value: unknown, field: string): string | null {
  if (value === null) return null;
  return token(value, field);
}

function minor(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(`${field} is invalid`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = minor(value, field);
  if (parsed < 1) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(`${field} is invalid`);
  }
  return parsed;
}

function instant(value: unknown): string {
  if (typeof value !== "string") {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(
      "source occurrence is invalid",
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(
      "source occurrence is invalid",
    );
  }
  return value;
}

function safeAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(`${field} overflows`);
  }
  return result;
}

function lineCost(
  unitCostMinor: unknown,
  costEvidenceId: unknown,
): Pick<OriginalOrderCommercialLineInputV1, "unitCostMinor" | "costEvidenceId"> {
  const costIsMissing = unitCostMinor === null;
  const evidenceIsMissing = costEvidenceId === null;
  if (costIsMissing !== evidenceIsMissing) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(
      "line cost and evidence must both be present or both be null",
    );
  }
  if (costIsMissing) {
    return { unitCostMinor: null, costEvidenceId: null };
  }
  return {
    unitCostMinor: minor(unitCostMinor, "line unit cost"),
    costEvidenceId: token(costEvidenceId, "cost evidence id"),
  };
}

function normalizeInput(
  input: OriginalOrderCommercialRevisionInputV1,
): Omit<NormalizedOriginalOrderCommercialRevisionV1, "bundleFingerprint"> {
  if (input.orderCreatedInCurrentTransaction !== true) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(
      "original revision requires the order-create transaction",
    );
  }
  if (input.currencyCode !== "VND" || input.minorUnitExponent !== 0) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(
      "original revision requires whole-minor VND",
    );
  }
  const merchantId = token(input.merchantId, "merchant id");
  const storeId = token(input.storeId, "store id");
  const orderId = token(input.orderId, "order id");
  const sourceOccurredAt = instant(input.sourceOccurredAt);
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(
      "original revision requires at least one line",
    );
  }
  const lineKeys = new Set<string>();
  let lineGrossMinor = 0;
  const lines = input.lines.map((line) => {
    const lineKey = token(line.lineKey, "line key");
    if (lineKeys.has(lineKey)) {
      throw new OriginalOrderCommercialRevisionValidationErrorV1("line key is duplicated");
    }
    lineKeys.add(lineKey);
    const quantity = positiveInteger(line.quantity, "line quantity");
    const unitPriceMinor = minor(line.unitPriceMinor, "line unit price");
    const lineTotalMinor = quantity * unitPriceMinor;
    if (!Number.isSafeInteger(lineTotalMinor)) {
      throw new OriginalOrderCommercialRevisionValidationErrorV1("line total overflows");
    }
    lineGrossMinor = safeAdd(lineGrossMinor, lineTotalMinor, "line gross");
    return {
      lineKey,
      sourceLineId: token(line.sourceLineId, "source line id"),
      productId: nullableToken(line.productId, "product id"),
      variantId: nullableToken(line.variantId, "variant id"),
      skuSnapshot: token(line.skuSnapshot, "SKU snapshot"),
      titleSnapshot: token(line.titleSnapshot, "title snapshot"),
      archivedVariant: line.archivedVariant === true,
      quantity,
      unitPriceMinor,
      lineTotalMinor,
      ...lineCost(line.unitCostMinor, line.costEvidenceId),
    };
  }).sort((left, right) => left.lineKey.localeCompare(right.lineKey));
  const dataQuality = lines.some((line) => line.unitCostMinor === null)
    ? "partial"
    : "complete";

  const totals = input.totals;
  if (!totals || (totals.taxMode !== "inclusive" && totals.taxMode !== "exclusive")) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1("tax mode is invalid");
  }
  const vatRatePpm = minor(totals.vatRatePpm, "VAT rate ppm");
  if (vatRatePpm > 1_000_000 || totals.commercialCalculationVersion !== 1) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(
      "commercial calculation policy is invalid",
    );
  }
  const components = OrderCommercialComponentsV1Schema.safeParse({
    taxMode: totals.taxMode,
    merchandiseGrossMinor: minor(totals.subtotalMinor, "subtotal"),
    discountMinor: minor(totals.discountMinor, "discount"),
    merchandiseNetMinor: minor(totals.merchandisePayableMinor, "merchandise payable"),
    shippingMinor: minor(totals.shippingMinor, "shipping"),
    merchandiseVatMinor: minor(totals.merchandiseVatMinor, "merchandise VAT"),
    shippingVatMinor: minor(totals.shippingVatMinor, "shipping VAT"),
    vatMinor: minor(totals.vatMinor, "VAT"),
    unclassifiedMinor: minor(totals.unclassifiedMinor, "unclassified"),
    totalMinor: minor(totals.totalMinor, "total"),
  });
  if (!components.success) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(
      "commercial components are invalid",
    );
  }
  if (lineGrossMinor !== components.data.merchandiseGrossMinor) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(
      "line gross differs from commercial subtotal",
    );
  }

  return {
    bundleVersion: 1,
    merchantId,
    storeId,
    orderId,
    revision: 0,
    sourceType: "original_order",
    sourceId: orderId,
    commercialState: "active",
    currencyCode: "VND",
    minorUnitExponent: 0,
    sourceOccurredAt,
    idempotencyKey: `order:${orderId}:commercial-revision:0`,
    dataQuality,
    vatRatePpm,
    commercialCalculationVersion: 1,
    roundingPolicy: "nearest_minor_half_toward_positive_infinity",
    components: components.data,
    lines,
  };
}

function fingerprint(
  value: Omit<NormalizedOriginalOrderCommercialRevisionV1, "bundleFingerprint">,
): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertNormalizedOriginalOrderCommercialRevisionV1(
  value: NormalizedOriginalOrderCommercialRevisionV1,
): NormalizedOriginalOrderCommercialRevisionV1 {
  const normalized = normalizeInput({
    merchantId: value.merchantId,
    storeId: value.storeId,
    orderId: value.orderId,
    orderCreatedInCurrentTransaction: true,
    currencyCode: value.currencyCode,
    minorUnitExponent: value.minorUnitExponent,
    sourceOccurredAt: value.sourceOccurredAt,
    totals: {
      taxMode: value.components.taxMode,
      vatRatePpm: value.vatRatePpm,
      commercialCalculationVersion: value.commercialCalculationVersion,
      subtotalMinor: value.components.merchandiseGrossMinor,
      discountMinor: value.components.discountMinor,
      merchandisePayableMinor: value.components.merchandiseNetMinor,
      shippingMinor: value.components.shippingMinor,
      merchandiseVatMinor: value.components.merchandiseVatMinor,
      shippingVatMinor: value.components.shippingVatMinor,
      vatMinor: value.components.vatMinor,
      unclassifiedMinor: value.components.unclassifiedMinor,
      totalMinor: value.components.totalMinor,
    },
    lines: value.lines.map((line) => ({ ...line })),
  });
  if (
    value.bundleVersion !== 1
    || value.revision !== 0
    || value.sourceType !== "original_order"
    || value.sourceId !== normalized.sourceId
    || value.commercialState !== "active"
    || value.idempotencyKey !== normalized.idempotencyKey
    || value.dataQuality !== normalized.dataQuality
    || value.roundingPolicy !== "nearest_minor_half_toward_positive_infinity"
    || value.bundleFingerprint !== fingerprint(normalized)
  ) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(
      "normalized original revision identity drift",
    );
  }
  return { ...structuredClone(normalized), bundleFingerprint: value.bundleFingerprint };
}

export function createOriginalOrderCommercialRevisionTaskV1(
  dependencies: OriginalOrderCommercialRevisionDependenciesV1,
  input: OriginalOrderCommercialRevisionInputV1,
): OriginalOrderCommercialRevisionTaskV1 {
  if (dependencies?.config?.enabled !== true) {
    return { enabled: false, status: "disabled" };
  }
  if (!dependencies.repository) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1(
      "original revision repository is required",
    );
  }
  const withoutFingerprint = normalizeInput(input);
  const bundle: NormalizedOriginalOrderCommercialRevisionV1 = {
    ...withoutFingerprint,
    bundleFingerprint: fingerprint(withoutFingerprint),
  };
  return {
    enabled: true,
    bundle: structuredClone(bundle),
    async execute() {
      const persisted = await dependencies.repository.appendOriginalRevision(
        structuredClone(bundle),
      );
      if (
        persisted.bundleFingerprint !== bundle.bundleFingerprint
        || persisted.merchantId !== bundle.merchantId
        || persisted.storeId !== bundle.storeId
        || persisted.orderId !== bundle.orderId
        || persisted.revision !== 0
        || persisted.idempotencyKey !== bundle.idempotencyKey
      ) {
        throw new OriginalOrderCommercialRevisionValidationErrorV1(
          "persisted original revision identity drift",
        );
      }
      return persisted;
    },
  };
}

export type OriginalOrderCommercialRevisionInputV2 = Omit<OriginalOrderCommercialRevisionInputV1, "totals"> & {
  totals: Omit<OriginalOrderCommercialTotalsInputV1, "commercialCalculationVersion"> & PaymentFeeInputV1 & {
    commercialCalculationVersion: 2;
    paymentFeeBasisMinor: number;
    paymentFeeMinor: number;
    paymentFeeVatMinor: number;
  };
};

export type NormalizedOriginalOrderCommercialRevisionV2 = Omit<NormalizedOriginalOrderCommercialRevisionV1,
  "bundleVersion" | "commercialCalculationVersion" | "components"> & {
  bundleVersion: 2;
  commercialCalculationVersion: 2;
  components: OrderCommercialComponentsV2;
  paymentFee: PaymentFeeInputV1 & { paymentFeeBasisMinor: number };
};

export interface OriginalOrderCommercialRevisionRepositoryV2 {
  appendOriginalRevision(bundle: NormalizedOriginalOrderCommercialRevisionV2): Promise<PersistedOriginalOrderCommercialRevisionV1>;
}

function normalizeInputV2(input: OriginalOrderCommercialRevisionInputV2): NormalizedOriginalOrderCommercialRevisionV2 {
  const totals = input.totals;
  if (totals?.commercialCalculationVersion !== 2) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1("V2 commercial calculation policy is required");
  }
  const fee = resolvePaymentFee(totals.merchandisePayableMinor, {
    paymentFeeType: totals.paymentFeeType, paymentFeeValue: totals.paymentFeeValue,
  }, { taxMode: totals.taxMode, vatRatePpm: totals.vatRatePpm });
  if (fee.paymentFeeBasisMinor !== totals.paymentFeeBasisMinor
    || fee.paymentFeeMinor !== totals.paymentFeeMinor || fee.paymentFeeVatMinor !== totals.paymentFeeVatMinor) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1("payment fee descriptor/basis/amount drift");
  }
  const taxContext = { taxMode: totals.taxMode, vatRatePpm: totals.vatRatePpm };
  if (calculateVatMinor(totals.merchandisePayableMinor, taxContext) !== totals.merchandiseVatMinor
    || calculateVatMinor(totals.shippingMinor, taxContext) !== totals.shippingVatMinor) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1("commercial VAT context drift");
  }
  // Reuse V1 line/scope validation on its fee-free component basis, never persist that intermediate.
  const base = normalizeInput({ ...input, totals: { ...totals, commercialCalculationVersion: 1,
    vatMinor: totals.vatMinor - fee.paymentFeeVatMinor,
    totalMinor: totals.totalMinor - fee.paymentFeeMinor - (totals.taxMode === "exclusive" ? fee.paymentFeeVatMinor : 0),
  } });
  const components = OrderCommercialComponentsV2Schema.parse({ ...base.components,
    paymentFeeMinor: fee.paymentFeeMinor, paymentFeeVatMinor: fee.paymentFeeVatMinor,
    vatMinor: totals.vatMinor, totalMinor: totals.totalMinor,
  });
  const body = { ...base, bundleVersion: 2 as const, commercialCalculationVersion: 2 as const, components,
    paymentFee: { paymentFeeType: fee.paymentFeeType, paymentFeeValue: fee.paymentFeeValue, paymentFeeBasisMinor: fee.paymentFeeBasisMinor },
  };
  return { ...body, bundleFingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

export function assertNormalizedOriginalOrderCommercialRevisionV2(
  value: NormalizedOriginalOrderCommercialRevisionV2,
): NormalizedOriginalOrderCommercialRevisionV2 {
  const normalized = normalizeInputV2({ merchantId: value.merchantId, storeId: value.storeId, orderId: value.orderId,
    orderCreatedInCurrentTransaction: true, currencyCode: value.currencyCode, minorUnitExponent: value.minorUnitExponent,
    sourceOccurredAt: value.sourceOccurredAt, lines: value.lines,
    totals: { taxMode: value.components.taxMode, vatRatePpm: value.vatRatePpm,
      commercialCalculationVersion: value.commercialCalculationVersion,
      subtotalMinor: value.components.merchandiseGrossMinor, discountMinor: value.components.discountMinor,
      merchandisePayableMinor: value.components.merchandiseNetMinor, shippingMinor: value.components.shippingMinor,
      merchandiseVatMinor: value.components.merchandiseVatMinor, shippingVatMinor: value.components.shippingVatMinor,
      vatMinor: value.components.vatMinor, unclassifiedMinor: value.components.unclassifiedMinor, totalMinor: value.components.totalMinor,
      ...value.paymentFee, paymentFeeMinor: value.components.paymentFeeMinor, paymentFeeVatMinor: value.components.paymentFeeVatMinor,
    },
  });
  if (JSON.stringify(normalized) !== JSON.stringify(value)) {
    throw new OriginalOrderCommercialRevisionValidationErrorV1("normalized V2 original revision identity drift");
  }
  return normalized;
}

export function createOriginalOrderCommercialRevisionTaskV2(
  dependencies: { config?: { enabled: boolean }; repository: OriginalOrderCommercialRevisionRepositoryV2 },
  input: OriginalOrderCommercialRevisionInputV2,
): { enabled: false; status: "disabled" } | {
  enabled: true; bundle: NormalizedOriginalOrderCommercialRevisionV2; execute(): Promise<PersistedOriginalOrderCommercialRevisionV1>;
} {
  if (dependencies?.config?.enabled !== true) return { enabled: false, status: "disabled" };
  if (!dependencies.repository) throw new OriginalOrderCommercialRevisionValidationErrorV1("original revision repository is required");
  const bundle = normalizeInputV2(input);
  return { enabled: true, bundle: structuredClone(bundle), async execute() {
    const persisted = await dependencies.repository.appendOriginalRevision(structuredClone(bundle));
    if (persisted.bundleFingerprint !== bundle.bundleFingerprint || persisted.merchantId !== bundle.merchantId
      || persisted.storeId !== bundle.storeId || persisted.orderId !== bundle.orderId
      || persisted.revision !== 0 || persisted.idempotencyKey !== bundle.idempotencyKey) {
      throw new OriginalOrderCommercialRevisionValidationErrorV1("persisted original revision identity drift");
    }
    return persisted;
  } };
}
