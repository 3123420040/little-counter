import { z } from "zod";
import { OrderPaymentFeeFinancialSnapshotV1Schema } from "./order-payment-fee";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "./runtime-capabilities";
const money = z.number().int().safe().nonnegative();
export const CheckoutPaymentFeeResponseV1Schema = z.object({
  schemaVersion: z.literal(1), contractVersion: z.literal(PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1),
  data: z.object({
    orderId: z.string().min(1), orderNumber: z.string().min(1), merchantId: z.string().min(1), storeId: z.string().min(1),
    status: z.string().min(1), financial: OrderPaymentFeeFinancialSnapshotV1Schema,
    subtotal: money, merchandisePayable: money, shippingFee: money, tax: money, discount: money, total: money, change: money,
    paymentMethod: z.enum(["cash", "bank_transfer", "cod", "sepay_va", "nowpayments", "mock"]),
    customerId: z.string().nullable().optional(), createdAt: z.string().datetime(),
    shiftId: z.string().nullable().optional(), shiftOpenedAt: z.string().datetime().nullable().optional(),
    shiftAttribution: z.enum(["online_open_shift", "offline_cached_shift", "legacy_time_window", "unassigned"]).nullable().optional(),
    shiftQueuedAt: z.string().datetime().nullable().optional(),
    items: z.array(z.object({ productId: z.string().min(1), variantId: z.string().min(1), name: z.string(),
      quantity: z.number().int().safe().positive(), unitPrice: money, lineTotal: money,
    }).strict()).min(1),
  }).strict(),
}).strict().superRefine(({ data }, ctx) => {
  const c = data.financial.components;
  if (data.subtotal !== c.merchandiseGrossMinor || data.merchandisePayable !== c.merchandiseNetMinor
    || data.shippingFee !== c.shippingMinor || data.tax !== c.vatMinor || data.discount !== c.discountMinor || data.total !== c.totalMinor
    || (data.paymentMethod !== "cash" && data.change !== 0)
    || data.items.some(item => BigInt(item.quantity) * BigInt(item.unitPrice) !== BigInt(item.lineTotal))
    || data.items.reduce((sum, item) => sum + BigInt(item.lineTotal), 0n) !== BigInt(data.subtotal)) {
    ctx.addIssue({ code: "custom", message: "Checkout receipt differs from its frozen financial snapshot or items" });
  }
});
export type CheckoutPaymentFeeResponseV1 = z.infer<typeof CheckoutPaymentFeeResponseV1Schema>;
