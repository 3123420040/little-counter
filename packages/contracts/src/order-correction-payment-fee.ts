import { z } from "zod";
import { parseOptionalPaymentFeeInputV1, PaymentFeeInputV1Schema, OrderPaymentFeeFinancialSnapshotV1Schema, EffectiveOrderCsvPaymentFeeV5Schema, OrderCommercialComponentsV2Schema } from "./order-payment-fee";
import { EffectiveOrderLineV1Schema } from "./order-financial-correctness";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "./runtime-capabilities";

export const OrderCorrectionFinancialInputV1Schema = z.object({
  baseRevision: z.number().int().safe().nonnegative(), reason: z.string().trim().min(10).max(500),
  confirmationToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  items: z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int().safe().min(1).max(99) }).strict()).min(1),
  shippingFee: z.number().int().safe().nonnegative().optional(),
  paymentFeeType: PaymentFeeInputV1Schema.shape.paymentFeeType.optional(),
  paymentFeeValue: PaymentFeeInputV1Schema.shape.paymentFeeValue.optional(),
  settlement: z.object({ method: z.enum(["cash", "bank_transfer", "cod"]).optional(),
    amountReceived: z.number().int().safe().nonnegative().optional() }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  try { parseOptionalPaymentFeeInputV1(value); }
  catch { ctx.addIssue({ code: "custom", message: "Invalid payment fee descriptor" }); }
  if (new Set(value.items.map(item => item.variantId)).size !== value.items.length) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "Duplicate correction variants are not supported" });
  }
});
export type OrderCorrectionFinancialInputV1 = z.infer<typeof OrderCorrectionFinancialInputV1Schema>;

const money = z.number().int().safe().nonnegative(), integer = z.number().int().safe(), identity = z.string().min(1);
const financial = z.discriminatedUnion("status", [
  z.object({ status: z.literal("legacy") }).strict(),
  z.object({ status: z.literal("available"), snapshot: OrderPaymentFeeFinancialSnapshotV1Schema }).strict(),
]);
const totals = z.object({ total: money }).strict();
const change = z.object({ beforeTotals: totals, afterTotals: totals, beforeFinancial: financial, afterFinancial: financial, totalDelta: integer });
function consistentChange(value: z.infer<typeof change>) {
  return BigInt(value.afterTotals.total) - BigInt(value.beforeTotals.total) === BigInt(value.totalDelta)
    && (value.beforeFinancial.status !== "available" || value.beforeFinancial.snapshot.components.totalMinor === value.beforeTotals.total)
    && (value.afterFinancial.status !== "available" || value.afterFinancial.snapshot.components.totalMinor === value.afterTotals.total)
    && !(value.beforeFinancial.status === "available" && value.afterFinancial.status === "legacy");
}
export const OrderCorrectionFinancialPreviewV1Schema = z.object({
  schemaVersion: z.literal(1), contractVersion: z.literal(PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1),
  data: change.extend({ merchantId: identity, storeId: identity, orderId: identity,
    baseRevision: money, nextRevision: z.number().int().safe().positive(), cogsDelta: integer,
    confirmationToken: z.string().regex(/^[a-f0-9]{64}$/),
    settlement: z.object({ direction: z.enum(["collect", "refund", "none"]), method: z.enum(["cash", "bank_transfer", "cod", "none"]),
      amount: money, status: z.enum(["none", "posted", "pending"]) }).strict(),
    items: z.array(z.object({ variantId: identity, productId: identity, productTitle: z.string(), sku: z.string(),
      quantityBefore: money, quantityAfter: money, quantityDelta: integer, stockDelta: integer, unitPrice: money, availableStock: integer,
    }).strict()).min(1),
  }).strict(),
}).strict().superRefine(({ data }, ctx) => {
  const s = data.settlement, delta = data.totalDelta;
  if (!consistentChange(data) || data.nextRevision !== data.baseRevision + 1 || s.amount !== Math.abs(delta)
    || s.direction !== (delta > 0 ? "collect" : delta < 0 ? "refund" : "none")
    || (delta === 0 ? s.method !== "none" || s.status !== "none" : s.method === "none" || s.status === "none")
    || (delta < 0 && s.method === "cod")
    || data.items.some(item => item.quantityAfter - item.quantityBefore !== item.quantityDelta || item.stockDelta !== -item.quantityDelta)
    || new Set(data.items.map(item => item.variantId)).size !== data.items.length) {
    ctx.addIssue({ code: "custom", message: "Correction preview differs from its frozen amounts, lines or settlement" });
  }
});
export const OrderCorrectionFinancialResponseV1Schema = z.object({
  schemaVersion: z.literal(1), contractVersion: z.literal(PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1),
  data: z.object({ merchantId: identity, storeId: identity, orderId: identity,
    correction: change.extend({ id: identity, revision: z.number().int().safe().positive(), status: z.literal("applied"),
      reason: z.string().min(10).max(500), paymentEntryId: identity.nullable(), settlementStatus: z.enum(["none", "posted", "pending"]),
    }).strict(),
  }).strict(),
}).strict().superRefine(({ data: { correction: value } }, ctx) => {
  if (!consistentChange(value) || (value.totalDelta === 0 ? value.settlementStatus !== "none" : value.settlementStatus === "none")) {
    ctx.addIssue({ code: "custom", message: "Correction receipt differs from its frozen amounts or settlement" });
  }
});
export type OrderCorrectionFinancialPreviewV1 = z.infer<typeof OrderCorrectionFinancialPreviewV1Schema>;
export type OrderCorrectionFinancialResponseV1 = z.infer<typeof OrderCorrectionFinancialResponseV1Schema>;

export const OrderCorrectionFinancialContextV1Schema = z.object({
  schemaVersion: z.literal(1), contractVersion: z.literal(PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1),
  data: z.object({ merchantId: identity, storeId: identity, orderId: identity, baseRevision: money,
    currencyCode: z.literal("VND"), minorUnitExponent: z.literal(0), commercialState: z.enum(["active", "cancelled"]),
    componentVersion: z.union([z.literal(1), z.literal(2)]), components: OrderCommercialComponentsV2Schema,
    paymentFee: EffectiveOrderCsvPaymentFeeV5Schema.nullable(), items: z.array(EffectiveOrderLineV1Schema),
  }).strict(),
}).strict().superRefine(({ data }, ctx) => {
  const c = data.components;
  if ((data.componentVersion === 1 ? data.paymentFee !== null || c.paymentFeeMinor !== 0 || c.paymentFeeVatMinor !== 0
    : !OrderPaymentFeeFinancialSnapshotV1Schema.safeParse({ schemaVersion: 1, calculationVersion: 2,
      currencyCode: data.currencyCode, minorUnitExponent: data.minorUnitExponent, paymentFee: data.paymentFee, components: c }).success)
    || (data.commercialState === "active" && (data.items.length === 0
      || data.items.reduce((sum, line) => sum + BigInt(line.quantity) * BigInt(line.unitPriceMinor), 0n) !== BigInt(c.merchandiseGrossMinor)))) {
    ctx.addIssue({ code: "custom", message: "Correction context differs from its stored version, descriptor or lines" });
  }
});
export type OrderCorrectionFinancialContextV1 = z.infer<typeof OrderCorrectionFinancialContextV1Schema>;
