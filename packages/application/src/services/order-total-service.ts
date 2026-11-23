import { PlatformError } from "../errors/platform-error";
import { OrderPaymentFeeFinancialSnapshotV1Schema, type OrderPaymentFeeFinancialSnapshotV1, type PaymentFeeInputV1 } from "@medusa-snus/contracts";
import { calculateVatMinor, readPaymentFeeInput, resolvePaymentFee, type PaymentFeeTaxContextV1, type ResolvedPaymentFeeV1 } from "./payment-fee-calculation";

/**
 * Single source of truth for normalizing commercial adjustments (discount and
 * shipping fee) into the canonical totals envelope shared by order creation,
 * payment intent quote/settlement, shipping adjustment, order correction,
 * receipt, dashboard, and accounting-facing metadata.
 *
 * UI totals are previews; this module produces the authoritative backend
 * totals.
 */

export const COMMERCIAL_ADJUSTMENT_VERSION = 1 as const;

export type DiscountType = "percent" | "amount";

export interface CommercialAdjustmentInput {
  /**
   * Explicit discount type. When present alongside `discountValue` it is
   * authoritative. Otherwise the legacy `discountPercent` is used.
   */
  discountType?: DiscountType;
  /** Discount magnitude (percent 0..100 or integer VND amount). */
  discountValue?: number;
  /** Legacy percentage discount for backward compatibility. */
  discountPercent?: number;
  /** Shipping fee (integer VND, non-negative). */
  shippingFee?: number;
}

export interface NormalizedCommercialAdjustment {
  discountType: DiscountType;
  discountValue: number;
  discountPercent: number;
  /** Normalized VND discount amount. */
  discount: number;
}

export interface NormalizedOrderTotals {
  commercialAdjustmentVersion: typeof COMMERCIAL_ADJUSTMENT_VERSION;
  discountType: DiscountType;
  discountValue: number;
  discountPercent: number;
  discount: number;
  subtotal: number;
  merchandisePayable: number;
  shippingFee: number;
  merchandiseTax: number;
  shippingTax: number;
  merchandiseRevenue: number;
  shippingRevenue: number;
  tax: number;
  total: number;
  loyaltyBase: number;
}

export interface CommercialAdjustmentContext {
  vatRate: number;
  taxMode: "inclusive" | "exclusive";
  vatRatePpm?: number;
}

export type NormalizedOrderTotalsV2 = Omit<NormalizedOrderTotals, "commercialAdjustmentVersion"> & ResolvedPaymentFeeV1 & PaymentFeeTaxContextV1 & {
  commercialAdjustmentVersion: 2;
  commercialCalculationVersion: 2;
};

export function commercialAdjustmentContext(environment: Partial<Pick<NodeJS.ProcessEnv, "VAT_RATE" | "TAX_MODE">> = process.env): CommercialAdjustmentContext {
  const vat = Number(environment.VAT_RATE ?? "0.10");
  return {
    vatRate: Number.isFinite(vat) && vat >= 0 ? vat : 0.1,
    taxMode: environment.TAX_MODE === "exclusive" ? "exclusive" : "inclusive",
  };
}

function taxableRevenue(amount: number, tax: number, taxMode: "inclusive" | "exclusive") {
  return Math.max(0, taxMode === "inclusive" ? amount - tax : amount);
}

/**
 * Resolve the additive discount contract fields into a normalized discount
 * descriptor. Precedence: if `discountType`/`discountValue` are present they
 * are authoritative; otherwise legacy `discountPercent` is used. Missing
 * fields mean no discount.
 *
 * Validation rules (per SUB-0 freeze):
 * - Percent discount must be `0..100`.
 * - Fixed VND discount must be an integer, non-negative, and `<= subtotal`.
 *   Invalid payloads are rejected (not clamped).
 */
