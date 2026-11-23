import { withScopedIdempotency } from "../db/idempotency";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import type { OperatorContext } from "./auth-service";
import { formatOrder } from "./order-service";
import { ReceiptEmailSchema, type OperatingScope, type ReportScope } from "@medusa-snus/contracts";
import { safeErrorCode } from "../utils/safe-error";

// Stable operation codes used with withScopedIdempotency.
export const RECEIPT_OPS = {
  sendReceiptEmail: "receipt.send_email",
} as const;

export interface ReceiptEmailInput {
  email?: string;
}

export function requireValidReceiptEmail(value: unknown): string {
  const parsed = ReceiptEmailSchema.safeParse({ email: value });
  if (!parsed.success || !parsed.data.email) {
    throw new PlatformError("validation_error", "A valid receipt email is required", 400);
  }
  return parsed.data.email;
}

export function receiptDeliveryFailureReason(error: unknown): string {
  return `email_delivery_failed:${safeErrorCode(error)}`;
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedTransaction(fn);
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return withConnectedClient(fn);
}

function formatCurrency(value: number): string {
  return `${Math.round(value).toLocaleString("vi-VN")} VND`;
}

function receiptStoreInfo() {
  return {
    name: process.env.STORE_NAME?.trim() || "Store",
    address: process.env.STORE_ADDRESS?.trim() || "",
  };
}

async function resolveReceiptOrderId(client: PoolClient, orderRef: string, scope: ReportScope): Promise<string> {
  const result = await client.query(`
    SELECT id
    FROM public."order"
    WHERE deleted_at IS NULL
      AND (
        id = $1
        OR custom_display_id = $1
        OR display_id::text = $1
      )
      AND merchant_id = $2
      AND store_id = ANY($3::text[])
    LIMIT 1
  `, [orderRef, scope.merchantId, scope.storeIds]);
  const id = result.rows[0]?.id;
  if (!id) throw new PlatformError("resource_not_found", "Order not found", 404);
  return String(id);
}

export function buildReceiptText(order: {
  orderNumber?: unknown;
  createdAt?: unknown;
  customer?: { first_name?: unknown; last_name?: unknown; phone?: unknown };
  items?: Array<{ name?: unknown; quantity?: unknown; unitPrice?: unknown; lineTotal?: unknown }>;
  subtotal?: unknown;
  discount?: unknown;
  shippingFee?: unknown;
  tax?: unknown;
  total?: unknown;
  paymentMethod?: unknown;
}): string {
  const store = receiptStoreInfo();
  const orderNumber = String(order.orderNumber || "");
  const createdAt = order.createdAt ? new Date(String(order.createdAt)).toLocaleString("vi-VN") : "";
  const customerName = [order.customer?.last_name, order.customer?.first_name].filter(Boolean).join(" ").trim();
  const customerLine = customerName || order.customer?.phone ? `Customer: ${customerName || order.customer?.phone}` : "Customer: Walk-in";
  const lines = [
    store.name,
    store.address,
    `Receipt: ${orderNumber}`,
    createdAt ? `Date: ${createdAt}` : "",
    customerLine,
    "",
    "Items:",
    ...(order.items || []).map((item) => {
      const quantity = Number(item.quantity || 0);
      const unitPrice = Number(item.unitPrice || 0);
      const lineTotal = Number(item.lineTotal || quantity * unitPrice);
      return `- ${String(item.name || "Item")} x${quantity} @ ${formatCurrency(unitPrice)} = ${formatCurrency(lineTotal)}`;
    }),
    "",
    `Subtotal: ${formatCurrency(Number(order.subtotal || 0))}`,
    `Discount: ${formatCurrency(Number(order.discount || 0))}`,
    Number(order.shippingFee || 0) > 0 ? `Shipping: ${formatCurrency(Number(order.shippingFee || 0))}` : "",
    `Tax: ${formatCurrency(Number(order.tax || 0))}`,
    `Total: ${formatCurrency(Number(order.total || 0))}`,
    `Payment: ${String(order.paymentMethod || "")}`,
  ].filter((line) => line !== "");
  return `${lines.join("\n")}\n`;
}

export async function getReceiptText(orderId: string, scope: ReportScope): Promise<string> {
  return withClient(async (client) => {
    const resolvedOrderId = await resolveReceiptOrderId(client, orderId, scope);
    const formatted = await formatOrder(client, resolvedOrderId);
    if (!formatted) throw new PlatformError("resource_not_found", "Order not found", 404);
    return buildReceiptText(formatted);
  });
}

export async function getReceiptPdfBuffer(orderId: string, scope: ReportScope): Promise<Buffer> {
  const text = await getReceiptText(orderId, scope);
  const { default: PDFDocument } = await import("pdfkit");
  const document = new PDFDocument({ size: "A6", margin: 24, info: { Title: `Receipt ${orderId}` } });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  document.fontSize(10).text(text, { lineGap: 2 });
  document.end();
  return done;
}

export async function sendReceiptEmail(
  headers: HeadersLike,
  orderId: string,
  input: ReceiptEmailInput,
  actor: OperatorContext,
  scope: OperatingScope,
) {
  if (!scope?.merchantId) {
    throw new PlatformError("scope_required", "sendReceiptEmail requires tenantId for scoped idempotency", 409);
  }
  const parsedInput = ReceiptEmailSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new PlatformError("validation_error", "A valid receipt email is required", 400);
  }
  const explicitRecipient = parsedInput.data.email;
  return withTransaction(async (client) => {
    const result = await withScopedIdempotency(client, headers, { orderId, ...parsedInput.data }, scope.merchantId, RECEIPT_OPS.sendReceiptEmail, async () => {
      const formatted = await formatOrder(client, orderId);
      if (!formatted) throw new PlatformError("resource_not_found", "Order not found", 404);
      // Hard tenant assertion: receipt must only be sent for orders that
      // belong to the active merchant. Fails closed inside the transaction
      // before any external SMTP call.
      if (!formatted.merchantId || formatted.merchantId !== scope.merchantId) {
        throw new PlatformError("forbidden", "Order belongs to a different merchant", 403);
      }
      if (!formatted.storeId || formatted.storeId !== scope.storeId) {
        throw new PlatformError("forbidden", "Order belongs to a different store", 403);
      }

      const recipient = explicitRecipient ?? requireValidReceiptEmail(formatted.customer?.email);

      let status: "sent" | "failed" = "sent";
      let error: string | null = null;
      if (process.env.SMTP_HOST) {
        try {
          const nodemailer = await import("nodemailer");
          const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 587),
            secure: process.env.SMTP_SECURE === "true",
            auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
          });
          await transporter.sendMail({
            from: process.env.SMTP_FROM || `${receiptStoreInfo().name} <no-reply@snus.local>`,
            to: recipient,
            subject: `Hóa đơn ${formatted.orderNumber}`,
            text: `Cảm ơn quý khách. Tổng thanh toán: ${formatted.total.toLocaleString("vi-VN")} VND`,
          });
        } catch (err) {
          status = "failed";
          error = receiptDeliveryFailureReason(err);
        }
      }
      const receipt = await client.query(`
        INSERT INTO notification.email_receipts (order_id, recipient, status, error, sent_at)
        VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'sent' THEN now() ELSE NULL END)
        RETURNING *
      `, [orderId, recipient, status, error]);
      await recordAuditEntry(client, actor, "receipt.email_sent", "order", orderId, {
        after: { recipient, status },
        merchantId: scope.merchantId,
        storeId: scope.storeId,
      });
      return { data: receipt.rows[0] };
    });
    return result;
  });
}
