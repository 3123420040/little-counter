import { useEffect, useRef, useState } from "react";
import { Button, InlineError, StatusPill } from "@medusa-snus/ui";
import { HandCoins } from "lucide-react";
import { createClientIdempotencyKey } from "../api/endpoints";

export type OrderRefundDialogProps = {
  open: boolean;
  orderNumber: string;
  orderId: string;
  amountMinor: number;
  currencyCode: string;
  minorUnitExponent: number;
  pending?: boolean;
  errorMessage?: string;
  onConfirm: (input: {
    amount: number;
    method: "cash" | "bank_transfer";
    sourceReference?: string;
    paidAt?: string;
    reason: string;
    confirmationToken: string;
  }, intentKey: string) => void;
  onCancel: () => void;
};

const REASON_MIN = 8;
const REASON_MAX = 500;

function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function canonicalPaidAt(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function validateRefundReason(raw: string): string | null {
  const reason = String(raw || "").trim();
  if (reason.length < REASON_MIN) return `Lý do cần ít nhất ${REASON_MIN} ký tự.`;
  if (reason.length > REASON_MAX) return `Lý do không được vượt quá ${REASON_MAX} ký tự.`;
  return null;
}

export function validateRefundConfirmation(raw: string, orderNumber: string): string | null {
  if (String(raw || "").trim() !== String(orderNumber || "").trim()) {
    return `Phải nhập đúng mã đơn ${orderNumber}.`;
  }
  return null;
}

function formatMinorMoney(amountMinor: number, currencyCode: string, exponent: number) {
  return `${(amountMinor / (10 ** exponent)).toLocaleString("vi-VN", {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  })} ${currencyCode}`;
}

/**
 * Records a real customer payout against the remaining server-owned payable.
 * Inventory is deliberately untouched because cancellation/correction already
 * performed its stock mutation exactly once.
 */
export function OrderRefundDialog({
  open,
  orderNumber,
  orderId,
  amountMinor,
  currencyCode,
  minorUnitExponent,
  pending,
  errorMessage,
  onConfirm,
  onCancel,
}: OrderRefundDialogProps) {
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [payoutMethod, setPayoutMethod] = useState<"cash" | "bank_transfer">("cash");
  const [sourceReference, setSourceReference] = useState("");
  const [paidAtLocal, setPaidAtLocal] = useState("");
  const intentKeyRef = useRef<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setReason("");
      setConfirmation("");
      setPayoutMethod("cash");
      setSourceReference("");
      setPaidAtLocal("");
      intentKeyRef.current = null;
      return;
    }
    if (!intentKeyRef.current) {
      intentKeyRef.current = createClientIdempotencyKey("customer-refund-payout");
    }
    setPaidAtLocal((current) => current || localDateTimeValue(new Date()));
    cancelRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel, pending]);

  if (!open) return null;

  const normalizedOrderNumber = String(orderNumber || orderId || "").trim();
  const normalizedReason = reason.trim();
  const reasonValid = validateRefundReason(reason) === null;
  const confirmationValid = validateRefundConfirmation(
    confirmation,
    normalizedOrderNumber,
  ) === null;
  const amountValid = Number.isSafeInteger(amountMinor) && amountMinor > 0;
  const normalizedSourceReference = sourceReference.trim();
  const paidAt = canonicalPaidAt(paidAtLocal);
  const payoutEvidenceValid = payoutMethod === "cash"
    || (normalizedSourceReference.length >= 3
      && normalizedSourceReference.length <= 128
      && paidAt !== null);

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40"
      onClick={() => { if (!pending) onCancel(); }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-refund-title"
        className="w-full max-w-md rounded-xl bg-surface-panel p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start gap-3">
          <HandCoins size={20} className="mt-0.5 shrink-0 text-status-warning" />
          <div className="min-w-0 flex-1">
            <h2 id="order-refund-title" className="text-base font-bold text-text-primary">
              Ghi nhận hoàn tiền {normalizedOrderNumber}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              Chỉ xác nhận sau khi đã thực sự trả tiền cho khách. Hệ thống sẽ ghi một
              payout bất biến, thanh toán khoản phải hoàn và cập nhật doanh thu thuần.
            </p>
            <div className="mt-2">
              <StatusPill tone="warning" label="Không hoàn tồn kho lần nữa" />
            </div>
          </div>
        </div>

        <div className="mb-3 rounded-md border border-border-default bg-surface-subtle p-3 text-xs text-text-secondary">
          <div className="flex justify-between gap-3">
            <span>Số còn phải hoàn</span>
            <strong className="tabular-nums text-text-primary">
              {amountValid
                ? formatMinorMoney(amountMinor, currencyCode, minorUnitExponent)
                : "Không xác định"}
            </strong>
          </div>
          <p className="pt-2 text-text-muted">
            Số tiền này được kiểm tra lại trong transaction. Nếu có thao tác đồng thời,
            yêu cầu sẽ dừng thay vì hoàn dư.
          </p>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="order-refund-method">
            Phương thức thực tế đã hoàn
          </label>
          <select
            id="order-refund-method"
            value={payoutMethod}
            onChange={(event) => setPayoutMethod(event.target.value as "cash" | "bank_transfer")}
            className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
            disabled={Boolean(pending)}
          >
            <option value="cash">Tiền mặt</option>
            <option value="bank_transfer">Chuyển khoản ngân hàng</option>
          </select>
          <p className="mt-1 text-xs text-text-muted">
            COD chỉ là chính sách ghi nhận tiền thu vào; không được dùng làm phương thức hoàn ra.
          </p>
        </div>

        {payoutMethod === "bank_transfer" && (
          <div className="mb-3 grid gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="order-refund-source-reference">
                Mã giao dịch / tham chiếu sao kê
              </label>
              <input
                id="order-refund-source-reference"
                value={sourceReference}
                onChange={(event) => setSourceReference(event.target.value)}
                minLength={3}
                maxLength={128}
                autoComplete="off"
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm font-mono focus:border-action-primary focus:outline-none"
                disabled={Boolean(pending)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="order-refund-paid-at">
                Thời điểm tiền đã chuyển ra
              </label>
              <input
                id="order-refund-paid-at"
                type="datetime-local"
                value={paidAtLocal}
                onChange={(event) => setPaidAtLocal(event.target.value)}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
                disabled={Boolean(pending)}
              />
            </div>
          </div>
        )}

        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="order-refund-reason">
            Lý do / bằng chứng hoàn tiền
          </label>
          <textarea
            id="order-refund-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={REASON_MAX}
            rows={3}
            className="w-full resize-none rounded-md border border-border-default bg-surface-panel px-3 py-2 text-sm focus:border-action-primary focus:outline-none"
            placeholder="Ví dụ: đã trả tiền mặt cho khách tại quầy"
            disabled={Boolean(pending)}
          />
          <p className="mt-1 text-xs text-text-muted">
            {reason.length}/{REASON_MAX}, tối thiểu {REASON_MIN} ký tự.
          </p>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="order-refund-confirm">
            Nhập mã đơn để xác nhận payout
          </label>
          <input
            id="order-refund-confirm"
            type="text"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm font-mono focus:border-action-primary focus:outline-none"
            placeholder={normalizedOrderNumber}
            disabled={Boolean(pending)}
          />
          <p className="mt-1 text-xs text-text-muted">
            Phải khớp chính xác <span className="font-mono">{normalizedOrderNumber}</span>.
          </p>
        </div>

        {errorMessage && (
          <div className="mb-3">
            <InlineError message={errorMessage} />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={pending}>
            Hủy bỏ
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!payoutEvidenceValid) return;
              const intentKey = intentKeyRef.current
                || createClientIdempotencyKey("customer-refund-payout");
              intentKeyRef.current = intentKey;
              onConfirm({
                amount: amountMinor,
                method: payoutMethod,
                ...(payoutMethod === "bank_transfer" && paidAt
                  ? { sourceReference: normalizedSourceReference, paidAt }
                  : {}),
                reason: normalizedReason,
                confirmationToken: confirmation.trim(),
              }, intentKey);
            }}
            disabled={!amountValid || !reasonValid || !confirmationValid || !payoutEvidenceValid || pending}
          >
            {pending ? "Đang ghi nhận..." : "Xác nhận đã hoàn tiền"}
          </Button>
        </div>
      </div>
    </div>
  );
}
