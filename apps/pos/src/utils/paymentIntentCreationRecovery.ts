import { z } from "zod";
import { CreatePaymentIntentFinancialInputV1Schema, PaymentIntentCreationReceiptInputV1Schema, PaymentIntentFinancialViewV1Schema } from "@medusa-snus/contracts";
import type { createPaymentIntent } from "../api/endpoints";

const prefix = "snus.intent-creation.v1:";
export const PAYMENT_INTENT_CREATION_RECOVERY_CHANGED = "snus:intent-creation-recovery-changed";
const RecordSchema = z.object({
  schemaVersion: z.literal(1), operatorId: z.string().min(1), merchantId: z.string().min(1), storeId: z.string().min(1),
  idempotencyKey: z.string().min(1), requestHash: PaymentIntentCreationReceiptInputV1Schema.shape.requestHash,
  provider: PaymentIntentFinancialViewV1Schema.shape.provider, createdAt: z.string().datetime(),
}).strict();
export type PendingPaymentIntentCreation = z.infer<typeof RecordSchema>;
type Owner = Pick<PendingPaymentIntentCreation, "operatorId" | "merchantId" | "storeId">;
function readRecord(serialized: string): PendingPaymentIntentCreation {
  try { return RecordSchema.parse(JSON.parse(serialized)); }
  catch { throw new Error("Dữ liệu khôi phục chưa xác minh được. Giữ lại để kiểm tra trước khi tạo yêu cầu mới."); }
}
function recordKey(record: Pick<PendingPaymentIntentCreation, "operatorId" | "merchantId" | "storeId" | "idempotencyKey">) {
  return prefix + JSON.stringify([record.operatorId, record.merchantId, record.storeId, record.idempotencyKey]);
}

/** Persist only correlation metadata; the original wire body stays out of browser storage. */
export async function preservePaymentIntentCreation(input: Parameters<typeof createPaymentIntent>[0],
  scope: { operatorId?: string; merchantId: string; storeId: string }): Promise<PendingPaymentIntentCreation> {
  CreatePaymentIntentFinancialInputV1Schema.parse({ provider: input.provider, order: input.order });
  if (!input.idempotencyKey.trim()) throw new Error("Thiếu mã yêu cầu thanh toán ban đầu.");
  if (!globalThis.crypto?.subtle) throw new Error("Trình duyệt chưa hỗ trợ lưu mã khôi phục thanh toán an toàn.");
  const bytes = new TextEncoder().encode(JSON.stringify({ provider: input.provider, order: input.order }));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const requestHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const record = RecordSchema.parse({ schemaVersion: 1, operatorId: scope.operatorId, merchantId: scope.merchantId,
    storeId: scope.storeId, idempotencyKey: input.idempotencyKey, requestHash, provider: input.provider, createdAt: new Date().toISOString() });
  const key = recordKey(record);
  let previous: string | null;
  try { previous = localStorage.getItem(key); }
  catch { throw new Error("Chưa đọc được mã khôi phục. Kiểm tra bộ nhớ trình duyệt trước khi gửi yêu cầu mới."); }
  if (previous !== null) {
    const captured = readRecord(previous);
    if (recordKey(captured) !== key || captured.requestHash !== record.requestHash || captured.provider !== record.provider) {
      throw new Error("Mã yêu cầu đã được lưu với nội dung khác. Kiểm tra thanh toán ban đầu trước khi tiếp tục.");
    }
    return captured;
  }
  const serialized = JSON.stringify(record);
  try {
    localStorage.setItem(key, serialized);
    if (localStorage.getItem(key) !== serialized) throw new Error("Unverified recovery write");
  } catch { throw new Error("Chưa lưu được mã khôi phục thanh toán. Giữ giỏ hàng và thử lại trước khi gửi yêu cầu mới."); }
  window.dispatchEvent(new Event(PAYMENT_INTENT_CREATION_RECOVERY_CHANGED));
  return record;
}

export function listPendingPaymentIntentCreations(scope: Owner): PendingPaymentIntentCreation[] {
  const selectedPrefix = prefix + JSON.stringify([scope.operatorId, scope.merchantId, scope.storeId]).slice(0, -1) + ",";
  const result: PendingPaymentIntentCreation[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(selectedPrefix)) continue;
    const record = readRecord(localStorage.getItem(key)!);
    if (recordKey(record) !== key) throw new Error("Dữ liệu khôi phục không khớp phạm vi đã lưu. Giữ lại để kiểm tra.");
    result.push(record);
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.idempotencyKey.localeCompare(b.idempotencyKey));
}

export function removePendingPaymentIntentCreation(record: PendingPaymentIntentCreation) {
  const key = recordKey(record), value = localStorage.getItem(key);
  if (value === null) return;
  const captured = readRecord(value);
  if (recordKey(captured) !== key || captured.requestHash !== record.requestHash || captured.provider !== record.provider) {
    throw new Error("Mã khôi phục đã thay đổi; chưa thể xóa kết quả chưa xác minh.");
  }
  localStorage.removeItem(key);
  window.dispatchEvent(new Event(PAYMENT_INTENT_CREATION_RECOVERY_CHANGED));
}
