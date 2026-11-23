import { useEffect, useRef, useState } from "react";
import { X, Banknote, Building2, Truck, QrCode, Wallet } from "lucide-react";
import type { PaymentMethod } from "@medusa-snus/contracts";
import { useI18n } from "../i18n";
import { CustomerSearch } from "./CustomerSearch";
import { SALES_CHANNELS, salesChannelLabel, type SalesChannelValue } from "../config/salesChannels";
import { cartTotalsForDisplay, type CartCommercialAdjustment, type CartPaymentFeePreviewState } from "../utils/cartTotals";
import { CartPaymentFeeSummary } from "./CartPaymentFee";

interface PaymentModalProps {
  subtotal: number;
  adjustment: CartCommercialAdjustment;
  paymentFeePreview?: CartPaymentFeePreviewState;
  selectedCustomer?: { id: string; phone: string; name: string } | null;
  enabledPaymentMethods?: Partial<Record<PaymentMethod, boolean>>;
  onCustomerSelect?: (customer: { id: string; phone: string; name: string }) => void;
  onCustomerClear?: () => void;
  onComplete: (paymentMethod: PaymentMethod, amountReceived: number, adjustment: CartCommercialAdjustment, notes: string, salesChannel: SalesChannelValue, customerMode: "linked" | "walk_in", bankTransferSettlementAcknowledgment?: { policyVersion: number; acknowledgmentVersion: number }) => Promise<void> | void;
  onClose: () => void;
  isSubmitting?: boolean;
  completeLabel?: string;
  forcedSalesChannel?: SalesChannelValue;
  salesChannelLocked?: boolean;
  salesChannelLockReason?: string;
  onPolicyRefresh?: () => unknown;
  bankSettlementPolicy?: {
    manualConfirmationEnabled: boolean;
    status: "pending" | "ready" | "unavailable";
    mode: "manual_confirmation" | "confirm_on_booking";
    policyVersion: number;
    acknowledgmentVersion: number;
  };
}

const QUICK_AMOUNTS = [50000, 100000, 200000, 500000];

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function formatMoneyInput(value: number) {
  return value ? value.toLocaleString("vi-VN") : "";
}

