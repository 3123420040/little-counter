import { createHash } from "node:crypto";
import {
  OrderCommercialComponentsV1Schema,
  OrderCommercialComponentsV2Schema,
  type OrderCommercialComponentsV1,
  type OrderCommercialComponentsV2,
  type PaymentFeeInputV1,
} from "@medusa-snus/contracts";
import { calculateVatMinor, resolvePaymentFee, type PaymentFeeTaxContextV1 } from "./payment-fee-calculation";

export interface CorrectionCommercialTotalsInputV1 {
  subtotal: number;
  discount: number;
  merchandisePayable: number;
  shippingFee: number;
  merchandiseTax: number;
  shippingTax: number;
  tax: number;
  total: number;
}

export interface CorrectionCommercialLineInputV1 {
  variantId: string;
  productId: string;
  skuSnapshot: string;
  titleSnapshot: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface CorrectionCommercialRevisionInputV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  correctionId: string;
  revision: number;
  sourceOccurredAt: string;
  currencyCode: "VND";
  minorUnitExponent: 0;
  taxMode: "inclusive" | "exclusive";
  beforeTotals: CorrectionCommercialTotalsInputV1;
  afterTotals: CorrectionCommercialTotalsInputV1;
  lines: CorrectionCommercialLineInputV1[];
}

export interface NormalizedCorrectionCommercialLineV1
  extends CorrectionCommercialLineInputV1 {
  lineKey: string;
  lineTotalMinor: number;
}

export interface NormalizedCorrectionCommercialRevisionV1 {
  bundleVersion: 1;
  bundleFingerprint: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  correctionId: string;
  revision: number;
  sourceType: "order_correction";
  sourceId: string;
  commercialState: "active";
  currencyCode: "VND";
  minorUnitExponent: 0;
  sourceOccurredAt: string;
  idempotencyKey: string;
  dataQuality: "partial";
  baseComponents: OrderCommercialComponentsV1;
  components: OrderCommercialComponentsV1;
  lines: NormalizedCorrectionCommercialLineV1[];
}

export interface PersistedCorrectionCommercialRevisionV1 {
  outcome: "inserted" | "replayed";
  bundleFingerprint: string;
  merchantId: string;
  storeId: string;
  orderId: string;
  correctionId: string;
  revisionId: string;
  revision: number;
  idempotencyKey: string;
}

export interface CorrectionCommercialRevisionRepositoryV1 {
  appendCorrectionRevision(
    bundle: NormalizedCorrectionCommercialRevisionV1,
  ): Promise<PersistedCorrectionCommercialRevisionV1>;
}

export interface CorrectionCommercialRevisionDependenciesV1 {
  repository: CorrectionCommercialRevisionRepositoryV1;
}

export interface CorrectionCommercialRevisionTaskV1 {
  bundle: NormalizedCorrectionCommercialRevisionV1;
  execute(): Promise<PersistedCorrectionCommercialRevisionV1>;
}

export class CorrectionCommercialRevisionValidationErrorV1 extends Error {
  readonly code = "correction_commercial_revision_invalid";

  constructor(message: string) {
    super(message);
    this.name = "CorrectionCommercialRevisionValidationErrorV1";
  }
}

function invalid(message: string): never {
  throw new CorrectionCommercialRevisionValidationErrorV1(message);
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    invalid(`${field} is invalid`);
  }
  return value;
}

function minor(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(`${field} is invalid`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = minor(value, field);
  if (parsed < 1) invalid(`${field} is invalid`);
  return parsed;
}

function instant(value: unknown): string {
  if (typeof value !== "string") invalid("source occurrence is invalid");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid("source occurrence is invalid");
  }
  return value;
}

function components(
  value: CorrectionCommercialTotalsInputV1,
  taxMode: "inclusive" | "exclusive",
  field: string,
): OrderCommercialComponentsV1 {
  const parsed = OrderCommercialComponentsV1Schema.safeParse({
    taxMode,
    merchandiseGrossMinor: minor(value?.subtotal, `${field} subtotal`),
    discountMinor: minor(value?.discount, `${field} discount`),
    merchandiseNetMinor: minor(value?.merchandisePayable, `${field} merchandise payable`),
    shippingMinor: minor(value?.shippingFee, `${field} shipping`),
    merchandiseVatMinor: minor(value?.merchandiseTax, `${field} merchandise VAT`),
    shippingVatMinor: minor(value?.shippingTax, `${field} shipping VAT`),
    vatMinor: minor(value?.tax, `${field} VAT`),
    unclassifiedMinor: 0,
    totalMinor: minor(value?.total, `${field} total`),
  });
  if (!parsed.success) {
    invalid(`${field} commercial components are invalid`);
  }
  return parsed.data;
}