export function normalizeCommercialAdjustment(
  input: CommercialAdjustmentInput,
  subtotal: number,
): NormalizedCommercialAdjustment {
  const shipping = 0; // unused for discount resolution
  void shipping;
  const hasExplicit = input.discountType !== undefined || input.discountValue !== undefined;
  const discountType: DiscountType = (input.discountType || (hasExplicit ? "amount" : "percent")) === "amount" ? "amount" : "percent";

  if (discountType === "amount") {
    const rawValue = input.discountValue !== undefined ? Number(input.discountValue) : undefined;
    if (rawValue === undefined && hasExplicit) {
      // Explicit type without a value is treated as no discount.
      return { discountType: "amount", discountValue: 0, discountPercent: 0, discount: 0 };
    }
    if (rawValue === undefined) {
      return noDiscount();
    }
    if (!Number.isFinite(rawValue) || rawValue < 0 || !Number.isInteger(rawValue)) {
      throw new PlatformError("validation_error", "Fixed discount must be a non-negative integer VND amount", 400);
    }
    if (rawValue > subtotal) {
      throw new PlatformError("validation_error", "Fixed discount cannot exceed subtotal", 400);
    }
    return {
      discountType: "amount",
      discountValue: rawValue,
      discountPercent: 0,
      discount: rawValue,
    };
  }

  // Percent discount
  const percentSource = input.discountValue !== undefined ? Number(input.discountValue) : Number(input.discountPercent || 0);
  if (!Number.isFinite(percentSource) || percentSource < 0 || percentSource > 100) {
    throw new PlatformError("validation_error", "Percent discount must be between 0 and 100", 400);
  }
  const discount = Math.round(subtotal * (percentSource / 100));
  return {
    discountType: "percent",
    discountValue: percentSource,
    discountPercent: percentSource,
    discount,
  };
}

function noDiscount(): NormalizedCommercialAdjustment {
  return { discountType: "percent", discountValue: 0, discountPercent: 0, discount: 0 };
}

/**
 * Compute the canonical order totals envelope from subtotal and commercial
 * adjustment inputs. Used by order creation, payment intent quote/settlement,
 * shipping adjustment, and order correction.
 */
export function calculateOrderTotals(
  subtotal: number,
  input: CommercialAdjustmentInput,
  shippingFeeInput: unknown = 0,
  ctx: CommercialAdjustmentContext = commercialAdjustmentContext(),
): NormalizedOrderTotals {
  const adjustment = normalizeCommercialAdjustment(input, subtotal);
  const discount = adjustment.discount;
  const merchandisePayable = Math.max(0, subtotal - discount);
  const shippingFee = normalizeMoney(shippingFeeInput);

  const merchandiseTax = ctx.taxMode === "inclusive"
    ? Math.round(merchandisePayable * (ctx.vatRate / (1 + ctx.vatRate)))
    : Math.round(merchandisePayable * ctx.vatRate);
  const shippingTax = ctx.taxMode === "inclusive"
    ? Math.round(shippingFee * (ctx.vatRate / (1 + ctx.vatRate)))
    : Math.round(shippingFee * ctx.vatRate);
  const tax = merchandiseTax + shippingTax;
  const total = ctx.taxMode === "inclusive"
    ? merchandisePayable + shippingFee
    : merchandisePayable + shippingFee + tax;

  return {
    commercialAdjustmentVersion: COMMERCIAL_ADJUSTMENT_VERSION,
    discountType: adjustment.discountType,
    discountValue: adjustment.discountValue,
    discountPercent: adjustment.discountPercent,
    discount,
    subtotal,
    merchandisePayable,
    shippingFee,
    merchandiseTax,
    shippingTax,
    merchandiseRevenue: taxableRevenue(merchandisePayable, merchandiseTax, ctx.taxMode),
    shippingRevenue: taxableRevenue(shippingFee, shippingTax, ctx.taxMode),
    tax,
    total,
    loyaltyBase: merchandisePayable,
  };
}