export function PaymentModal({
  subtotal,
  adjustment,
  paymentFeePreview,
  selectedCustomer,
  enabledPaymentMethods,
  onCustomerSelect,
  onCustomerClear,
  onComplete,
  onClose,
  isSubmitting = false,
  completeLabel,
  forcedSalesChannel,
  salesChannelLocked,
  salesChannelLockReason,
  bankSettlementPolicy,
  onPolicyRefresh,
}: PaymentModalProps) {
  const { t } = useI18n();
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [amountReceived, setAmountReceived] = useState("");
  const [notes, setNotes] = useState("");
  const [salesChannel, setSalesChannel] = useState<SalesChannelValue>(forcedSalesChannel || "pos_counter");
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [customerMode, setCustomerMode] = useState<"linked" | "walk_in" | null>(
    selectedCustomer?.id ? "linked" : null,
  );
  const [customerResetToken, setCustomerResetToken] = useState(0);
  const submittingRef = useRef(false);
  const preview = cartTotalsForDisplay(subtotal, adjustment, paymentFeePreview);
  const discount = preview.discount;
  const shippingAmount = preview.shippingFee;
  const payable = preview.payable;
  const feePending = paymentFeePreview && paymentFeePreview.status !== "ready";
  const payableLabel = feePending ? "—" : `${payable.toLocaleString("vi-VN")} ₫`;
  const moneyBlocked = preview.discountError !== null;
  const cashIncomplete = method === "cash" && amountReceived !== ""
    && (!Number.isSafeInteger(Number(amountReceived)) || Number(amountReceived) < payable);
  const change = Math.max(0, (Number(amountReceived) || 0) - payable);
  const busy = isSubmitting || localSubmitting;
  const bankBlocked = method === "bank_transfer" && Boolean(bankSettlementPolicy && (
    bankSettlementPolicy.status !== "ready"
    || (bankSettlementPolicy.mode === "manual_confirmation" && !bankSettlementPolicy.manualConfirmationEnabled)
  ));

  useEffect(() => {
    if (forcedSalesChannel) setSalesChannel(forcedSalesChannel);
  }, [forcedSalesChannel]);

  useEffect(() => {
    if (selectedCustomer?.id) setCustomerMode("linked");
  }, [selectedCustomer?.id]);

  async function handleComplete() {
    if (submittingRef.current || busy || !customerMode || bankBlocked || moneyBlocked || cashIncomplete) return;
    submittingRef.current = true;
    setLocalSubmitting(true);
    const received = amountReceived === "" ? payable : Number(amountReceived);
    const bankTransferSettlementAcknowledgment = method === "bank_transfer"
      && bankSettlementPolicy?.status === "ready"
      && bankSettlementPolicy.mode === "confirm_on_booking"
      ? {
          policyVersion: bankSettlementPolicy.policyVersion,
          acknowledgmentVersion: bankSettlementPolicy.acknowledgmentVersion,
        }
      : undefined;
    try {
      if (bankTransferSettlementAcknowledgment) {
        await onComplete(
          method,
          received,
          adjustment,
          notes.trim(),
          forcedSalesChannel || salesChannel,
          customerMode,
          bankTransferSettlementAcknowledgment,
        );
      } else {
        await onComplete(
          method,
          received,
          adjustment,
          notes.trim(),
          forcedSalesChannel || salesChannel,
          customerMode,
        );
      }
    } finally {
      submittingRef.current = false;
      setLocalSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl bg-surface-panel p-6 animate-slide-up shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-text-primary">Thanh toán</h2>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="Đóng thanh toán"
            className="text-text-muted hover:text-text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X size={20} />
          </button>
        </div>

        {/* Payment Method Tabs */}
        <div className="mb-4 grid grid-cols-3 gap-2">
          {([
            { id: "cash" as const, icon: Banknote, label: t("pos.payCash"), core: true },
            { id: "bank_transfer" as const, icon: Building2, label: t("pos.payTransfer"), core: true },
            { id: "cod" as const, icon: Truck, label: t("pos.payCOD"), core: true },
            { id: "sepay_va" as const, icon: QrCode, label: "SePay", core: false },
            { id: "nowpayments" as const, icon: Wallet, label: "Crypto", core: false },
          ]).map((m) => {
            if (!m.core && enabledPaymentMethods && enabledPaymentMethods[m.id] === undefined) return null;
            const enabled = enabledPaymentMethods ? enabledPaymentMethods[m.id] !== false : true;
            return (
            <button
              key={m.id}
              onClick={() => {
                if (!enabled) return;
                setMethod(m.id);
                setAmountReceived("");
              }}
	              disabled={!enabled || busy}
              title={enabled ? m.label : "Feature locked for this package"}
              className={[
                "flex flex-1 flex-col items-center gap-1 rounded-lg border px-3 py-2 text-xs transition-colors",
                method === m.id
                  ? "border-action-primary bg-surface-selected text-action-primary"
                  : "border-border-default text-text-muted hover:bg-surface-hover",
	                !enabled ? "cursor-not-allowed opacity-40 hover:bg-transparent" : "",
              ].join(" ")}
            >
              <m.icon size={18} />
              {m.label}
            </button>
          );})}
        </div>

        <div className="mb-4 rounded-lg border border-border-default bg-surface-subtle p-3">
          <label className="mb-2 block text-xs font-medium text-text-secondary">
            Khách hàng
          </label>
          <CustomerSearch
            onSelect={(customer) => {
              setCustomerMode("linked");
              onCustomerSelect?.(customer);
            }}
            onClear={() => {
              setCustomerMode(null);
              onCustomerClear?.();
            }}
            selectedPhone={selectedCustomer?.phone}
            resetToken={customerResetToken}
            onDraftChange={(draft) => {
              if (
                selectedCustomer?.id
                && draft.trim() === selectedCustomer.phone.trim()
              ) {
                setCustomerMode("linked");
              } else {
                setCustomerMode(null);
              }
            }}
          />
          {selectedCustomer?.name && (
            <p className="mt-2 text-xs text-text-secondary">
              Đang chọn: <span className="font-medium text-text-primary">{selectedCustomer.name}</span>
            </p>
          )}
          <button
            type="button"
            aria-pressed={customerMode === "walk_in"}
            onClick={() => {
              onCustomerClear?.();
              setCustomerMode("walk_in");
              setCustomerResetToken((value) => value + 1);
            }}
            disabled={busy}
            className={[
              "mt-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              customerMode === "walk_in"
                ? "border-action-primary bg-surface-selected text-action-primary"
                : "border-border-default text-text-secondary hover:bg-surface-hover",
            ].join(" ")}
          >
            Khách lẻ — không liên kết hồ sơ
          </button>
          {!customerMode && (
            <p role="alert" className="mt-2 text-xs text-status-warning">
              Chọn/tạo khách hàng hoặc xác nhận “Khách lẻ” trước khi thanh toán.
            </p>
          )}
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              Kênh bán
            </label>
            {salesChannelLocked ? (
              <div className="flex min-h-10 w-full flex-col justify-center rounded-md border border-status-info-border bg-status-info-bg px-3 py-2 text-sm text-status-info">
                <span className="font-semibold">{salesChannelLabel(forcedSalesChannel || salesChannel)}</span>
                {salesChannelLockReason && (
                  <span className="mt-0.5 text-[11px] font-normal leading-4">{salesChannelLockReason}</span>
                )}
              </div>
            ) : (
              <select
                value={salesChannel}
                onChange={(event) => setSalesChannel(event.target.value as SalesChannelValue)}
                disabled={busy}
                className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
              >
                {SALES_CHANNELS.map((channel) => (
                  <option key={channel.value} value={channel.value}>{channel.label}</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              Ghi chú <span className="font-normal text-text-muted">(tùy chọn)</span>
            </label>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              disabled={busy}
              maxLength={1000}
              rows={2}
              className="min-h-10 w-full resize-none rounded-md border border-border-default bg-surface-panel px-3 py-2 text-sm focus:border-action-primary focus:outline-none"
              placeholder="Ghi chú cho đơn hàng"
            />
          </div>
        </div>

        {/* Cash Payment */}
        {method === "cash" && (
          <div className="space-y-3">
            <div className="rounded-lg bg-surface-subtle p-4">
              <div className="flex items-center justify-between text-sm text-text-muted">
                <span>Tạm tính</span>
                <span className="tabular-nums">{feePending ? "—" : `${preview.subtotal.toLocaleString("vi-VN")} ₫`}</span>
              </div>
              {discount > 0 && (
                <div className="flex items-center justify-between text-xs text-status-success mt-1">
                  <span>Giảm giá ({adjustment.discountType === "percent" ? `${adjustment.discountValue}%` : "VND"})</span>
                  <span className="tabular-nums">- {discount.toLocaleString("vi-VN")} ₫</span>
                </div>
              )}
              {shippingAmount > 0 && (
                <div className="flex items-center justify-between text-xs text-text-secondary mt-1">
                  <span>Phí giao hàng</span>
                  <span className="tabular-nums">+ {shippingAmount.toLocaleString("vi-VN")} ₫</span>
                </div>
              )}
              <CartPaymentFeeSummary state={paymentFeePreview} />
              <div className="mt-2 flex items-center justify-between border-t border-border-default pt-2">
                <span className="text-sm font-semibold text-action-primary">Phải thu</span>
                <span className="text-2xl font-bold text-text-primary tabular-nums">
                  {payableLabel}
                </span>
              </div>
            </div>

            {/* Amount Received */}
            <div>
              <label className="mb-1 block text-xs text-text-muted">{t("pos.amountReceived")}</label>
              <input
                type="text"
                inputMode="numeric"
                value={formatMoneyInput(Number(amountReceived) || 0)}
                onChange={(e) => setAmountReceived(digitsOnly(e.target.value))}
                disabled={busy}
                className="h-12 w-full rounded-md border border-border-default bg-surface-panel px-3 text-lg font-medium
                           focus:border-action-primary focus:outline-none focus:ring-2 focus:ring-action-primary/20"
                aria-label="Amount received"
                autoFocus
                placeholder="0"
              />
            </div>

            {/* Quick Cash Amounts */}
            <div className="flex gap-2">
              {QUICK_AMOUNTS.map((a) => (
                <button
                  key={a}
	                  onClick={() => setAmountReceived(String(a))}
	                  disabled={busy}
                  className={[
                    "flex-1 rounded-md border px-2 py-2 text-xs font-medium transition-colors",
                    Number(amountReceived) === a
                      ? "border-action-primary bg-surface-selected text-action-primary"
                      : "border-border-default text-text-secondary hover:bg-surface-hover",
                  ].join(" ")}
                >
                  {a.toLocaleString("vi-VN")}
                </button>
              ))}
            </div>

            {/* Change */}
            {amountReceived && Number(amountReceived) > 0 && (
              <div className="rounded-lg bg-status-success-bg border border-status-success-border p-3">
                <p className="text-xs text-status-success">
                  {t("pos.change")}:{" "}
                  <span className="text-lg font-bold tabular-nums">
                    {change.toLocaleString("vi-VN")} ₫
                  </span>
                </p>
              </div>
            )}
          </div>
        )}

        {/* Non-Cash Payment */}
        {method !== "cash" && (
          <div className="space-y-3">
            <div className="rounded-lg bg-surface-subtle p-4">
              <div className="flex items-center justify-between text-sm text-text-muted">
                <span>Tạm tính</span>
                <span className="tabular-nums">{feePending ? "—" : `${preview.subtotal.toLocaleString("vi-VN")} ₫`}</span>
              </div>
              {discount > 0 && (
                <div className="flex items-center justify-between text-xs text-status-success mt-1">
                  <span>Giảm giá ({adjustment.discountType === "percent" ? `${adjustment.discountValue}%` : "VND"})</span>
                  <span className="tabular-nums">- {discount.toLocaleString("vi-VN")} ₫</span>
                </div>
              )}
              {shippingAmount > 0 && (
                <div className="flex items-center justify-between text-xs text-text-secondary mt-1">
                  <span>Phí giao hàng</span>
                  <span className="tabular-nums">+ {shippingAmount.toLocaleString("vi-VN")} ₫</span>
                </div>
              )}
              <CartPaymentFeeSummary state={paymentFeePreview} />
              <div className="mt-2 flex items-center justify-between border-t border-border-default pt-2">
                <span className="text-sm font-semibold text-action-primary">Phải thu</span>
                <span className="text-2xl font-bold text-text-primary tabular-nums">
                  {payableLabel}
                </span>
              </div>
            </div>
          </div>
        )}

        {method === "bank_transfer" && (
          <div className="mt-3 rounded-lg border border-status-info-border bg-status-info-bg p-3 text-sm text-status-info">
            {bankSettlementPolicy?.status === "ready" && bankSettlementPolicy.mode === "confirm_on_booking"
              ? <>Hoàn tất đơn đồng thời xác nhận đã nhận đủ {payableLabel} chuyển khoản.</>
              : bankBlocked
                ? <><p role="alert">{bankSettlementPolicy?.status === "pending"
                    ? "Đang tải chính sách chuyển khoản."
                    : bankSettlementPolicy?.status === "unavailable"
                      ? "Không tải được chính sách chuyển khoản."
                      : "Xác nhận chuyển khoản thủ công hiện chưa khả dụng. Chọn phương thức khác hoặc tải lại chính sách."}</p>
                    {onPolicyRefresh && <button type="button" disabled={busy} onClick={() => void onPolicyRefresh()} className="mt-2 underline">Tải lại chính sách</button>}</>
                : <>Đơn chuyển khoản sẽ ở trạng thái chờ thanh toán để xác nhận thủ công sau.</>}
          </div>
        )}

        {(moneyBlocked || cashIncomplete) && <p role="status" className="mt-2 text-xs text-status-warning">{preview.discountError || "Tiền khách đưa chưa đủ hoặc không hợp lệ."}</p>}
        {/* Complete Button */}
        <button
          onClick={() => void handleComplete()}
          disabled={busy || !customerMode || bankBlocked || moneyBlocked || cashIncomplete}
          className="mt-4 flex h-12 w-full items-center justify-center rounded-md bg-status-success
	                     font-semibold text-white transition-colors hover:bg-green-700
	                     focus-visible:outline-2 focus-visible:outline-action-primary focus-visible:outline-offset-2
	                     disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-status-success"
        >
          {busy
            ? "Đang xử lý..."
            : completeLabel || (method === "bank_transfer" && bankSettlementPolicy?.status === "ready" && bankSettlementPolicy.mode === "confirm_on_booking"
              ? "Hoàn tất & xác nhận đã nhận tiền"
              : t("pos.completeSale"))}
        </button>
      </div>
    </div>
  );
}
