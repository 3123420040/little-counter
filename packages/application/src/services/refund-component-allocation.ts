import { PlatformError } from "../errors/platform-error";
import { createHash } from "node:crypto";
import { z } from "zod";

export interface RefundComponentCapacitiesV2 {
  merchandiseRevenueMinor: number;
  shippingRevenueMinor: number;
  paymentFeeRevenueMinor: number;
  vatMinor: number;
}

const revenueKeys = [
  "merchandiseRevenueMinor",
  "shippingRevenueMinor",
  "paymentFeeRevenueMinor",
] as const;
function invalid(): never {
  throw new PlatformError(
    "financial_invariant_error",
    "Refund component allocation exceeds safe remaining capacity",
    409,
  );
}
function minor(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return BigInt(value);
}

export function splitRefundComponentsV2(
  amountMinor: number,
  capacities: RefundComponentCapacitiesV2,
): RefundComponentCapacitiesV2 {
  const amount = minor(amountMinor),
    taxCapacity = minor(capacities.vatMinor);
  const revenues = revenueKeys.map((key) => minor(capacities[key]));
  const revenueCapacity = revenues.reduce((sum, value) => sum + value, 0n),
    total = revenueCapacity + taxCapacity;
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || amount > total) invalid();
  if (amount === total) return { ...capacities };
  const minimumTax = amount > revenueCapacity ? amount - revenueCapacity : 0n;
  const maximumTax = amount < taxCapacity ? amount : taxCapacity;
  const proportionalTax = (2n * amount * taxCapacity + total) / (2n * total);
  const tax =
    proportionalTax < minimumTax
      ? minimumTax
      : proportionalTax > maximumTax
        ? maximumTax
        : proportionalTax;
  const postTax = amount - tax;
  const shares = revenues.map((capacity, index) => ({
    index,
    amount:
      revenueCapacity === 0n ? 0n : (postTax * capacity) / revenueCapacity,
    remainder:
      revenueCapacity === 0n ? 0n : (postTax * capacity) % revenueCapacity,
  }));
  let unassigned =
    postTax - shares.reduce((sum, share) => sum + share.amount, 0n);
  const ranked = [...shares].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (const share of ranked) {
    if (unassigned === 0n) break;
    if (share.amount >= revenues[share.index]!) invalid();
    share.amount++;
    unassigned--;
  }
  if (
    unassigned !== 0n ||
    shares.some((share) => share.amount > revenues[share.index]!)
  )
    invalid();
  return {
    merchandiseRevenueMinor: Number(shares[0]!.amount),
    shippingRevenueMinor: Number(shares[1]!.amount),
    paymentFeeRevenueMinor: Number(shares[2]!.amount),
    vatMinor: Number(tax),
  };
}

const minorSchema = z.number().int().safe().nonnegative();
const capacitiesSchema = z
  .object({
    merchandiseRevenueMinor: minorSchema,
    shippingRevenueMinor: minorSchema,
    paymentFeeRevenueMinor: minorSchema,
    vatMinor: minorSchema,
  })
  .strict();
const allocationBodySchema = z
  .object({
    schemaVersion: z.literal(2),
    amountMinor: minorSchema.positive(),
    reversalComponents: capacitiesSchema,
    settlementOnlyMinor: minorSchema,
    payableAllocations: z
      .array(
        z
          .object({
            payableId: z.string().uuid(),
            payableKind: z.enum([
              "manual_refund",
              "negative_correction",
              "shipping_decrease",
              "order_cancellation",
            ]),
            commercialRevisionId: z.string().uuid(),
            componentVersion: z.union([z.literal(1), z.literal(2)]),
            basisFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            sourceType: z.string().min(1),
            sourceId: z.string().min(1),
            amountMinor: minorSchema.positive(),
            reversalComponents: capacitiesSchema,
            basisCapacities: capacitiesSchema.optional(),
            remainingBefore: capacitiesSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    obligationAllocations: z
      .array(
        z
          .object({
            obligationId: z.string().uuid(),
            amountMinor: minorSchema.positive(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const allocationSchema = allocationBodySchema.extend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type FrozenRefundAllocationV2 = z.infer<typeof allocationSchema>;
export const zeroRefundComponentsV2 = (): RefundComponentCapacitiesV2 => ({
  merchandiseRevenueMinor: 0,
  shippingRevenueMinor: 0,
  paymentFeeRevenueMinor: 0,
  vatMinor: 0,
});
export const refundComponentKeysV2 = [...revenueKeys, "vatMinor"] as const;

function validateAllocation(body: z.infer<typeof allocationBodySchema>): void {
  const sum = (amounts: number[]) =>
    amounts.reduce((total, value) => total + BigInt(value), 0n);
  if (
    sum(Object.values(body.reversalComponents)) +
      BigInt(body.settlementOnlyMinor) !==
      BigInt(body.amountMinor) ||
    sum(body.payableAllocations.map((part) => part.amountMinor)) !==
      BigInt(body.amountMinor) ||
    sum(body.obligationAllocations.map((part) => part.amountMinor)) !==
      BigInt(body.amountMinor) ||
    new Set(body.payableAllocations.map((part) => part.payableId)).size !==
      body.payableAllocations.length ||
    new Set(body.obligationAllocations.map((part) => part.obligationId))
      .size !== body.obligationAllocations.length
  )
    invalid();
  let settlement = 0n;
  for (const part of body.payableAllocations) {
    if (part.payableKind === "manual_refund") {
      if (!part.basisCapacities || !part.remainingBefore) invalid();
      const expected = splitRefundComponentsV2(
        part.amountMinor,
        part.remainingBefore,
      );
      for (const key of refundComponentKeysV2) {
        if (
          part.remainingBefore[key] > part.basisCapacities[key] ||
          part.reversalComponents[key] !== expected[key]
        )
          invalid();
      }
    } else {
      if (
        part.basisCapacities ||
        part.remainingBefore ||
        sum(Object.values(part.reversalComponents)) !== 0n
      )
        invalid();
      settlement += BigInt(part.amountMinor);
    }
  }
  if (settlement !== BigInt(body.settlementOnlyMinor)) invalid();
  for (const key of refundComponentKeysV2) {
    if (
      sum(
        body.payableAllocations.map((part) => part.reversalComponents[key]),
      ) !== BigInt(body.reversalComponents[key])
    )
      invalid();
  }
}

export function freezeRefundAllocationV2(
  input: z.input<typeof allocationBodySchema>,
): FrozenRefundAllocationV2 {
  const body = allocationBodySchema.parse(input);
  validateAllocation(body);
  return {
    ...body,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex"),
  };
}

export function readFrozenRefundAllocationV2(
  raw: unknown,
): FrozenRefundAllocationV2 {
  const { fingerprint, ...body } = allocationSchema.parse(raw);
  validateAllocation(body);
  if (
    createHash("sha256").update(JSON.stringify(body)).digest("hex") !==
    fingerprint
  )
    invalid();
  return { ...body, fingerprint };
}
