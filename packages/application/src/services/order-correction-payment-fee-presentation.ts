import { OrderCorrectionFinancialPreviewV1Schema, OrderCorrectionFinancialResponseV1Schema, OrderPaymentFeeFinancialSnapshotV1Schema } from "@medusa-snus/contracts";
import { PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1 } from "@medusa-snus/contracts/runtime-capabilities";
import { PlatformError } from "../errors/platform-error";
import { paymentFeeFinancialSnapshotV1, type NormalizedOrderTotalsV2 } from "./order-total-service";

const invalid = () => new PlatformError("financial_invariant_error", "Correction response is inconsistent with its frozen amounts", 409);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function financialState(totals: Record<string, unknown>, frozen: unknown) {
  if (totals.commercialAdjustmentVersion === 1) {
    if (frozen != null || Object.keys(totals).some(key => key.startsWith("paymentFee"))) throw invalid();
    return { status: "legacy" as const };
  }
  if (totals.commercialAdjustmentVersion !== 2) throw invalid();
  const snapshot = OrderPaymentFeeFinancialSnapshotV1Schema.safeParse(frozen);
  if (!snapshot.success || JSON.stringify(snapshot.data) !== JSON.stringify(paymentFeeFinancialSnapshotV1(totals as unknown as NormalizedOrderTotalsV2))) throw invalid();
  return { status: "available" as const, snapshot: snapshot.data };
}
function change(raw: Record<string, unknown>) {
  const before = object(raw.beforeTotals), after = object(raw.afterTotals);
  return { beforeTotals: { total: before.total }, afterTotals: { total: after.total }, totalDelta: raw.totalDelta,
    beforeFinancial: financialState(before, raw.beforeFinancial), afterFinancial: financialState(after, raw.afterFinancial) };
}
export function orderCorrectionFinancialPreviewV1(response: { data: unknown }, orderId: string, scope: { merchantId: string; storeId: string }) {
  const raw = object(response.data);
  const parsed = OrderCorrectionFinancialPreviewV1Schema.safeParse({ schemaVersion: 1, contractVersion: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
    data: { merchantId: scope.merchantId, storeId: scope.storeId, orderId, ...change(raw), baseRevision: raw.baseRevision, nextRevision: raw.nextRevision,
      cogsDelta: raw.cogsDelta, confirmationToken: raw.confirmationToken, settlement: raw.settlement, items: raw.items } });
  if (!parsed.success || raw.orderId !== orderId) throw invalid();
  return parsed.data;
}
export function orderCorrectionFinancialResponseV1(response: { data: unknown }, orderId: string, scope: { merchantId: string; storeId: string }) {
  const raw = object(object(response.data).correction);
  const parsed = OrderCorrectionFinancialResponseV1Schema.safeParse({ schemaVersion: 1, contractVersion: PAYMENT_FEE_WRITE_HTTP_CONTRACT_V1,
    data: { merchantId: scope.merchantId, storeId: scope.storeId, orderId, correction: { ...change(raw), id: raw.id, revision: raw.revision, status: raw.status,
      reason: raw.reason, paymentEntryId: raw.paymentEntryId, settlementStatus: raw.settlementStatus } } });
  if (!parsed.success) throw invalid();
  return parsed.data;
}
