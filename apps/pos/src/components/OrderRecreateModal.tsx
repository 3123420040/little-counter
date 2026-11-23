import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, InlineError, PaginatedListFrame, localListPaginationMeta, StatusPill } from "@medusa-snus/ui";
import { RefreshCw, AlertTriangle, ShoppingCart, XCircle } from "lucide-react";
import { useOrderRecreatePrefill } from "../hooks/useOrders";
import type { OrderRecreatePrefill, OrderRecreatePrefillItem } from "../api/endpoints";

function formatMoney(value: number | string | null | undefined) {
  return `${Number(value || 0).toLocaleString("vi-VN")} ₫`;
}

function recreateErrorMessage(error: unknown) {
  if (typeof error === "object" && error !== null
    && "code" in error && error.code === "store_timezone_invalid") {
    return "Cấu hình múi giờ của cửa hàng không hợp lệ. Hãy nhờ quản trị viên cập nhật múi giờ rồi thử lại.";
  }
  return error instanceof Error ? error.message : "Không thể tải dữ liệu tạo lại đơn.";
}

export type OrderRecreateModalProps = {
  open: boolean;
  orderId: string | null;
  orderNumber: string;
  onClose: () => void;
};

/**
 * Recreate-from-order modal. Loads the authoritative prefill from the backend,
 * shows availability/price warnings, and on confirm navigates to /pos with the
 * prefill payload so the cashier can start a completely new sale.
 */