function normalized(
  input: CorrectionCommercialRevisionInputV1,
): Omit<NormalizedCorrectionCommercialRevisionV1, "bundleFingerprint"> {
  const merchantId = token(input?.merchantId, "merchant id");
  const storeId = token(input?.storeId, "store id");
  const orderId = token(input?.orderId, "order id");
  const correctionId = token(input?.correctionId, "correction id");
  const revision = positiveInteger(input?.revision, "revision");
  const sourceOccurredAt = instant(input?.sourceOccurredAt);
  if (input.currencyCode !== "VND" || input.minorUnitExponent !== 0) {
    invalid("correction revision supports only whole-minor VND");
  }
  if (input.taxMode !== "inclusive" && input.taxMode !== "exclusive") {
    invalid("tax mode is invalid");
  }
  const baseComponents = components(input.beforeTotals, input.taxMode, "before");
  const effectiveComponents = components(input.afterTotals, input.taxMode, "after");
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    invalid("correction revision requires at least one line");
  }
  const variants = new Set<string>();
  let gross = 0;
  const lines = input.lines.map((line) => {
    const variantId = token(line.variantId, "variant id");
    if (variants.has(variantId)) invalid("variant is duplicated");
    variants.add(variantId);
    const quantity = positiveInteger(line.quantity, "line quantity");
    const unitPriceMinor = minor(line.unitPriceMinor, "line unit price");
    const lineTotalMinor = quantity * unitPriceMinor;
    if (!Number.isSafeInteger(lineTotalMinor)) invalid("line total overflows");
    gross += lineTotalMinor;
    if (!Number.isSafeInteger(gross)) invalid("line gross overflows");
    return {
      lineKey: `variant:${variantId}`,
      variantId,
      productId: token(line.productId, "product id"),
      skuSnapshot: token(line.skuSnapshot, "SKU snapshot"),
      titleSnapshot: token(line.titleSnapshot, "title snapshot"),
      quantity,
      unitPriceMinor,
      lineTotalMinor,
    };
  }).sort((left, right) => left.lineKey.localeCompare(right.lineKey));
  if (gross !== effectiveComponents.merchandiseGrossMinor) {
    invalid("line gross differs from effective commercial subtotal");
  }
  return {
    bundleVersion: 1,
    merchantId,
    storeId,
    orderId,
    correctionId,
    revision,
    sourceType: "order_correction",
    sourceId: correctionId,
    commercialState: "active",
    currencyCode: "VND",
    minorUnitExponent: 0,
    sourceOccurredAt,
    idempotencyKey: `order:${orderId}:commercial-revision:${revision}:correction:${correctionId}`,
    dataQuality: "partial",
    baseComponents,
    components: effectiveComponents,
    lines,
  };
}

