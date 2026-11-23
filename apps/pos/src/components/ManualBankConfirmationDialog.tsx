import { useEffect, useRef, useState } from "react";
import { Button, InlineError, StatusPill } from "@medusa-snus/ui";
import { Landmark } from "lucide-react";
import { createClientIdempotencyKey } from "../api/endpoints";

export interface ManualBankConfirmationInputV1 {
  sourceReference: string;
  confirmedAt: string;
}

export type ManualBankConfirmationDialogProps = {
  open: boolean;
  orderNumber: string;
  pending?: boolean;
  errorMessage?: string;
  onConfirm: (input: ManualBankConfirmationInputV1, intentKey: string) => void;
  onCancel: () => void;
};

function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function canonicalManualBankConfirmedAt(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function ManualBankConfirmationDialog({
  open,
  orderNumber,
  pending,
  errorMessage,
  onConfirm,
  onCancel,
}: ManualBankConfirmationDialogProps) {
  const [sourceReference, setSourceReference] = useState("");
  const [confirmedAtLocal, setConfirmedAtLocal] = useState("");
  const intentKeyRef = useRef<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setSourceReference("");
      setConfirmedAtLocal("");
      intentKeyRef.current = null;
      return;
    }
    if (!intentKeyRef.current) {
      intentKeyRef.current = createClientIdempotencyKey("manual-bank-confirmation");
    }
    setConfirmedAtLocal((current) => current || localDateTimeValue(new Date()));
    cancelRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel, pending]);

  if (!open) return null;

  const normalizedReference = sourceReference.trim();
  const confirmedAt = canonicalManualBankConfirmedAt(confirmedAtLocal);
  const valid = normalizedReference.length >= 3
    && normalizedReference.length <= 128
    && confirmedAt !== null;

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40"
      onClick={() => { if (!pending) onCancel(); }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-bank-confirmation-title"
        className="w-full max-w-md rounded-xl bg-surface-panel p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start gap-3">
          <Landmark size={20} className="mt-0.5 shrink-0 text-action-primary" />
          <div className="min-w-0 flex-1">
            <h2 id="manual-bank-confirmation-title" className="text-base font-bold text-text-primary">
              Xác nhận đã nhận chuyển khoản {orderNumber}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              Chỉ thực hiện sau khi bạn đã kiểm tra tiền vào tài khoản ngân hàng. Hệ thống
              ghi nhận xác nhận của operator; hệ thống không tự đối soát ngân hàng ở bước này.
            </p>
            <div className="mt-2">
              <StatusPill tone="warning" label="Bằng chứng thủ công bất biến" />
            </div>
          </div>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="manual-bank-source-reference">
            Mã giao dịch / tham chiếu sao kê
          </label>
          <input
            id="manual-bank-source-reference"
            type="text"
            value={sourceReference}
            onChange={(event) => setSourceReference(event.target.value)}
            minLength={3}
            maxLength={128}
            autoComplete="off"
            className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm font-mono focus:border-action-primary focus:outline-none"
            placeholder="Ví dụ: VCB-20260816-001"
            disabled={Boolean(pending)}
          />
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="manual-bank-confirmed-at">
            Thời điểm xác nhận tiền vào
          </label>
          <input
            id="manual-bank-confirmed-at"
            type="datetime-local"
            value={confirmedAtLocal}
            onChange={(event) => setConfirmedAtLocal(event.target.value)}
            className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
            disabled={Boolean(pending)}
          />
          <p className="mt-1 text-xs text-text-muted">
            Scope cửa hàng, operator, số tiền và cấu phần VAT được máy chủ lấy từ đơn hàng;
            màn hình này không cho phép nhập lại các giá trị đó.
          </p>
        </div>

        {errorMessage && (
          <div className="mb-3" role="alert">
            <InlineError message={errorMessage} />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={pending}>
            Hủy bỏ
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (!confirmedAt || !valid) return;
              const intentKey = intentKeyRef.current
                || createClientIdempotencyKey("manual-bank-confirmation");
              intentKeyRef.current = intentKey;
              onConfirm({ sourceReference: normalizedReference, confirmedAt }, intentKey);
            }}
            disabled={!valid || pending}
          >
            {pending ? "Đang ghi nhận..." : "Xác nhận đã nhận tiền"}
          </Button>
        </div>
      </div>
    </div>
  );
}
