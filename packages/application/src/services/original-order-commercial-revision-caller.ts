import type { PoolClient } from "../db/client";
import {
  OriginalOrderCommercialRevisionValidationErrorV1,
  createOriginalOrderCommercialRevisionTaskV1,
  createOriginalOrderCommercialRevisionTaskV2,
  type PersistedOriginalOrderCommercialRevisionV1,
} from "./original-order-commercial-revision-service";
import {
  PostgresOriginalOrderCommercialRevisionRepositoryV1,
  type PostgresOriginalOrderCommercialRevisionOptionsV1,
} from "./postgres-original-order-commercial-revision-repository";
import type {
  CommercialAdjustmentContext,
  NormalizedOrderTotals,
  NormalizedOrderTotalsV2,
} from "./order-total-service";
import { calculateOrderTotalsV2 } from "./order-total-service";
import type { PaymentFeeTaxContextV1 } from "./payment-fee-calculation";

export const ORIGINAL_ORDER_COMMERCIAL_REVISION_CALLER_DEFAULT_CONFIG_V1 = Object.freeze({
  enabled: true,
});

export interface OriginalOrderCommercialRevisionCallerLineV1 {
  orderLineItemId: string;
  productId: string;
  variantId: string;
  skuSnapshot: string;
  titleSnapshot: string;
  quantity: number;
  unitPriceMinor: number;
  unitCostMinor: number;
  costEvidenceSource: "inventory.product_settings";
  costEvidenceUpdatedAt: string;
}

export interface OriginalOrderCommercialRevisionCallerInputV1 {
  merchantId: string;
  storeId: string;
  orderId: string;
  orderCreatedAt: string;
  currencyCode: "VND";
  minorUnitExponent: 0;
  commercialContext: CommercialAdjustmentContext;
  totals: NormalizedOrderTotals;
  lines: OriginalOrderCommercialRevisionCallerLineV1[];
}

export type OriginalOrderCommercialRevisionCallerInputV2 = Omit<OriginalOrderCommercialRevisionCallerInputV1,
  "totals" | "commercialContext"> & { totals: NormalizedOrderTotalsV2; commercialContext: PaymentFeeTaxContextV1 };

export interface OriginalOrderCommercialRevisionCallerDependenciesV1 {
  client: PoolClient;
  config?: { enabled: boolean };
  transactionContext: {
    ownership: "caller";
    orderCreatedInCurrentTransaction: true;
  };
  repositoryOptions: Omit<
    PostgresOriginalOrderCommercialRevisionOptionsV1,
    "transactionOwnership"
  >;
}

export type OriginalOrderCommercialRevisionCallerResultV1 =
  | { enabled: false; status: "disabled" }
  | ({ enabled: true; kind: "recorded" } & PersistedOriginalOrderCommercialRevisionV1);

export class OriginalOrderCommercialRevisionCallerValidationErrorV1 extends Error {
  readonly code = "original_order_commercial_revision_caller_invalid";

  constructor(message: string) {
    super(message);
    this.name = "OriginalOrderCommercialRevisionCallerValidationErrorV1";
  }
}

function invalid(message: string): never {
  throw new OriginalOrderCommercialRevisionCallerValidationErrorV1(message);
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    return invalid(`${field} is invalid`);
  }
  return value;
}

function minor(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalid(`${field} is invalid`);
  }
  return Number(value);
}

function canonicalInstant(value: unknown): string {
  if (typeof value !== "string") return invalid("order creation time is invalid");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return invalid("order creation time is invalid");
  }
  return value;
}

function exactVatRatePpm(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return invalid("VAT rate is invalid");
  }
  const scaled = value * 1_000_000;
  if (!Number.isSafeInteger(scaled)) {
    return invalid("VAT rate is not exactly representable in parts per million");
  }
  return scaled;
}

function assertExact(actual: unknown, expected: number, field: string): void {
  if (minor(actual, field) !== expected) invalid(`${field} differs from calculator policy`);
}