function fingerprint(
  value: Omit<NormalizedCorrectionCommercialRevisionV1, "bundleFingerprint">,
): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertNormalizedCorrectionCommercialRevisionV1(
  value: NormalizedCorrectionCommercialRevisionV1,
): NormalizedCorrectionCommercialRevisionV1 {
  const rebuilt = normalized({
    merchantId: value.merchantId,
    storeId: value.storeId,
    orderId: value.orderId,
    correctionId: value.correctionId,
    revision: value.revision,
    sourceOccurredAt: value.sourceOccurredAt,
    currencyCode: value.currencyCode,
    minorUnitExponent: value.minorUnitExponent,
    taxMode: value.components.taxMode,
    beforeTotals: {
      subtotal: value.baseComponents.merchandiseGrossMinor,
      discount: value.baseComponents.discountMinor,
      merchandisePayable: value.baseComponents.merchandiseNetMinor,
      shippingFee: value.baseComponents.shippingMinor,
      merchandiseTax: value.baseComponents.merchandiseVatMinor,
      shippingTax: value.baseComponents.shippingVatMinor,
      tax: value.baseComponents.vatMinor,
      total: value.baseComponents.totalMinor,
    },
    afterTotals: {
      subtotal: value.components.merchandiseGrossMinor,
      discount: value.components.discountMinor,
      merchandisePayable: value.components.merchandiseNetMinor,
      shippingFee: value.components.shippingMinor,
      merchandiseTax: value.components.merchandiseVatMinor,
      shippingTax: value.components.shippingVatMinor,
      tax: value.components.vatMinor,
      total: value.components.totalMinor,
    },
    lines: value.lines.map((line) => ({
      variantId: line.variantId,
      productId: line.productId,
      skuSnapshot: line.skuSnapshot,
      titleSnapshot: line.titleSnapshot,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
    })),
  });
  if (
    value.bundleVersion !== 1
    || value.sourceType !== "order_correction"
    || value.sourceId !== value.correctionId
    || value.commercialState !== "active"
    || value.idempotencyKey !== rebuilt.idempotencyKey
    || value.dataQuality !== "partial"
    || value.bundleFingerprint !== fingerprint(rebuilt)
  ) {
    invalid("normalized correction revision identity drift");
  }
  return { ...structuredClone(rebuilt), bundleFingerprint: value.bundleFingerprint };
}

export function createCorrectionCommercialRevisionTaskV1(
  dependencies: CorrectionCommercialRevisionDependenciesV1,
  input: CorrectionCommercialRevisionInputV1,
): CorrectionCommercialRevisionTaskV1 {
  if (!dependencies?.repository) invalid("correction revision repository is required");
  const value = normalized(structuredClone(input));
  const bundle: NormalizedCorrectionCommercialRevisionV1 = {
    ...value,
    bundleFingerprint: fingerprint(value),
  };
  return {
    bundle: structuredClone(bundle),
    execute: () => dependencies.repository.appendCorrectionRevision(
      assertNormalizedCorrectionCommercialRevisionV1(bundle),
    ),
  };
}

export type CorrectionCommercialTotalsInputV2 = CorrectionCommercialTotalsInputV1 & PaymentFeeInputV1 & {
  paymentFeeBasisMinor: number;
  paymentFeeMinor: number;
  paymentFeeVatMinor: number;
};
export type CorrectionCommercialRevisionInputV2 = Omit<CorrectionCommercialRevisionInputV1, "beforeTotals" | "afterTotals"> & {
  vatRatePpm: number;
  beforeTotals: CorrectionCommercialTotalsInputV2;
  afterTotals: CorrectionCommercialTotalsInputV2;
};
type FeeDescriptorSnapshot = PaymentFeeInputV1 & { paymentFeeBasisMinor: number };
export type NormalizedCorrectionCommercialRevisionV2 = Omit<NormalizedCorrectionCommercialRevisionV1,
  "bundleVersion" | "baseComponents" | "components"> & {
  bundleVersion: 2;
  commercialCalculationVersion: 2;
  vatRatePpm: number;
  baseComponents: OrderCommercialComponentsV2;
  components: OrderCommercialComponentsV2;
  basePaymentFee: FeeDescriptorSnapshot;
  paymentFee: FeeDescriptorSnapshot;
};
export interface CorrectionCommercialRevisionRepositoryV2 {
  appendCorrectionRevision(bundle: NormalizedCorrectionCommercialRevisionV2): Promise<PersistedCorrectionCommercialRevisionV1>;
}

