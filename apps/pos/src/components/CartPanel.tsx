import { QrCode, Trash2 } from "lucide-react";
import { Tag, Truck } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { CartItemRow } from "./CartItemRow";
import { InlineError, PaginatedListFrame, localListPaginationMeta } from "@medusa-snus/ui";
import type { CartItem } from "../hooks/useCart";
import { useI18n } from "../i18n";
import { cartTotalsForDisplay, type CartCommercialAdjustment, type CartPaymentFeePreviewState } from "../utils/cartTotals";
import { PaymentFeeAdjustmentInput, CartPaymentFeeSummary } from "./CartPaymentFee";

interface CartPanelProps {
  items: CartItem[];
  selectedIndex: number | null;
  subtotal: number;
  itemCount: number;
  adjustment: CartCommercialAdjustment;
  onAdjustmentChange: (adjustment: CartCommercialAdjustment) => void;
  onUpdateQty: (variantId: string, qty: number) => void;
  onRemove: (variantId: string) => void;
  onSelectItem: (index: number | null) => void;
  onClear: () => void;
  onCheckout: () => void;
  onScan?: () => void;
  customerName?: string;
  customerLoyalty?: { tier: string; points: number };
  saleError?: string;
  onDismissError?: () => void;
  beforeFooter?: ReactNode;
  showHeader?: boolean;
  mobileOptimized?: boolean;
  readOnly?: boolean;
  paginateItems?: boolean;
  paymentFeePreview?: CartPaymentFeePreviewState;
}

