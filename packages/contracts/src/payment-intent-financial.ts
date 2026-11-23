import { z } from "zod";
import { OrderPaymentFeeFinancialSnapshotV1Schema } from "./order-payment-fee";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "./runtime-capabilities";

export const PaymentIntentFinancialViewV1Schema = z.object({
  id: z.string().min(1), merchantId: z.string().min(1), storeId: z.string().min(1),
  provider: z.enum(["mock", "sepay_va", "nowpayments"]),
  status: z.enum(["pending", "paid", "completed", "expired", "cancelled", "manual_review", "failed"]),
  amount: z.number().int().safe().nonnegative(), currencyCode: z.enum(["vnd", "VND"]),
  referenceCode: z.string().min(1), paymentUrl: z.string().nullable(), qrPayload: z.string().nullable(),
  expiresAt: z.string().datetime(), paidAt: z.string().datetime().nullable(),
  completedOrderId: z.string().min(1).nullable(), manualReviewReason: z.string().nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  financial: z.discriminatedUnion("status", [
    z.object({ status: z.literal("available"), snapshot: OrderPaymentFeeFinancialSnapshotV1Schema }).strict(),
    z.object({ status: z.literal("legacy") }).strict(),
    z.object({ status: z.literal("unavailable"), reason: z.literal("stored_quote_invalid") }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  if ((value.financial.status === "available" && value.financial.snapshot.components.totalMinor !== value.amount)
    || (value.status === "completed" && !value.completedOrderId)) {
    ctx.addIssue({ code: "custom", message: "Payment intent amount or completion identity is inconsistent" });
  }
});
export type PaymentIntentFinancialViewV1 = z.infer<typeof PaymentIntentFinancialViewV1Schema>;

export const PaymentIntentFinancialResponseV1Schema = z.object({
  schemaVersion: z.literal(1), contractVersion: z.literal(PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1),
  data: PaymentIntentFinancialViewV1Schema,
  order: z.object({ orderId: z.string().min(1) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.order && value.order.orderId !== value.data.completedOrderId) {
    ctx.addIssue({ code: "custom", message: "Completed order reference differs from payment intent" });
  }
});
export type PaymentIntentFinancialResponseV1 = z.infer<typeof PaymentIntentFinancialResponseV1Schema>;

export const PaymentIntentFinancialListResponseV1Schema = z.object({
  schemaVersion: z.literal(1), contractVersion: z.literal(PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1),
  data: z.array(PaymentIntentFinancialViewV1Schema), count: z.number().int().safe().nonnegative(),
  limit: z.number().int().min(1).max(100), offset: z.number().int().safe().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.data.length > value.limit || new Set(value.data.map(intent => intent.id)).size !== value.data.length
    || (value.data.length > 0 && BigInt(value.offset) + BigInt(value.data.length) > BigInt(value.count))) {
    ctx.addIssue({ code: "custom", message: "Payment intent pagination is inconsistent" });
  }
});
export type PaymentIntentFinancialListResponseV1 = z.infer<typeof PaymentIntentFinancialListResponseV1Schema>;

const queryInteger = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
export const PaymentIntentFinancialListFiltersV1Schema = z.object({
  status: z.union([z.literal("all"), PaymentIntentFinancialViewV1Schema.shape.status]).optional(),
  provider: z.union([z.literal("all"), PaymentIntentFinancialViewV1Schema.shape.provider]).optional(),
  limit: z.preprocess(queryInteger, z.number().int().min(1).max(100)).optional(),
  offset: z.preprocess(queryInteger, z.number().int().safe().nonnegative()).optional(),
}).strict();
export type PaymentIntentFinancialListFiltersV1 = z.infer<typeof PaymentIntentFinancialListFiltersV1Schema>;

export const PaymentIntentCreationReceiptInputV1Schema = z.object({ requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const PAYMENT_INTENT_CREATION_KEY_NAMESPACE_V1 = "snus-pos-pi-recovery.v1:";
export function paymentIntentCreationKeyPrefixV1(operatorId: string, storeId: string) {
  return `${PAYMENT_INTENT_CREATION_KEY_NAMESPACE_V1}${encodeURIComponent(operatorId)}:${encodeURIComponent(storeId)}:`;
}
export const PaymentIntentCreationReceiptV1Schema = z.object({
  schemaVersion: z.literal(1), contractVersion: z.literal(PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1),
  requestHash: PaymentIntentCreationReceiptInputV1Schema.shape.requestHash,
  data: z.discriminatedUnion("status", [
    z.object({ status: z.literal("resolved"), intent: PaymentIntentFinancialViewV1Schema }).strict(),
    z.object({ status: z.literal("unresolved") }).strict(),
    z.object({ status: z.literal("closed") }).strict(),
  ]),
}).strict();
export type PaymentIntentCreationReceiptV1 = z.infer<typeof PaymentIntentCreationReceiptV1Schema>;
