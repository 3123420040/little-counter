import { z } from "zod";
import { PaymentFeeInputV1Schema, OrderPaymentFeeFinancialSnapshotV1Schema } from "./order-payment-fee";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "./runtime-capabilities";
export const CartPaymentFeeConfirmationTokenV1Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const CartPaymentFeePreviewInputV1Schema = z.object({
  items: z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int().safe().positive().max(99) }).strict()).min(1),
  discountType: z.enum(["percent", "amount"]).optional(), discountValue: z.number().finite().nonnegative().optional(),
  discountPercent: z.number().finite().min(0).max(100).optional(),
  shippingFee: z.number().int().safe().nonnegative().optional(),
  ...PaymentFeeInputV1Schema.shape,
}).strict().superRefine((value, ctx) => {
  if (!PaymentFeeInputV1Schema.safeParse({ paymentFeeType: value.paymentFeeType, paymentFeeValue: value.paymentFeeValue }).success) {
    ctx.addIssue({ code: "custom", message: "Invalid payment fee descriptor" });
  }
  if (new Set(value.items.map(item => item.variantId)).size !== value.items.length) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "Duplicate cart variants are not supported" });
  }
  if ((value.discountType !== undefined || value.discountValue !== undefined)
    && (value.discountType === undefined || value.discountValue === undefined || value.discountPercent !== undefined
      || (value.discountType === "amount" ? !Number.isSafeInteger(value.discountValue) : value.discountValue > 100))) {
    ctx.addIssue({ code: "custom", message: "Discount requires one complete descriptor" });
  }
});
export type CartPaymentFeePreviewInputV1 = z.infer<typeof CartPaymentFeePreviewInputV1Schema>;

export const CartPaymentFeePreviewV1Schema = z.object({
  schemaVersion: z.literal(1), contractVersion: z.literal(PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1),
  data: z.object({
    merchantId: z.string().min(1), storeId: z.string().min(1), input: CartPaymentFeePreviewInputV1Schema,
    confirmationToken: CartPaymentFeeConfirmationTokenV1Schema,
    financial: OrderPaymentFeeFinancialSnapshotV1Schema,
    items: z.array(z.object({ variantId: z.string().min(1), productId: z.string().min(1), sku: z.string(), name: z.string(),
      quantity: z.number().int().safe().positive(), unitPrice: z.number().int().safe().nonnegative(),
      lineTotal: z.number().int().safe().nonnegative(), stock: z.number().int().safe(),
    }).strict()).min(1),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const { input, financial, items } = value.data;
  if (!CartPaymentFeePreviewInputV1Schema.safeParse(input).success || !OrderPaymentFeeFinancialSnapshotV1Schema.safeParse(financial).success) return;
  const fail = () => ctx.addIssue({ code: "custom", message: "Cart preview does not match its input, lines or frozen amounts" });
  const c = financial.components, fee = financial.paymentFee;
  if (fee.paymentFeeType !== input.paymentFeeType || fee.paymentFeeValue !== input.paymentFeeValue || c.shippingMinor !== (input.shippingFee ?? 0)
    || items.length !== input.items.length || new Set(items.map(item => item.variantId)).size !== items.length
    || items.some(item => !input.items.some(source => source.variantId === item.variantId && source.quantity === item.quantity)
      || BigInt(item.quantity) * BigInt(item.unitPrice) !== BigInt(item.lineTotal))
    || items.reduce((total, item) => total + BigInt(item.lineTotal), 0n) !== BigInt(c.merchandiseGrossMinor)) {
    fail(); return;
  }
  const amountDiscount = input.discountType === "amount";
  const discountValue = input.discountValue ?? input.discountPercent ?? 0;
  const expectedDiscount = amountDiscount ? discountValue : Math.round(c.merchandiseGrossMinor * (discountValue / 100));
  if (c.discountMinor !== expectedDiscount) fail();
});
export type CartPaymentFeePreviewV1 = z.infer<typeof CartPaymentFeePreviewV1Schema>;