export function CartPanel({
  items, selectedIndex, subtotal, itemCount, adjustment, onAdjustmentChange,
  onUpdateQty, onRemove, onSelectItem, onClear, onCheckout,
  onScan, customerName, customerLoyalty, saleError, onDismissError, beforeFooter,
  showHeader = true, mobileOptimized = false, readOnly = false, paginateItems = false,
  paymentFeePreview,
}: CartPanelProps) {
  const [itemsPage, setItemsPage] = useState(1);
  const { t } = useI18n();
  const preview = cartTotalsForDisplay(subtotal, adjustment, paymentFeePreview);
  const feePending = paymentFeePreview && paymentFeePreview.status !== "ready";
  const displayedItems = paymentFeePreview?.status === "ready" ? items.map(item => {
    const priced = paymentFeePreview.preview.data.items.find(line => line.variantId === item.variantId);
    return priced ? { ...item, unitPrice: priced.unitPrice, stockLevel: priced.stock } : item;
  }) : items;
  const itemsPageMeta = localListPaginationMeta(items.length, itemsPage, 10);
  const firstVisibleItemIndex = paginateItems ? (itemsPageMeta.page - 1) * 10 : 0;
  const visibleItems = paginateItems ? displayedItems.slice(firstVisibleItemIndex, firstVisibleItemIndex + 10) : displayedItems;
  const discountControlLabel = `${t("pos.discount")} (${adjustment.discountType === "percent" ? "%" : "₫"})`;
  const discountSummaryLabel = adjustment.discountType === "percent"
    ? `${t("pos.discount")} (${adjustment.discountValue || 0}%)`
    : `${t("pos.discount")} (VND)`;

  function digitsOnly(value: string) {
    return value.replace(/\D/g, "");
  }
  function formatMoneyInput(value: number) {
    return value ? value.toLocaleString("vi-VN") : "";
  }

  useEffect(() => {
    if (itemsPage > itemsPageMeta.page) setItemsPage(itemsPageMeta.page);
  }, [itemsPage, itemsPageMeta.page]);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-surface-panel">
      {/* Header */}
      {showHeader && <div className="flex shrink-0 items-center justify-between border-b border-border-default px-4 py-3">
        <h2 className="text-sm font-semibold text-text-primary">
          {t("pos.cart")} ({itemCount})
        </h2>
        <div className="flex items-center gap-2">
          {onScan && (
            <button
              type="button"
              onClick={onScan}
              disabled={readOnly}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border-default text-text-muted transition-colors hover:bg-surface-hover hover:text-action-primary"
              aria-label="Scan QR"
              title="Scan QR"
            >
              <QrCode size={18} />
            </button>
          )}
          {items.length > 0 && (
            <button
              onClick={onClear}
              disabled={readOnly}
              className="text-xs text-text-muted hover:text-status-danger transition-colors"
              aria-label="Xóa giỏ hàng"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>}

      {/* Error */}
      {saleError && (
        <div className="shrink-0 px-4 pt-3">
          <InlineError
            message={saleError}
            onRetry={() => onDismissError?.()}
          />
        </div>
      )}

      {/* Items */}
      <PaginatedListFrame
        label="Phân trang dòng giỏ hàng"
        rowNoun="sản phẩm"
        meta={itemsPageMeta}
        onPageChange={setItemsPage}
        showPagination={paginateItems && items.length > 0}
        className="flex min-h-0 flex-1 flex-col"
        bodyClassName="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {visibleItems.map((item, visibleIndex) => {
          const itemIndex = firstVisibleItemIndex + visibleIndex;
          return (
            <CartItemRow
              key={`${item.variantId}-${itemIndex}`}
              item={item}
              isSelected={selectedIndex === itemIndex}
              onSelect={() => onSelectItem(selectedIndex === itemIndex ? null : itemIndex)}
              onUpdateQty={onUpdateQty}
              onRemove={onRemove}
              disabled={readOnly}
              pricePending={Boolean(feePending)}
            />
          );
        })}
        {items.length === 0 && (
          <div className="py-8 text-center">
            <p className="text-sm text-text-muted">{t("pos.emptyCart")}</p>
            {onScan && (
              <button
                type="button"
                onClick={onScan}
                disabled={readOnly}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border-default px-3 py-2 text-xs font-medium text-action-primary hover:bg-action-primary/10"
              >
                <QrCode size={14} aria-hidden="true" />
                Scan QR
              </button>
            )}
          </div>
        )}
      </PaginatedListFrame>

      {beforeFooter && (
        <div className={[
          "shrink-0 overflow-y-auto overscroll-contain border-t border-border-default bg-surface-panel",
          mobileOptimized ? "max-h-24" : "max-h-44",
        ].join(" ")}>
          {beforeFooter}
        </div>
      )}

      {/* Footer */}
      <div className={[
        "shrink-0 border-t border-border-default bg-surface-panel shadow-[0_-6px_16px_rgba(15,23,42,0.04)]",
        mobileOptimized ? "space-y-2 px-3 py-2" : "space-y-3 px-4 py-3",
      ].join(" ")}>
        {/* Commercial adjustments */}
        {items.length > 0 && (
          mobileOptimized ? (
            <div className="rounded-md border border-border-default bg-surface-subtle px-2.5 py-2">
              <div className="grid grid-cols-[minmax(0,1fr)_4.25rem_5rem] items-center gap-x-1.5 gap-y-1.5">
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-text-secondary">
                  <Tag size={13} className="shrink-0 text-text-muted" />
                  Giảm giá
                </span>
                <div className="flex h-7 w-full overflow-hidden rounded-md border border-border-default bg-surface-panel">
                  {(["percent", "amount"] as const).map((dt) => (
                    <button
                      key={dt}
                      type="button"
                      aria-pressed={adjustment.discountType === dt}
                      aria-label={dt === "percent" ? `${t("pos.discount")} theo phần trăm` : `${t("pos.discount")} theo số tiền`}
                      onClick={() => onAdjustmentChange({ ...adjustment, discountType: dt, discountValue: 0 })}
                      disabled={readOnly}
                      className={[
                        "flex-1 text-[11px] font-semibold transition-colors",
                        adjustment.discountType === dt
                          ? "bg-action-primary text-text-inverse"
                          : "text-text-muted hover:bg-surface-hover",
                        readOnly ? "cursor-not-allowed opacity-50 hover:bg-transparent" : "",
                      ].join(" ")}
                    >
                      {dt === "percent" ? "%" : "₫"}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  value={adjustment.discountType === "percent" ? String(adjustment.discountValue || "") : formatMoneyInput(adjustment.discountValue)}
                  onChange={(e) => {
                    const raw = adjustment.discountType === "percent"
                      ? e.target.value.replace(/[^\d.]/g, "")
                      : digitsOnly(e.target.value);
                    onAdjustmentChange({ ...adjustment, discountValue: raw === "" ? 0 : Number(raw) });
                  }}
                  disabled={readOnly}
                  className="h-7 w-full rounded-md border border-border-default bg-surface-panel px-2 text-right text-xs tabular-nums focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                  aria-label="Discount value"
                  placeholder="0"
                />
                {preview.discountError && (
                  <p className="col-span-3 text-[11px] text-status-danger">{preview.discountError}</p>
                )}
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-text-secondary">
                  <Truck size={13} className="shrink-0 text-text-muted" />
                  Phí giao hàng
                </span>
                <span className="h-7" aria-hidden="true" />
                <input
                  type="text"
                  inputMode="numeric"
                  value={formatMoneyInput(adjustment.shippingFee)}
                  onChange={(e) => onAdjustmentChange({ ...adjustment, shippingFee: Number(digitsOnly(e.target.value)) || 0 })}
                  disabled={readOnly}
                  className="h-7 w-full rounded-md border border-border-default bg-surface-panel px-2 text-right text-xs tabular-nums focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                  aria-label="Shipping fee"
                  placeholder="0"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2 rounded-lg border border-border-default bg-surface-subtle p-3">
              {/* Discount type segmented control */}
              <div className="flex flex-wrap items-center gap-2">
                <Tag size={14} className="text-text-muted" />
                <span className="min-w-0 flex-1 text-xs font-medium text-text-secondary">{discountControlLabel}</span>
                <div className="flex overflow-hidden rounded-md border border-border-default">
                  {(["percent", "amount"] as const).map((dt) => (
                    <button
                      key={dt}
                      type="button"
                      aria-pressed={adjustment.discountType === dt}
                      aria-label={dt === "percent" ? `${t("pos.discount")} theo phần trăm` : `${t("pos.discount")} theo số tiền`}
                      onClick={() => onAdjustmentChange({ ...adjustment, discountType: dt, discountValue: 0 })}
                      disabled={readOnly}
                      className={[
                        "px-3 py-1 text-xs font-medium transition-colors",
                        adjustment.discountType === dt
                          ? "bg-action-primary text-text-inverse"
                          : "text-text-muted hover:bg-surface-hover",
                        readOnly ? "cursor-not-allowed opacity-50 hover:bg-transparent" : "",
                      ].join(" ")}
                    >
                      {dt === "percent" ? "%" : "₫"}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  value={adjustment.discountType === "percent" ? String(adjustment.discountValue || "") : formatMoneyInput(adjustment.discountValue)}
                  onChange={(e) => {
                    const raw = adjustment.discountType === "percent"
                      ? e.target.value.replace(/[^\d.]/g, "")
                      : digitsOnly(e.target.value);
                    onAdjustmentChange({ ...adjustment, discountValue: raw === "" ? 0 : Number(raw) });
                  }}
                  disabled={readOnly}
                  className="h-8 w-24 rounded-md border border-border-default bg-surface-panel px-2 text-right text-sm tabular-nums focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                  aria-label="Discount value"
                  placeholder="0"
                />
              </div>
              {preview.discountError && (
                <p className="text-xs text-status-danger">{preview.discountError}</p>
              )}
              {/* Shipping fee */}
              <div className="flex items-center gap-2">
                <Truck size={14} className="text-text-muted" />
                <span className="text-xs font-medium text-text-secondary">Phí giao hàng</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={formatMoneyInput(adjustment.shippingFee)}
                  onChange={(e) => onAdjustmentChange({ ...adjustment, shippingFee: Number(digitsOnly(e.target.value)) || 0 })}
                  disabled={readOnly}
                  className="ml-auto h-8 w-28 min-w-0 rounded-md border border-border-default bg-surface-panel px-2 text-right text-sm tabular-nums focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                  aria-label="Shipping fee"
                  placeholder="0"
                />
              </div>
            </div>
          )
        )}

        {paymentFeePreview && items.length > 0 && <PaymentFeeAdjustmentInput adjustment={adjustment} onChange={onAdjustmentChange} disabled={readOnly} />}
        {/* Totals summary */}
        {customerName && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-muted">{t("pos.customer")}:</span>
            <span className="font-medium text-text-primary">{customerName}</span>
          </div>
        )}
        {customerLoyalty && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-muted">{t("pos.tier")}:</span>
            <span className="rounded-full bg-status-info-bg border border-status-info-border px-2 py-0.5 text-xs font-medium text-status-info">
              {customerLoyalty.tier} · {customerLoyalty.points}đ
            </span>
          </div>
        )}
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>{t("pos.subtotal") || "Tạm tính"}</span>
          <span className="tabular-nums">{feePending ? "—" : `${preview.subtotal.toLocaleString("vi-VN")} ₫`}</span>
        </div>
        {preview.discount > 0 && (
          <div className="flex items-center justify-between text-xs text-status-success">
            <span>{discountSummaryLabel}</span>
            <span className="tabular-nums">- {preview.discount.toLocaleString("vi-VN")} ₫</span>
          </div>
        )}
        {preview.shippingFee > 0 && (
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>Phí giao hàng</span>
            <span className="tabular-nums">+ {preview.shippingFee.toLocaleString("vi-VN")} ₫</span>
          </div>
        )}
        <CartPaymentFeeSummary state={paymentFeePreview} />
        <div className="flex items-center justify-between gap-3 border-t border-border-default pt-2">
          <span className="text-sm font-semibold text-text-primary">{t("pos.payable") || t("pos.total")}:</span>
          <span className={[
            "font-bold text-action-primary tabular-nums",
            mobileOptimized ? "text-base" : "text-lg",
          ].join(" ")}>
            {feePending ? "—" : `${preview.payable.toLocaleString("vi-VN")} ₫`}
          </span>
        </div>
        <button
          onClick={onCheckout}
          disabled={readOnly || items.length === 0 || preview.discountError !== null}
          className="flex h-12 w-full items-center justify-center rounded-md bg-action-primary
                     text-sm font-medium text-text-inverse transition-colors hover:bg-action-primary-hover
                     disabled:opacity-50 disabled:cursor-not-allowed
                     focus-visible:outline-2 focus-visible:outline-action-primary focus-visible:outline-offset-2"
        >
          {t("pos.checkout")}
        </button>
      </div>
    </div>
  );
}