function mapCallerLines(input: Pick<OriginalOrderCommercialRevisionCallerInputV1, "lines">) {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    invalid("order lines are required");
  }
  return input.lines.map((line) => {
    const variantId = token(line.variantId, "variant id");
    if (line.costEvidenceSource !== "inventory.product_settings") {
      invalid("cost evidence source is invalid");
    }
    const costEvidenceUpdatedAt = canonicalInstant(line.costEvidenceUpdatedAt);
    return {
      lineKey: token(line.orderLineItemId, "order line item id"),
      sourceLineId: token(line.orderLineItemId, "order line item id"),
      productId: token(line.productId, "product id"),
      variantId,
      skuSnapshot: token(line.skuSnapshot, "SKU snapshot"),
      titleSnapshot: token(line.titleSnapshot, "title snapshot"),
      archivedVariant: false,
      quantity: minor(line.quantity, "line quantity"),
      unitPriceMinor: minor(line.unitPriceMinor, "line unit price"),
      unitCostMinor: minor(line.unitCostMinor, "line unit cost"),
      costEvidenceId:
        `inventory.product_settings:${variantId}:${costEvidenceUpdatedAt}`,
    };
  });
}

function mapInput(input: OriginalOrderCommercialRevisionCallerInputV1) {
  const merchantId = token(input?.merchantId, "merchant id");
  const storeId = token(input?.storeId, "store id");
  const orderId = token(input?.orderId, "order id");
  const sourceOccurredAt = canonicalInstant(input?.orderCreatedAt);
  if (input.currencyCode !== "VND" || input.minorUnitExponent !== 0) {
    invalid("original order caller supports only whole-minor VND");
  }

  const taxMode = input.commercialContext?.taxMode;
  if (taxMode !== "inclusive" && taxMode !== "exclusive") {
    invalid("tax mode is invalid");
  }
  const vatRate = input.commercialContext.vatRate;
  const vatRatePpm = exactVatRatePpm(vatRate);
  const totals = input.totals;
  if (!totals || totals.commercialAdjustmentVersion !== 1) {
    invalid("commercial calculation version is invalid");
  }

  const subtotal = minor(totals.subtotal, "subtotal");
  const discount = minor(totals.discount, "discount");
  const merchandisePayable = minor(totals.merchandisePayable, "merchandise payable");
  const shippingFee = minor(totals.shippingFee, "shipping");
  if (discount > subtotal || merchandisePayable !== subtotal - discount) {
    invalid("discount or merchandise payable differs from calculator policy");
  }
  const merchandiseTax = taxMode === "inclusive"
    ? Math.round(merchandisePayable * (vatRate / (1 + vatRate)))
    : Math.round(merchandisePayable * vatRate);
  const shippingTax = taxMode === "inclusive"
    ? Math.round(shippingFee * (vatRate / (1 + vatRate)))
    : Math.round(shippingFee * vatRate);
  const vat = merchandiseTax + shippingTax;
  const total = merchandisePayable
    + shippingFee
    + (taxMode === "exclusive" ? vat : 0);
  const merchandiseRevenue = taxMode === "inclusive"
    ? merchandisePayable - merchandiseTax
    : merchandisePayable;
  const shippingRevenue = taxMode === "inclusive"
    ? shippingFee - shippingTax
    : shippingFee;
  assertExact(totals.merchandiseTax, merchandiseTax, "merchandise VAT");
  assertExact(totals.shippingTax, shippingTax, "shipping VAT");
  assertExact(totals.tax, vat, "VAT");
  assertExact(totals.total, total, "total");
  assertExact(totals.merchandiseRevenue, merchandiseRevenue, "merchandise revenue");
  assertExact(totals.shippingRevenue, shippingRevenue, "shipping revenue");
  assertExact(totals.loyaltyBase, merchandisePayable, "loyalty base");

  const lines = mapCallerLines(input);

  return {
    merchantId,
    storeId,
    orderId,
    orderCreatedInCurrentTransaction: true as const,
    currencyCode: "VND" as const,
    minorUnitExponent: 0 as const,
    sourceOccurredAt,
    totals: {
      taxMode,
      vatRatePpm,
      commercialCalculationVersion: 1 as const,
      subtotalMinor: subtotal,
      discountMinor: discount,
      merchandisePayableMinor: merchandisePayable,
      shippingMinor: shippingFee,
      merchandiseVatMinor: merchandiseTax,
      shippingVatMinor: shippingTax,
      vatMinor: vat,
      unclassifiedMinor: 0,
      totalMinor: total,
    },
    lines,
  };
}