// Keep fee-free V1 serialization and arithmetic unchanged for historical replay.
export function calculateOrderTotalsV2(
  subtotal: number,
  input: CommercialAdjustmentInput & PaymentFeeInputV1,
  shippingFeeInput: unknown,
  ctx: PaymentFeeTaxContextV1,
): NormalizedOrderTotalsV2 {
  if (!Number.isSafeInteger(subtotal) || subtotal < 0 || typeof shippingFeeInput !== "number"
    || !Number.isSafeInteger(shippingFeeInput) || shippingFeeInput < 0) {
    throw new PlatformError("validation_error", "Subtotal and shipping must be safe non-negative integer VND", 400);
  }
  const adjustment = normalizeCommercialAdjustment(input, subtotal);
  const merchandisePayable = subtotal - adjustment.discount;
  const shippingFee = shippingFeeInput;
  const fee = resolvePaymentFee(merchandisePayable,
    { paymentFeeType: input.paymentFeeType, paymentFeeValue: input.paymentFeeValue }, ctx);
  const merchandiseTax = calculateVatMinor(merchandisePayable, ctx);
  const shippingTax = calculateVatMinor(shippingFee, ctx);
  const tax = BigInt(merchandiseTax) + BigInt(shippingTax) + BigInt(fee.paymentFeeVatMinor);
  const total = BigInt(merchandisePayable) + BigInt(shippingFee) + BigInt(fee.paymentFeeMinor)
    + (ctx.taxMode === "exclusive" ? tax : 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new PlatformError("validation_error", "Order total overflows", 400);
  return {
    commercialAdjustmentVersion: 2, commercialCalculationVersion: 2,
    discountType: adjustment.discountType, discountValue: adjustment.discountValue,
    discountPercent: adjustment.discountPercent, discount: adjustment.discount, subtotal,
    merchandisePayable, shippingFee, merchandiseTax, shippingTax,
    merchandiseRevenue: taxableRevenue(merchandisePayable, merchandiseTax, ctx.taxMode),
    shippingRevenue: taxableRevenue(shippingFee, shippingTax, ctx.taxMode),
    tax: Number(tax), total: Number(total), loyaltyBase: merchandisePayable,
    ...fee, taxMode: ctx.taxMode, vatRatePpm: ctx.vatRatePpm,
  };
}

export function frozenPaymentFeeQuoteContext(
  metadata: Record<string, unknown>, input: CommercialAdjustmentInput & Partial<PaymentFeeInputV1>,
): CommercialAdjustmentContext | undefined {
  const quote = metadata.quote as { totals?: Record<string, unknown> } | undefined;
  const t = quote?.totals;
  const fee = readPaymentFeeInput(input);
  if (!fee && t?.commercialAdjustmentVersion !== 2) return undefined;
  try {
    if (!t || t.commercialAdjustmentVersion !== 2 || !fee || t.paymentFeeType !== fee.paymentFeeType || t.paymentFeeValue !== fee.paymentFeeValue) {
      throw new Error("fee descriptor drift");
    }
    const context = { taxMode: t.taxMode as "inclusive" | "exclusive", vatRatePpm: t.vatRatePpm as number };
    const expected = calculateOrderTotalsV2(t.subtotal as number, { ...input, ...fee }, input.shippingFee ?? 0, context);
    for (const key of Object.keys(expected) as Array<keyof NormalizedOrderTotalsV2>) {
      if (t[key] !== expected[key]) throw new Error("frozen totals drift");
    }
    return { taxMode: context.taxMode, vatRate: context.vatRatePpm / 1_000_000, vatRatePpm: context.vatRatePpm };
  } catch {
    throw new PlatformError("payment_intent_quote_invalid", "Stored payment fee quote is missing or inconsistent", 409);
  }
}

export function normalizeMoney(value: unknown): number {
  const amount = Math.round(Number(value || 0));
  if (!Number.isFinite(amount) || amount < 0) {
    throw new PlatformError("validation_error", "Amount must be a non-negative amount", 400);
  }
  return amount;
}

export function totalsFromMetadataV2(value: Record<string,unknown>): NormalizedOrderTotalsV2 {
  try{
    if(value.commercialAdjustmentVersion!==2||value.commercialCalculationVersion!==2)throw new Error("unsupported frozen totals version");
    const expected=calculateOrderTotalsV2(value.subtotal as number,{
      discountType:value.discountType as DiscountType,discountValue:value.discountValue as number,
      discountPercent:value.discountPercent as number,paymentFeeType:value.paymentFeeType as PaymentFeeInputV1["paymentFeeType"],
      paymentFeeValue:value.paymentFeeValue as number,
    },value.shippingFee,{taxMode:value.taxMode as PaymentFeeTaxContextV1["taxMode"],vatRatePpm:value.vatRatePpm as number});
    for(const key of Object.keys(expected) as Array<keyof NormalizedOrderTotalsV2>){
      if(value[key]!==expected[key])throw new Error("frozen totals drift");
    }
    return expected;
  }catch{
    throw new PlatformError("financial_invariant_error","Frozen fee-aware order totals are missing or inconsistent",409);
  }
}

export function paymentFeeFinancialSnapshotV1(totals: NormalizedOrderTotals | NormalizedOrderTotalsV2): OrderPaymentFeeFinancialSnapshotV1 | undefined {
  if (totals.commercialAdjustmentVersion === 1) return undefined;
  const frozen = totalsFromMetadataV2({ ...totals });
  return OrderPaymentFeeFinancialSnapshotV1Schema.parse({
    schemaVersion: 1, calculationVersion: 2, currencyCode: "VND", minorUnitExponent: 0,
    paymentFee: { paymentFeeType: frozen.paymentFeeType, paymentFeeValue: frozen.paymentFeeValue,
      paymentFeeBasisMinor: frozen.paymentFeeBasisMinor, vatRatePpm: frozen.vatRatePpm },
    components: { taxMode: frozen.taxMode, merchandiseGrossMinor: frozen.subtotal, discountMinor: frozen.discount,
      merchandiseNetMinor: frozen.merchandisePayable, shippingMinor: frozen.shippingFee, merchandiseVatMinor: frozen.merchandiseTax,
      shippingVatMinor: frozen.shippingTax, paymentFeeMinor: frozen.paymentFeeMinor, paymentFeeVatMinor: frozen.paymentFeeVatMinor,
      vatMinor: frozen.tax, totalMinor: frozen.total, unclassifiedMinor: 0 },
  });
}

/**
 * Read a normalized totals descriptor back from persisted order/correction
 * metadata, falling back to derived values for legacy orders.
 */
export function totalsFromMetadata(value: Record<string, unknown>): NormalizedOrderTotals {
  const ctx = commercialAdjustmentContext();
  const subtotal = numeric(value.subtotal);
  const discount = numeric(value.discount);
  const discountType: DiscountType = value.discountType === "amount" ? "amount" : "percent";
  const discountValue = numeric(value.discountValue !== undefined ? value.discountValue : (discountType === "amount" ? discount : value.discountPercent));
  const discountPercent = numeric(value.discountPercent);
  const merchandisePayable = numeric(value.merchandisePayable || Math.max(0, subtotal - discount));
  const shippingFee = numeric(value.shippingFee);
  const merchandiseTax = numeric(value.merchandiseTax || value.tax);
  const shippingTax = numeric(value.shippingTax);
  const tax = numeric(value.tax || merchandiseTax + shippingTax);
  return {
    commercialAdjustmentVersion: COMMERCIAL_ADJUSTMENT_VERSION,
    discountType,
    discountValue,
    discountPercent,
    discount,
    subtotal,
    merchandisePayable,
    shippingFee,
    merchandiseTax,
    shippingTax,
    merchandiseRevenue: numeric(value.merchandiseRevenue || taxableRevenue(merchandisePayable, merchandiseTax, ctx.taxMode)),
    shippingRevenue: numeric(value.shippingRevenue || taxableRevenue(shippingFee, shippingTax, ctx.taxMode)),
    tax,
    total: numeric(value.total || (ctx.taxMode === "inclusive" ? merchandisePayable + shippingFee : merchandisePayable + shippingFee + tax)),
    loyaltyBase: numeric(value.loyaltyBase || merchandisePayable),
  };
}

function numeric(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
