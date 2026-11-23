import { useEffect, useRef, useState } from "react";
import { Button, InlineError, StatusPill } from "@medusa-snus/ui";
import { AlertTriangle } from "lucide-react";
import type { CancellationQuoteV1 } from "@medusa-snus/contracts";

type CancelActor = { role?: string } | null | undefined;

export type OrderCancelDialogProps = {
  open: boolean;
  orderNumber: string;
  orderId: string;
  /** Optional current order status; controls whether dialog is open at all. */
  status?: string;
  /** Optional remaining disable reason: external provider orders cannot be canceled from this dialog. */
  blockedReason?: string;
  actor?: CancelActor;
  pending?: boolean;
  quote?: CancellationQuoteV1;
  quotePending?: boolean;
  errorMessage?: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
};

const REASON_MIN = 8;
const REASON_MAX = 500;

/** Exported for testing. Returns null on valid, error string otherwise. */
export function validateCancelReason(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (trimmed.length < REASON_MIN) return `Lý do cần ít nhất ${REASON_MIN} ký tự.`;
  if (trimmed.length > REASON_MAX) return `Lý do không được vượt quá ${REASON_MAX} ký tự.`;
  return null;
}

/** Exported for testing. Returns null when confirmation matches. */
export function validateCancelConfirmation(
  confirmation: string,
  orderNumber: string,
  orderId: string,
): string | null {
  const trimmed = (confirmation || "").trim();
  const target = (orderNumber || orderId || "").trim();
  if (!trimmed || trimmed !== target) {
    return `Phải nhập đúng mã đơn ${target}.`;
  }
  return null;
}

/** Exported for testing. Returns error string or null. */
export function isCancelBlocked(status: string | undefined, _hasPostedRefund: boolean): string | null {
  if (status === "canceled") return "Đơn này đã được hủy trước đó.";
  return null;
}

/**
 * Safe cancel dialog. The user must:
 *  - Provide a non-trivial reason.
 *  - Type the exact order number/id into the confirmation input.
 *
 * The dialog never claims a payment refund will happen automatically; cancel
 * only restocks inventory and writes audit/outbox evidence.
 */
export function OrderCancelDialog({
  open,
  orderNumber,
  orderId,
  status,
  blockedReason,
  pending,
  quote,
  quotePending,
  errorMessage,
  onConfirm,
  onCancel,
}: OrderCancelDialogProps) {
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setReason("");
      setConfirmation("");
      return;
    }
    cancelRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const trimmedReason = reason.trim();
  const reasonOk = trimmedReason.length >= REASON_MIN && trimmedReason.length <= REASON_MAX;
  const confirmationOk = confirmation.trim() === String(orderNumber || orderId || "").trim()
    && confirmation.trim().length > 0;
  const alreadyCanceled = status === "canceled";
  const canSubmit = !alreadyCanceled && !blockedReason && reasonOk && confirmationOk
    && !pending && !quotePending && Boolean(quote);

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-cancel-title"
        className="w-full max-w-md rounded-xl bg-surface-panel p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start gap-3">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-status-danger" />
          <div className="min-w-0 flex-1">
            <h2 id="order-cancel-title" className="text-base font-bold text-text-primary">
              Hủy đơn {orderNumber || orderId}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              Hành động này sẽ chuyển đơn sang trạng thái đã hủy, hoàn lại tồn kho theo
              phiên bản đơn hiệu lực và ghi nhận chính xác số tiền còn phải hoàn khách.
              Tiền chỉ được đánh dấu đã hoàn khi có thao tác hoàn tiền riêng với bằng chứng.
            </p>
            {status && (
              <div className="mt-2">
                <StatusPill
                  tone={status === "canceled" ? "danger" : "warning"}
                  label={status}
                />
              </div>
            )}
          </div>
        </div>

        {blockedReason && (
          <div className="mb-3 rounded-md border border-status-warning-border bg-status-warning-bg p-3 text-xs text-status-warning">
            {blockedReason}
          </div>
        )}
        {alreadyCanceled && (
          <div className="mb-3 rounded-md border border-status-danger-border bg-status-danger-bg p-3 text-xs text-status-danger">
            Đơn này đã được hủy trước đó.
          </div>
        )}

        <div className="mb-3 rounded-md border border-border-default bg-surface-subtle p-3 text-xs text-text-secondary">
          {quotePending ? (
            <span>Đang kiểm tra tồn kho và số tiền phải hoàn…</span>
          ) : quote ? (
            <div className="space-y-1">
              <div className="flex justify-between gap-3">
                <span>Phiên bản đơn sẽ hủy</span>
                <strong>#{quote.effectiveRevision}</strong>
              </div>
              <div className="flex justify-between gap-3">
                <span>Tiền còn phải hoàn khách</span>
                <strong className="tabular-nums">
                  {(quote.payablePreview[0]?.balanceMinor || 0).toLocaleString("vi-VN")} VND
                </strong>
              </div>
              <div className="flex justify-between gap-3">
                <span>Dòng tồn kho sẽ hoàn</span>
                <strong>{quote.stockPreview.filter((line) => line.action === "restock").length}</strong>
              </div>
              <p className="pt-1 text-text-muted">Báo giá có hiệu lực 5 phút và được kiểm tra lại trong transaction.</p>
            </div>
          ) : (
            <span>Không thể lấy báo giá hủy đơn.</span>
          )}
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="order-cancel-reason">
            Lý do hủy
          </label>
          <textarea
            id="order-cancel-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={REASON_MAX}
            rows={3}
            className="w-full resize-none rounded-md border border-border-default bg-surface-panel px-3 py-2 text-sm focus:border-action-primary focus:outline-none"
            placeholder="Ví dụ: khách đổi ý, nhập nhầm số lượng..."
            disabled={Boolean(pending) || alreadyCanceled || Boolean(blockedReason)}
            aria-describedby="order-cancel-reason-help"
          />
          <p id="order-cancel-reason-help" className="mt-1 text-xs text-text-muted">
            {reason.length}/{REASON_MAX}, tối thiểu {REASON_MIN} ký tự.
            {reason.length > 0 && !reasonOk && (
              <span className="ml-2 text-status-warning">
                Cần thêm lý do rõ ràng để lưu lại audit.
              </span>
            )}
          </p>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="order-cancel-confirm">
            Nhập mã đơn để xác nhận
          </label>
          <input
            id="order-cancel-confirm"
            type="text"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm font-mono focus:border-action-primary focus:outline-none"
            placeholder={orderNumber || orderId}
            disabled={Boolean(pending) || alreadyCanceled || Boolean(blockedReason)}
            aria-describedby="order-cancel-confirm-help"
          />
          <p id="order-cancel-confirm-help" className="mt-1 text-xs text-text-muted">
            Phải khớp chính xác mã đơn <span className="font-mono">{orderNumber || orderId}</span>.
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
            onClick={() => onConfirm(trimmedReason)}
            disabled={!canSubmit}
          >
            {pending ? "Đang hủy..." : "Xác nhận hủy đơn"}
          </Button>
        </div>
      </div>
    </div>
  );
}
