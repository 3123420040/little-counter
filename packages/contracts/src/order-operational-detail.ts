import { z } from "zod";

const money = z.number().int().safe();
const optionalText = z.string().nullable().optional();

// Operational metadata accompanies the negotiated financial detail; it has no competing order totals.
export const OrderOperationalDetailV1Schema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), merchantId: z.string().min(1), storeId: z.string().min(1),
  paymentMethod: z.string(), paymentStatus: z.string().nullable(), manualBankConfirmationEnabled: z.boolean(),
  paymentEntries: z.array(z.object({
    id: z.string().min(1), direction: z.string(), method: z.string(), amount: z.number().finite().nonnegative(), currencyCode: z.string(), status: z.string(),
    effectiveStatus: z.enum(["pending", "partially_collected", "posted"]).optional(),
    collectedAmountMinor: money.nonnegative().optional(), remainingAmountMinor: money.nonnegative().optional(),
    reference: optionalText, reason: optionalText, paymentIntentId: optionalText, paymentProvider: optionalText,
    providerEventId: optionalText, providerReference: optionalText, referenceCode: optionalText,
    providerTransactionId: optionalText, providerTransactionHash: optionalText, providerNetwork: optionalText,
    providerPayCurrency: optionalText, source: optionalText, correctionId: optionalText,
    canonicalPaymentEventId: optionalText, customerRefundPayableId: optionalText,
    createdBy: z.string(), createdAt: z.string().datetime().optional(),
  }).strict()),
  canonicalPaymentSummary: z.object({
    recordedGrossCollectionsMinor: money.nonnegative(), refundsMinor: money.nonnegative(), reversalsMinor: money.nonnegative(),
    chargebacksMinor: money.nonnegative(), negativeCollectionsMinor: money.nonnegative(), netCollectionsMinor: money,
    customerRefundPayableMinor: money.nonnegative(),
  }).strict(),
  cancellationAccess: z.object({ allowed: z.boolean(), mode: z.enum(["full", "own"]).nullable(), reasonCode: z.string().nullable() }).strict(),
  notes: z.string().nullable(), salesChannel: z.string(), salesChannelLabel: z.string(), salesChannelLocked: z.boolean(),
  salesChannelLockReason: z.string().nullable(), sourceFlow: z.string().nullable(),
  createdBy: z.object({
    operatorId: z.string().nullable(), actorType: z.enum(["staff", "partner"]), actorId: z.string(),
    displayName: z.string(), role: z.string(), channel: z.string().nullable(), channelUserId: z.string().nullable(),
    serviceIdentity: z.string().nullable(), createdAt: z.string().datetime().optional(),
  }).strict().optional(),
  stockAdjustments: z.array(z.object({
    type: z.string().optional(), reasonCode: z.string().optional(), reason: z.string().optional(),
    productId: z.string().optional(), variantId: z.string().optional(), productName: z.string().optional(), sku: z.string().optional(),
    systemStockBefore: z.number().finite().optional(), requestedQuantity: z.number().finite().optional(),
    adjustedQuantity: z.number().finite().optional(), unitCost: z.number().finite().optional(), inventoryValue: z.number().finite().optional(),
    performedBy: z.string().optional(), movementId: optionalText,
  }).strip()),
  correctionSummary: z.object({ latestRevision: z.number().int().nonnegative(), effectiveTotal: z.number().finite().nonnegative().nullable(), hasPendingSettlement: z.boolean() }).strict(),
  corrections: z.array(z.object({ id: z.string(), revision: z.number().int().nonnegative(), status: z.string(), reason: z.string(), totalDelta: z.number().finite(), createdAt: z.string().datetime() }).strip()),
}).strict();
export type OrderOperationalDetailV1 = z.infer<typeof OrderOperationalDetailV1Schema>;
