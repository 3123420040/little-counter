import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./Button";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** If true, uses danger variant for confirm button */
  danger?: boolean;
  pending?: boolean;
  confirmDisabled?: boolean;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Confirmation dialog for destructive or high-risk actions.
 * Used for: stock adjustment, journal posting, customer merge, PO receiving, AI approve/reject.
 *
 * @example
 * <ConfirmDialog
 *   open={showConfirm}
 *   title="Ghi sổ bút toán?"
 *   message="Sau khi ghi sổ, không thể sửa bút toán này."
 *   confirmLabel="Ghi sổ"
 *   danger
 *   onConfirm={handlePost}
 *   onCancel={() => setShowConfirm(false)}
 * />
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "Hủy",
  danger,
  pending,
  confirmDisabled,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-sm rounded-xl bg-surface-panel p-6 animate-scale-in shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle
            size={20}
            className={danger ? "text-status-danger" : "text-status-warning"}
          />
          <div>
            <h2 id="confirm-dialog-title" className="text-base font-bold text-text-primary">{title}</h2>
            {message && <p className="text-sm text-text-secondary mt-1">{message}</p>}
          </div>
        </div>
        {children && <div className="mb-4">{children}</div>}
        <div className="flex gap-2 justify-end">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={pending || confirmDisabled}
          >
            {pending ? "Đang xử lý..." : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
