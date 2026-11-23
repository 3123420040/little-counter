import { PaymentIntentFinancialResponseV1Schema, PaymentIntentFinancialViewV1Schema, type PaymentIntentFinancialViewV1 } from "@medusa-snus/contracts";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "@medusa-snus/contracts/runtime-capabilities";
import { PlatformError } from "../errors/platform-error";
import { frozenPaymentFeeQuoteContext, paymentFeeFinancialSnapshotV1, totalsFromMetadataV2 } from "./order-total-service";
import type { PaymentIntentRecord } from "./payment-intent-service";

function intentFinancialState(intent: Pick<PaymentIntentRecord, "orderInput" | "metadata" | "amount" | "currencyCode">): PaymentIntentFinancialViewV1["financial"] {
  try {
    const totals = (intent.metadata.quote as { totals?: Record<string, unknown> } | undefined)?.totals;
    const feeFields = (value: object | undefined) => value && Object.keys(value).some(key => key.startsWith("paymentFee"));
    const hasFee = feeFields(intent.orderInput) || feeFields(totals)
      || (totals?.commercialAdjustmentVersion !== undefined && totals.commercialAdjustmentVersion !== 1)
      || (totals?.commercialCalculationVersion !== undefined && totals.commercialCalculationVersion !== 1);
    if (!hasFee) return { status: "legacy" };
    const context = frozenPaymentFeeQuoteContext(intent.metadata, intent.orderInput);
    if (!context || !totals) throw new Error("Missing fee context");
    const snapshot = paymentFeeFinancialSnapshotV1(totalsFromMetadataV2(totals))!;
    if (snapshot.components.totalMinor !== intent.amount || intent.currencyCode.toUpperCase() !== snapshot.currencyCode) throw new Error("Intent amount drift");
    return { status: "available", snapshot };
  } catch {
    // A display failure must not roll back a corrupt quote's manual-review/cancellation recovery.
    return { status: "unavailable", reason: "stored_quote_invalid" };
  }
}

export function assertLegacyPaymentIntentFinancialReadV1(intent: unknown): void {
  const financial = intentFinancialState(intent as PaymentIntentRecord);
  if (financial.status === "unavailable" || (financial.status === "available"
    && (financial.snapshot.components.paymentFeeMinor !== 0 || financial.snapshot.components.paymentFeeVatMinor !== 0))) {
    throw new PlatformError("unsupported_contract", "A compatible order financial contract is required for payment fees", 409);
  }
}

export function paymentIntentFinancialViewV1(value: unknown): PaymentIntentFinancialViewV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlatformError("financial_invariant_error", "Stored payment intent response is invalid", 409);
  const intent = value as PaymentIntentRecord;
  const parsed = PaymentIntentFinancialViewV1Schema.safeParse({
    id: intent.id, merchantId: intent.merchantId, storeId: intent.storeId, provider: intent.provider, status: intent.status,
    amount: intent.amount, currencyCode: intent.currencyCode, referenceCode: intent.referenceCode,
    paymentUrl: intent.paymentUrl, qrPayload: intent.qrPayload, expiresAt: intent.expiresAt, paidAt: intent.paidAt,
    completedOrderId: intent.completedOrderId, manualReviewReason: intent.manualReviewReason,
    createdAt: intent.createdAt, updatedAt: intent.updatedAt, financial: intentFinancialState(intent),
  });
  if (!parsed.success) throw new PlatformError("financial_invariant_error", "Stored payment intent response is invalid", 409);
  return parsed.data;
}

export function paymentIntentFinancialResponseV1(response: { data: unknown; order?: unknown }) {
  const data = paymentIntentFinancialViewV1(response.data);
  return PaymentIntentFinancialResponseV1Schema.parse({ schemaVersion: 1, contractVersion: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
    data, ...(response.order ? { order: { orderId: data.completedOrderId } } : {}) });
}
