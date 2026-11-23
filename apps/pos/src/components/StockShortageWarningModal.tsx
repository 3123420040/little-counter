import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button, InlineError } from "@medusa-snus/ui";

export interface StockShortageItem {
  variantId: string;
  productId?: string;
  productName: string;
  sku?: string;
  systemStock: number;
  requestedQuantity: number;
  shortageQuantity: number;
  unitCost?: number;
}

interface StockShortageWarningModalProps {
  shortages: StockShortageItem[];
  isSubmitting?: boolean;
  errorMessage?: string;
  onConfirm: () => void;
  onBack: () => void;
}

export function StockShortageWarningModal({
  shortages,
  isSubmitting,
  errorMessage,
  onConfirm,
  onBack,
}: StockShortageWarningModalProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onBack();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50 p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stock-shortage-title"
      onClick={onBack}
    >
      <div
        className="max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto rounded-lg bg-surface-panel shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border-default px-4 py-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 rounded-md bg-status-warning-bg p-2 text-status-warning">
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0">
              <h2
                id="stock-shortage-title"
                ref={titleRef}
                tabIndex={-1}
                className="text-base font-semibold text-text-primary outline-none"
              >
                Tồn kho hệ thống không đủ
              </h2>
              <p className="mt-1 text-sm leading-5 text-text-secondary">
                Một số sản phẩm trong giỏ đang vượt quá tồn kho hệ thống. Nếu thực tế đã tìm thấy hàng, hệ thống sẽ ghi nhận phần chênh lệch là điều chỉnh tồn kho với lý do "Tìm thấy" trước khi hoàn tất đơn.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Quay lại chỉnh giỏ"
            className="shrink-0 rounded-md p-1 text-text-muted hover:bg-surface-hover hover:text-text-primary"
            onClick={onBack}
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-2 px-4 py-3">
          {errorMessage && <InlineError message={errorMessage} />}
          {shortages.map((item) => (
            <div
              key={item.variantId}
              className="rounded-md border border-border-default bg-surface-subtle p-3"
            >
              <div className="min-w-0">
                <p className="whitespace-normal break-words text-sm font-medium leading-5 text-text-primary">{item.productName}</p>
                {item.sku && <p className="mt-0.5 text-xs text-text-muted">{item.sku}</p>}
              </div>
              <div className="mt-2 grid grid-cols-1 gap-1 text-xs text-text-secondary min-[360px]:grid-cols-3">
                <span>Tồn hệ thống: <b className="text-text-primary">{item.systemStock}</b></span>
                <span>Đang bán: <b className="text-text-primary">{item.requestedQuantity}</b></span>
                <span className="text-status-warning">Tìm thấy thêm: <b>{item.shortageQuantity}</b></span>
              </div>
            </div>
          ))}
        </div>

        <div className="grid gap-2 border-t border-border-default px-4 py-3 sm:grid-cols-2">
          <Button variant="secondary" onClick={onBack} disabled={isSubmitting}>
            Quay lại chỉnh giỏ
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={isSubmitting}>
            Xác nhận đã tìm thấy hàng
          </Button>
        </div>
      </div>
    </div>
  );
}
