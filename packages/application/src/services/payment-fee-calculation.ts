import { PaymentFeeInputV1Schema, parseOptionalPaymentFeeInputV1, type PaymentFeeInputV1 } from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";

export interface PaymentFeeTaxContextV1 {
  taxMode: "inclusive" | "exclusive";
  vatRatePpm: number;
}

export interface ResolvedPaymentFeeV1 extends PaymentFeeInputV1 {
  paymentFeeBasisMinor: number;
  paymentFeeMinor: number;
  paymentFeeVatMinor: number;
  paymentFeeRevenueMinor: number;
}

function invalid(message: string): never {
  throw new PlatformError("validation_error", message, 400);
}

export function readPaymentFeeInput(input: object): PaymentFeeInputV1 | undefined {
  try { return parseOptionalPaymentFeeInputV1(input); }
  catch { return invalid("Payment fee request accepts only its type and value, not resolved totals"); }
}

export function vatRatePpmFromRate(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) invalid("VAT rate is invalid");
  const match = /^(0|1)(?:\.(\d{1,6}))?$/.exec(String(value));
  if (!match) invalid("VAT rate requires integer parts per million precision");
  return Number(BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0")));
}

function minor(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) invalid("Payment fee amount/basis must be safe non-negative integer VND");
  return BigInt(value);
}

function roundedRatio(numerator: bigint, denominator: bigint): number {
  const value = (2n * numerator + denominator) / (2n * denominator);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid("Payment fee calculation overflows");
  return Number(value);
}

export function calculateVatMinor(amount: number, context: PaymentFeeTaxContextV1): number {
  const rate = minor(context.vatRatePpm);
  if (rate > 1_000_000n || !["inclusive", "exclusive"].includes(context.taxMode)) invalid("Payment fee tax context is invalid");
  return roundedRatio(minor(amount) * rate, 1_000_000n + (context.taxMode === "inclusive" ? rate : 0n));
}

export function resolvePaymentFee(
  basisMinor: number,
  input: PaymentFeeInputV1,
  context: PaymentFeeTaxContextV1,
): ResolvedPaymentFeeV1 {
  const parsed = PaymentFeeInputV1Schema.safeParse(input);
  if (!parsed.success) invalid("Payment fee descriptor is invalid");
  const basis = minor(basisMinor);
  const descriptor = parsed.data;
  const paymentFeeMinor = descriptor.paymentFeeType === "amount"
    ? descriptor.paymentFeeValue
    : roundedRatio(basis * BigInt(Math.round(descriptor.paymentFeeValue * 100)), 10_000n);
  const paymentFeeVatMinor = calculateVatMinor(paymentFeeMinor, context);
  return {
    ...descriptor,
    paymentFeeBasisMinor: basisMinor,
    paymentFeeMinor,
    paymentFeeVatMinor,
    paymentFeeRevenueMinor: paymentFeeMinor - (context.taxMode === "inclusive" ? paymentFeeVatMinor : 0),
  };
}
