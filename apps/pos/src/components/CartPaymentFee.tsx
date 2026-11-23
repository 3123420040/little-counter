import type { CartCommercialAdjustment, CartPaymentFeePreviewState } from "../utils/cartTotals";

export function PaymentFeeAdjustmentInput({ adjustment, onChange, disabled }: {
  adjustment: CartCommercialAdjustment; onChange: (value: CartCommercialAdjustment) => void; disabled: boolean;
}) {
  const type = adjustment.paymentFeeType ?? "percent";
  return <div className="space-y-1 rounded-md border border-border-default bg-surface-subtle p-2">
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 text-xs font-medium text-text-secondary">Phí thanh toán</span>
      <div className="flex overflow-hidden rounded-md border border-border-default">
        {(["percent", "amount"] as const).map(mode => <button key={mode} type="button" disabled={disabled}
          aria-label={`Phí thanh toán theo ${mode === "percent" ? "phần trăm" : "số tiền"}`} aria-pressed={type === mode}
          onClick={() => onChange({ ...adjustment, paymentFeeType: mode, paymentFeeValue: 0 })}
          className={`px-3 py-1 text-xs font-medium disabled:opacity-50 ${type === mode ? "bg-action-primary text-text-inverse" : "text-text-muted"}`}>
          {mode === "percent" ? "%" : "₫"}
        </button>)}
      </div>
      <input type="number" min="0" step={type === "percent" ? "0.01" : "1"} inputMode={type === "percent" ? "decimal" : "numeric"}
        disabled={disabled} aria-label={`Phí thanh toán (${type === "percent" ? "%" : "VND"})`} placeholder="0"
        value={Number.isFinite(adjustment.paymentFeeValue) ? adjustment.paymentFeeValue : ""}
        onChange={event => onChange({ ...adjustment, paymentFeeType: type, paymentFeeValue: event.target.value === "" ? 0 : Number(event.target.value) })}
        className="h-8 w-24 rounded-md border border-border-default bg-surface-panel px-2 text-right text-xs tabular-nums focus:border-action-primary focus:outline-none disabled:opacity-50" />
    </div>
    <p className="text-[11px] text-text-muted">Tính trên tiền hàng sau giảm giá, không gồm giao hàng.</p>
  </div>;
}

export function CartPaymentFeeSummary({ state }: { state?: CartPaymentFeePreviewState }) {
  if (!state) return null;
  if (state.status !== "ready") return <p role="status" className="text-xs text-status-warning">{state.status === "pending" ? "Đang cập nhật giá và phụ phí…" : state.message}</p>;
  const c = state.preview.data.financial.components;
  return <div className="space-y-1 text-xs text-text-muted">
    <div className="flex justify-between"><span>Phí thanh toán</span><span className="tabular-nums">+ {c.paymentFeeMinor.toLocaleString("vi-VN")} ₫</span></div>
    <div className="flex justify-between"><span>{c.taxMode === "inclusive" ? "VAT đã gồm" : "VAT cộng thêm"}</span><span className="tabular-nums">{c.vatMinor.toLocaleString("vi-VN")} ₫</span></div>
  </div>;
}