export async function recordOriginalOrderCommercialRevisionFromOrderCreateV1(
  dependencies: OriginalOrderCommercialRevisionCallerDependenciesV1,
  input: OriginalOrderCommercialRevisionCallerInputV1,
): Promise<OriginalOrderCommercialRevisionCallerResultV1> {
  if (dependencies?.config?.enabled !== true) {
    return { enabled: false, status: "disabled" };
  }
  if (
    !dependencies.client
    || dependencies.transactionContext?.ownership !== "caller"
    || dependencies.transactionContext.orderCreatedInCurrentTransaction !== true
  ) {
    invalid("original revision caller requires caller-owned order transaction context");
  }
  const repository = new PostgresOriginalOrderCommercialRevisionRepositoryV1(
    dependencies.client,
    { ...dependencies.repositoryOptions, transactionOwnership: "caller" },
  );
  let task;
  try {
    task = createOriginalOrderCommercialRevisionTaskV1({
      config: { enabled: true },
      repository,
    }, mapInput(input));
  } catch (error) {
    if (error instanceof OriginalOrderCommercialRevisionValidationErrorV1) {
      invalid(error.message);
    }
    throw error;
  }
  if (!task.enabled) invalid("original order commercial revision task is unavailable");
  const result = await task.execute();
  return { enabled: true, kind: "recorded", ...result };
}

export async function recordOriginalOrderCommercialRevisionFromOrderCreateV2(
  dependencies: OriginalOrderCommercialRevisionCallerDependenciesV1,
  input: OriginalOrderCommercialRevisionCallerInputV2,
): Promise<OriginalOrderCommercialRevisionCallerResultV1> {
  if (dependencies?.config?.enabled !== true) return { enabled: false, status: "disabled" };
  if (!dependencies.client || dependencies.transactionContext?.ownership !== "caller"
    || dependencies.transactionContext.orderCreatedInCurrentTransaction !== true) {
    invalid("original revision caller requires caller-owned order transaction context");
  }
  if (input.currencyCode !== "VND" || input.minorUnitExponent !== 0) invalid("original order caller supports only whole-minor VND");
  const t = input.totals;
  const expected = calculateOrderTotalsV2(t.subtotal, { discountType: t.discountType, discountValue: t.discountValue,
    paymentFeeType: t.paymentFeeType, paymentFeeValue: t.paymentFeeValue }, t.shippingFee, input.commercialContext);
  for (const key of Object.keys(expected) as Array<keyof NormalizedOrderTotalsV2>) {
    if (t[key] !== expected[key]) invalid(`${key} differs from calculator policy`);
  }
  const task = createOriginalOrderCommercialRevisionTaskV2({ config: { enabled: true },
    repository: new PostgresOriginalOrderCommercialRevisionRepositoryV1(dependencies.client,
      { ...dependencies.repositoryOptions, transactionOwnership: "caller" }),
  }, { merchantId: token(input.merchantId, "merchant id"), storeId: token(input.storeId, "store id"),
    orderId: token(input.orderId, "order id"), sourceOccurredAt: canonicalInstant(input.orderCreatedAt),
    orderCreatedInCurrentTransaction: true, currencyCode: "VND", minorUnitExponent: 0,
    totals: { taxMode: t.taxMode, vatRatePpm: t.vatRatePpm, commercialCalculationVersion: 2,
      subtotalMinor: t.subtotal, discountMinor: t.discount, merchandisePayableMinor: t.merchandisePayable,
      shippingMinor: t.shippingFee, merchandiseVatMinor: t.merchandiseTax, shippingVatMinor: t.shippingTax,
      vatMinor: t.tax, unclassifiedMinor: 0, totalMinor: t.total,
      paymentFeeType: t.paymentFeeType, paymentFeeValue: t.paymentFeeValue, paymentFeeBasisMinor: t.paymentFeeBasisMinor,
      paymentFeeMinor: t.paymentFeeMinor, paymentFeeVatMinor: t.paymentFeeVatMinor },
    lines: mapCallerLines(input),
  });
  if (!task.enabled) invalid("original order commercial revision task is unavailable");
  return { enabled: true, kind: "recorded", ...await task.execute() };
}
