import type { PoolClient } from "../db/client";
import {
  recordPaymentEntry,
  type PaymentEntry,
  type PaymentEntryStatus,
} from "../repositories/payment-repository";
import {
  PAYMENT_ENTRY_COMPATIBILITY_DEFAULT_CONFIG_V1,
  selectPaymentEntryCompatibilityV1,
  type CanonicalChargeResultV1,
} from "./payment-entry-compatibility-policy";

export interface SaleChargeInput {
  organizationId?: string;
  orderId: string;
  orderNumber: string;
  merchantId: string;
  storeId: string;
  method: string;
  amount: number;
  amountReceived: number;
  change: number;
  subtotal: number;
  discount: number;
  tax: number;
  source: "pos" | "remote";
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export interface SaleChargeCompatibilityOptionsV1 {
  config?: { enabled: boolean };
  boundary?: "order_created";
  canonicalCharge?: CanonicalChargeResultV1;
}

export interface RefundablePaymentBalance {
  charged: number;
  refunded: number;
  refundable: number;
}

export interface OrderRefundInput {
  orderId: string;
  orderNumber: string;
  merchantId: string;
  storeId: string;
  amount: number;
  reason: string;
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export const EXTERNAL_PROVIDER_PAYMENT_METHODS = new Set(["sepay_va", "nowpayments", "crypto_usdc", "crypto_usdt"]);

export function isExternalProviderPaymentMethod(method: string): boolean {
  return EXTERNAL_PROVIDER_PAYMENT_METHODS.has(method);
}

export function paymentAccountForMethod(method: unknown): string {
  if (method === "bank_transfer" || method === "sepay_va" || method === "nowpayments") return "1121";
  if (method === "crypto_usdc" || method === "crypto_usdt") return "1122";
  if (method === "cod") return "1311";
  return "1111";
}

export function paymentStatusForChargeMethod(method: string): PaymentEntryStatus {
  return method === "cod" ? "pending" : "posted";
}

export async function recordSaleCharge(
  client: PoolClient,
  input: SaleChargeInput,
  compatibilityOptions: SaleChargeCompatibilityOptionsV1 = {},
): Promise<PaymentEntry> {
  const method = input.method || "cash";
  const legacyStatus = paymentStatusForChargeMethod(method);
  const compatibility = selectPaymentEntryCompatibilityV1({
    boundary: compatibilityOptions.boundary || "order_created",
    paymentMethod: method,
    legacyStatus,
    legacyAmountMinor: input.amount,
    canonicalCharge: compatibilityOptions.canonicalCharge,
  }, compatibilityOptions.config || PAYMENT_ENTRY_COMPATIBILITY_DEFAULT_CONFIG_V1);
  return recordPaymentEntry(client, {
    organizationId: input.organizationId,
    orderId: input.orderId,
    merchantId: input.merchantId,
    storeId: input.storeId,
    direction: "charge",
    method,
    amount: input.amount,
    currencyCode: "vnd",
    status: compatibility.legacyStatus,
    reference: input.orderNumber,
    metadata: {
      source: input.source,
      orderNumber: input.orderNumber,
      amountReceived: input.amountReceived,
      change: input.change,
      subtotal: input.subtotal,
      discount: input.discount,
      tax: input.tax,
      ...input.metadata,
      ...compatibility.legacyMetadata,
    },
    createdBy: input.createdBy,
  });
}

export async function getRefundablePaymentBalance(client: PoolClient, orderId: string): Promise<RefundablePaymentBalance> {
  const result = await client.query(`
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'charge' AND status = 'posted' THEN amount ELSE 0 END), 0)::numeric AS charged,
      COALESCE(SUM(CASE WHEN direction = 'refund' AND status = 'posted' THEN amount ELSE 0 END), 0)::numeric AS refunded
    FROM app.payment_entries
    WHERE order_id = $1
  `, [orderId]);

  const charged = Number(result.rows[0]?.charged || 0);
  const refunded = Number(result.rows[0]?.refunded || 0);
  return { charged, refunded, refundable: Math.max(0, charged - refunded) };
}

export async function recordOrderRefund(client: PoolClient, input: OrderRefundInput): Promise<PaymentEntry> {
  return recordPaymentEntry(client, {
    orderId: input.orderId,
    merchantId: input.merchantId,
    storeId: input.storeId,
    direction: "refund",
    method: "refund",
    amount: input.amount,
    currencyCode: "vnd",
    status: "posted",
    reference: input.orderNumber,
    reason: input.reason,
    metadata: {
      orderNumber: input.orderNumber,
      ...input.metadata,
    },
    createdBy: input.createdBy,
  });
}
