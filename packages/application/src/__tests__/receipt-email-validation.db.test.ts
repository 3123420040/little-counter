import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatingScope } from "@medusa-snus/contracts";
import { connectPlatformClient, type PoolClient } from "../db/client";
import { ensurePlatformSchema } from "../db/schema";
import { shutdownPlatformDb } from "../platform-db";
import type { OperatorContext } from "../services/auth-service";
import { RECEIPT_OPS, sendReceiptEmail } from "../services/receipt-service";

const smtp = vi.hoisted(() => ({ createTransport: vi.fn(), sendMail: vi.fn() }));
vi.mock("nodemailer", () => ({ createTransport: smtp.createTransport }));

const orderId = "order_receipt_email_validation_v19";
const actor: OperatorContext = { operatorId: "op_receipt_validation", role: "owner", displayName: "Receipt Test", organizationId: "org_default" };
const scope: OperatingScope = { scopeKind: "operating", merchantId: "merchant_default", storeId: "store_default", stockLocationId: "sloc_default" };
const keys = ["receipt-invalid-explicit-v19", "receipt-invalid-fallback-v19"];
let client: PoolClient;
const originalSmtpHost = process.env.SMTP_HOST;

async function cleanup() {
  await client.query("DELETE FROM notification.email_receipts WHERE order_id = $1", [orderId]).catch(() => undefined);
  await client.query("DELETE FROM audit.events WHERE action = 'receipt.email_sent' AND subject_id = $1", [orderId]).catch(() => undefined);
  await client.query("DELETE FROM app.idempotency_records WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = ANY($3::text[])", [scope.merchantId, RECEIPT_OPS.sendReceiptEmail, keys]).catch(() => undefined);
  await client.query('DELETE FROM public."order" WHERE id = $1', [orderId]).catch(() => undefined);
}

async function sideEffects() {
  const result = await client.query<{ receipts: string; audits: string; idempotency_records: string }>(`
    SELECT
      (SELECT count(*)::text FROM notification.email_receipts WHERE order_id = $1) AS receipts,
      (SELECT count(*)::text FROM audit.events WHERE action = 'receipt.email_sent' AND subject_id = $1) AS audits,
      (SELECT count(*)::text FROM app.idempotency_records WHERE tenant_id = $2 AND operation = $3 AND idempotency_key = ANY($4::text[])) AS idempotency_records
  `, [orderId, scope.merchantId, RECEIPT_OPS.sendReceiptEmail, keys]);
  return result.rows[0];
}

beforeAll(async () => {
  process.env.SMTP_HOST = "smtp.receipt-test.invalid";
  smtp.sendMail.mockResolvedValue({ messageId: "receipt-test-message" });
  smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail });
  client = await connectPlatformClient();
  await ensurePlatformSchema();
  await cleanup();
  await client.query(`
    INSERT INTO public."order" (id, customer_id, email, status, currency_code, metadata, merchant_id, store_id)
    VALUES ($1, 'cus_demo', 'not-an-email', 'completed', 'vnd', '{"total": 125000, "paymentMethod": "cash"}'::jsonb, $2, $3)
  `, [orderId, scope.merchantId, scope.storeId]);
}, 30000);

beforeEach(() => { smtp.createTransport.mockClear(); smtp.sendMail.mockClear(); });

afterAll(async () => {
  if (client) { await cleanup(); client.release(); }
  if (originalSmtpHost === undefined) delete process.env.SMTP_HOST;
  else process.env.SMTP_HOST = originalSmtpHost;
  await shutdownPlatformDb().catch(() => undefined);
});

describe("receipt email validation before side effects", () => {
  it.each([
    ["explicit", { email: "not-an-email" }, keys[0]],
    ["fallback", {}, keys[1]],
  ])("rejects invalid %s recipient", async (_name, input, key) => {
    await expect(sendReceiptEmail({ "idempotency-key": key }, orderId, input, actor, scope))
      .rejects.toMatchObject({ code: "validation_error", statusCode: 400 });
    expect(await sideEffects()).toEqual({ receipts: "0", audits: "0", idempotency_records: "0" });
    expect(smtp.createTransport).not.toHaveBeenCalled();
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });
});