export function OrderRecreateModal({
  open,
  orderId,
  orderNumber,
  onClose,
}: OrderRecreateModalProps) {
  const navigate = useNavigate();
  const { data: prefill, isLoading, error, refetch } = useOrderRecreatePrefill(
    open ? orderId : null,
  );
  const [confirmed, setConfirmed] = useState(false);
  const [availablePage, setAvailablePage] = useState(1);
  const [unavailablePage, setUnavailablePage] = useState(1);

  useEffect(() => {
    setConfirmed(false);
    setAvailablePage(1);
    setUnavailablePage(1);
  }, [open, orderId, prefill]);

  if (!open) return null;

  const availableItems = (prefill?.items || []).filter(
    (item) => !item.unavailable,
  );
  const unavailableItems = (prefill?.items || []).filter(
    (item) => item.unavailable,
  );
  const warningItems = (prefill?.items || []).filter(
    (item) => item.warning && !item.unavailable,
  );
  const availablePageMeta = localListPaginationMeta(availableItems.length, availablePage, 10);
  const visibleAvailableItems = availableItems.slice((availablePageMeta.page - 1) * 10, availablePageMeta.page * 10);
  const unavailablePageMeta = localListPaginationMeta(unavailableItems.length, unavailablePage, 10);
  const visibleUnavailableItems = unavailableItems.slice((unavailablePageMeta.page - 1) * 10, unavailablePageMeta.page * 10);

  function handlePreload() {
    if (!prefill) return;
    navigate("/pos", {
      state: {
        prefillCart: {
          sourceOrderId: prefill.sourceOrderId,
          sourceOrderNumber: prefill.sourceOrderNumber,
          ...(prefill.sourceScope ? { sourceScope: prefill.sourceScope } : {}),
          customer: prefill.customer,
          items: availableItems.map((item) => ({
            variantId: item.variantId,
            productId: item.productId || "",
            productName: item.productName,
            sku: item.sku,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            stockLevel: item.stockLevel,
          })),
        },
      },
    });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-recreate-title"
        className="w-full max-w-lg rounded-xl bg-surface-panel p-6 shadow-lg max-h-[85vh] flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="order-recreate-title" className="text-base font-bold text-text-primary mb-3">
          Tạo lại đơn từ {orderNumber}
        </h2>

        <p className="text-sm text-text-secondary mb-4">
          Hệ thống sẽ tạo giỏ hàng mới từ các dòng sản phẩm cũ. Giá và tồn kho
          sẽ được kiểm tra lại theo hiện tại. Đơn cũ vẫn giữ nguyên, không bị
          thay đổi hay huỷ.
        </p>

        {isLoading && (
          <div className="flex items-center justify-center py-6">
            <RefreshCw size={20} className="animate-spin text-text-muted" />
            <span className="ml-2 text-sm text-text-muted">Đang kiểm tra sản phẩm...</span>
          </div>
        )}

        {error && (
          <InlineError
            message={recreateErrorMessage(error)}
            onRetry={() => refetch()}
          />
        )}

        {prefill && (
          <>
            <div className="space-y-3 mb-4 min-h-0 overflow-y-auto flex-1">
              {/* Summary bar */}
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <StatusPill tone="success" label={`${availableItems.length} hợp lệ`} />
                {unavailableItems.length > 0 && (
                  <StatusPill tone="danger" label={`${unavailableItems.length} không khả dụng`} />
                )}
                {warningItems.length > 0 && (
                  <StatusPill tone="warning" label={`${warningItems.length} cảnh báo`} />
                )}
              </div>

              {/* Available items (will be loaded) */}
              {availableItems.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-text-secondary">
                    Sẽ đưa vào giỏ hàng
                  </div>
                  <PaginatedListFrame
                    label="Phân trang sản phẩm hợp lệ"
                    rowNoun="sản phẩm"
                    meta={availablePageMeta}
                    onPageChange={setAvailablePage}
                  >
                    <div className="space-y-1">
                      {visibleAvailableItems.map((item) => (
                        <RecreateItemRow key={item.variantId} item={item} />
                      ))}
                    </div>
                  </PaginatedListFrame>
                </div>
              )}

              {/* Unavailable items (skipped) */}
              {unavailableItems.length > 0 && (
                <div>
                  <div className="mb-1 flex items-center gap-1 text-xs font-medium text-status-danger">
                    <XCircle size={12} />
                    Không khả dụng — sẽ bị bỏ qua
                  </div>
                  <PaginatedListFrame
                    label="Phân trang sản phẩm không khả dụng"
                    rowNoun="sản phẩm"
                    meta={unavailablePageMeta}
                    onPageChange={setUnavailablePage}
                  >
                    <div className="space-y-1">
                      {visibleUnavailableItems.map((item) => (
                        <RecreateItemRow key={item.variantId} item={item} />
                      ))}
                    </div>
                  </PaginatedListFrame>
                </div>
              )}
            </div>

            {/* Confirm section */}
            <label className="flex items-start gap-2 text-xs text-text-secondary cursor-pointer mb-3">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Tôi hiểu rằng đơn cũ sẽ không bị thay đổi. Giỏ hàng sẽ được tạo
                thành một đơn bán mới. Các sản phẩm không khả dụng sẽ bị bỏ qua
                và tôi cần kiểm tra lại trước khi hoàn tất đơn.
              </span>
            </label>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Hủy bỏ
              </Button>
              <Button
                variant="primary"
                onClick={handlePreload}
                disabled={
                  !confirmed
                  || availableItems.length === 0
                }
              >
                <ShoppingCart size={16} className="mr-1 inline" />
                Đưa vào giỏ hàng
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RecreateItemRow({ item }: { item: OrderRecreatePrefillItem }) {
  return (
    <div
      className={[
        "rounded-md border px-3 py-2 text-xs",
        item.unavailable
          ? "border-status-danger-border bg-status-danger-bg"
          : item.warning
            ? "border-status-warning-border bg-status-warning-bg"
            : "border-border-subtle bg-surface-subtle",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 whitespace-normal break-words font-medium leading-5 text-text-primary">
          {item.productName}
        </span>
        <span className="tabular-nums text-text-primary shrink-0">
          x{item.quantity}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-3 text-text-muted">
        {item.sku && <span className="font-mono">{item.sku}</span>}
        <span className="tabular-nums">{formatMoney(item.unitPrice)}</span>
        {item.unavailable && (
          <span className="text-status-danger font-medium">Không khả dụng</span>
        )}
        {item.priceChanged && !item.unavailable && (
          <span className="text-status-warning font-medium">
            Giá cũ: {formatMoney(item.originalPrice)}
          </span>
        )}
      </div>
      {item.warning && (
        <p className="mt-1 text-status-warning leading-snug">{item.warning}</p>
      )}
    </div>
  );
}
