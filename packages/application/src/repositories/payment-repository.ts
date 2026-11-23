import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";

export type PaymentDirection = "charge" | "refund";
export type PaymentEntryStatus = "pending" | "posted" | "voided";

export interface PaymentEntryInput {
  organizationId?: string;
  orderId: string;
  merchantId: string;
  storeId: string;
  direction: PaymentDirection;
  method: string;
  amount: number;
  currencyCode?: string;
  status: PaymentEntryStatus;
  reference?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface PaymentEntry {
  id: string;
  organizationId: string;
  orderId: string;
  merchantId: string;
  storeId: string;
  direction: PaymentDirection;
  method: string;
  amount: number;
  currencyCode: string;
  status: PaymentEntryStatus;
  reference: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

function requireNonEmpty(value: string | undefined | null, field: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new PlatformError("validation_error", `${field} is required`, 400);
  return trimmed;
}

function requirePositiveAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PlatformError("validation_error", "Payment amount must be greater than zero", 400);
  }
  return amount;
}

export async function recordPaymentEntry(client: PoolClient, input: PaymentEntryInput): Promise<PaymentEntry> {
  const orderId = requireNonEmpty(input.orderId, "orderId");
  const merchantId = requireNonEmpty(input.merchantId, "merchantId");
  const storeId = requireNonEmpty(input.storeId, "storeId");
  const method = requireNonEmpty(input.method, "method");
  const createdBy = requireNonEmpty(input.createdBy, "createdBy");
  const amount = requirePositiveAmount(input.amount);

  const result = await client.query(`
    INSERT INTO app.payment_entries (
      organization_id,
      order_id,
      merchant_id,
      store_id,
      direction,
      method,
      amount,
      currency_code,
      status,
      reference,
      reason,
      metadata,
      created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
    RETURNING
      id::text,
      organization_id,
      order_id,
      merchant_id,
      store_id,
      direction,
      method,
      amount::numeric,
      currency_code,
      status,
      reference,
      reason,
      metadata,
      created_by,
      created_at
  `, [
    input.organizationId || "org_default",
    orderId,
    merchantId,
    storeId,
    input.direction,
    method,
    amount,
    input.currencyCode || "vnd",
    input.status,
    input.reference || null,
    input.reason || null,
    JSON.stringify(input.metadata || {}),
    createdBy,
  ]);

  const row = result.rows[0] as Record<string, unknown>;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    orderId: String(row.order_id),
    merchantId: String(row.merchant_id),
    storeId: String(row.store_id),
    direction: row.direction as PaymentDirection,
    method: String(row.method),
    amount: Number(row.amount),
    currencyCode: String(row.currency_code),
    status: row.status as PaymentEntryStatus,
    reference: row.reference === null ? null : String(row.reference),
    reason: row.reason === null ? null : String(row.reason),
    metadata: (row.metadata || {}) as Record<string, unknown>,
    createdBy: String(row.created_by),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