function feeComponents(value: CorrectionCommercialTotalsInputV2, context: PaymentFeeTaxContextV1) {
  const fee = resolvePaymentFee(value?.merchandisePayable,
    { paymentFeeType: value?.paymentFeeType, paymentFeeValue: value?.paymentFeeValue }, context);
  if (fee.paymentFeeBasisMinor !== value.paymentFeeBasisMinor || fee.paymentFeeMinor !== value.paymentFeeMinor
    || fee.paymentFeeVatMinor !== value.paymentFeeVatMinor) invalid("payment fee descriptor/basis/amount drift");
  const snapshot = OrderCommercialComponentsV2Schema.parse({ taxMode: context.taxMode,
    merchandiseGrossMinor: value.subtotal, discountMinor: value.discount, merchandiseNetMinor: value.merchandisePayable,
    shippingMinor: value.shippingFee, merchandiseVatMinor: value.merchandiseTax, shippingVatMinor: value.shippingTax,
    vatMinor: value.tax, unclassifiedMinor: 0, totalMinor: value.total,
    paymentFeeMinor: fee.paymentFeeMinor, paymentFeeVatMinor: fee.paymentFeeVatMinor,
  });
  if (calculateVatMinor(value.merchandisePayable, context) !== value.merchandiseTax
    || calculateVatMinor(value.shippingFee, context) !== value.shippingTax) invalid("commercial VAT context drift");
  return { components: snapshot, fee: { paymentFeeType: fee.paymentFeeType,
    paymentFeeValue: fee.paymentFeeValue, paymentFeeBasisMinor: fee.paymentFeeBasisMinor },
    feeFreeTotals: { ...value, tax: value.tax - fee.paymentFeeVatMinor,
      total: value.total - fee.paymentFeeMinor - (context.taxMode === "exclusive" ? fee.paymentFeeVatMinor : 0) },
  };
}

function normalizedV2(input: CorrectionCommercialRevisionInputV2): NormalizedCorrectionCommercialRevisionV2 {
  const context = { taxMode: input.taxMode, vatRatePpm: input.vatRatePpm };
  const before = feeComponents(input.beforeTotals, context);
  const after = feeComponents(input.afterTotals, context);
  const base = normalized({ ...input, beforeTotals: before.feeFreeTotals, afterTotals: after.feeFreeTotals });
  const body = { ...base, bundleVersion: 2 as const, baseComponents: before.components, components: after.components,
    commercialCalculationVersion: 2 as const, vatRatePpm: input.vatRatePpm,
    basePaymentFee: before.fee, paymentFee: after.fee };
  return { ...body, bundleFingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

function feeTotalsFromComponents(c: OrderCommercialComponentsV2, fee: FeeDescriptorSnapshot): CorrectionCommercialTotalsInputV2 {
  return { subtotal: c.merchandiseGrossMinor, discount: c.discountMinor, merchandisePayable: c.merchandiseNetMinor,
    shippingFee: c.shippingMinor, merchandiseTax: c.merchandiseVatMinor, shippingTax: c.shippingVatMinor,
    tax: c.vatMinor, total: c.totalMinor, ...fee, paymentFeeMinor: c.paymentFeeMinor, paymentFeeVatMinor: c.paymentFeeVatMinor };
}

export function assertNormalizedCorrectionCommercialRevisionV2(value: NormalizedCorrectionCommercialRevisionV2): NormalizedCorrectionCommercialRevisionV2 {
  const expected = normalizedV2({ merchantId: value.merchantId, storeId: value.storeId, orderId: value.orderId,
    correctionId: value.correctionId, revision: value.revision, sourceOccurredAt: value.sourceOccurredAt,
    currencyCode: value.currencyCode, minorUnitExponent: value.minorUnitExponent,
    taxMode: value.components.taxMode, vatRatePpm: value.vatRatePpm, lines: value.lines,
    beforeTotals: feeTotalsFromComponents(value.baseComponents, value.basePaymentFee),
    afterTotals: feeTotalsFromComponents(value.components, value.paymentFee),
  });
  if (JSON.stringify(expected) !== JSON.stringify(value)) invalid("normalized correction revision identity drift");
  return expected;
}

export function createCorrectionCommercialRevisionTaskV2(
  dependencies: { repository: CorrectionCommercialRevisionRepositoryV2 }, input: CorrectionCommercialRevisionInputV2,
): { bundle: NormalizedCorrectionCommercialRevisionV2; execute(): Promise<PersistedCorrectionCommercialRevisionV1> } {
  if (!dependencies?.repository) invalid("correction revision repository is required");
  const bundle = normalizedV2(structuredClone(input));
  return { bundle: structuredClone(bundle), execute: () => dependencies.repository.appendCorrectionRevision(
    assertNormalizedCorrectionCommercialRevisionV2(bundle),
  ) };
}
