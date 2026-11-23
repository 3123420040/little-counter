import { useEffect, useMemo, useState } from "react";
import { Button, InlineError } from "@medusa-snus/ui";
import type { OrderShippingPreview } from "../api/endpoints";
import { usePreviewOrderShipping, useUpdateOrderShipping } from "../hooks/useOrders";

function formatMoney(value: number) {
  return `${Number(value || 0).toLocaleString("vi-VN")} ₫`;
}

export function OrderShippingAdjustmentPanel({
  orderId,
  currentShippingFee,
  currentTotal,
  paymentMethod,
  onApplied,
}: {
  orderId: string;
  currentShippingFee: number;
  currentTotal: number;
  paymentMethod: string;
  onApplied?: () => void;
}) {
  const preview = usePreviewOrderShipping();
  const apply = useUpdateOrderShipping();
  const [shippingFee, setShippingFee] = useState(String(currentShippingFee));
  const [reason, setReason] = useState("");
  const [quoted, setQuoted] = useState<OrderShippingPreview["data"] | null>(null);
  const [previewSignature, setPreviewSignature] = useState("");

  useEffect(() => {
    setShippingFee(String(currentShippingFee));
    setReason("");
    setQuoted(null);
    setPreviewSignature("");
    preview.reset();
    apply.reset();
  }, [orderId, currentShippingFee]);

  const input = useMemo(() => ({
    shippingFee: Number(shippingFee || 0),
    reason: reason.trim(),
    paymentMethod: paymentMethod || "cash",
  }), [paymentMethod, reason, shippingFee]);
  const inputSignature = JSON.stringify(input);

  function invalidatePreview() {
    setQuoted(null);
    setPreviewSignature("");
    preview.reset();
    apply.reset();
  }

  function requestPreview() {
    preview.mutate({ orderId, input }, {
      onSuccess: (response) => {
        setQuoted(response.data);
        setPreviewSignature(inputSignature);
      },
    });
  }

  function confirmApply() {
    if (!quoted || previewSignature !== inputSignature) return;
    apply.mutate({
      orderId,
      input: { ...input, confirmationToken: quoted.confirmationToken },
    }, {
      onSuccess: () => {
        setQuoted(null);
        setPreviewSignature("");
        setReason("");
        onApplied?.();
      },
    });
  }

  const canPreview = reason.trim().length >= 10
    && reason.trim().length <= 500
    && Number.isSafeInteger(input.shippingFee)
    && input.shippingFee >= 0
    && !preview.isPending
    && !apply.isPending;
  const canApply = Boolean(
    quoted
    && previewSignature === inputSignature
    && !preview.isPending
    && !apply.isPending,
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 text-xs text-text-secondary sm:grid-cols-2">
        <span>Phí hiện tại: <b className="tabular-nums text-text-primary">{formatMoney(currentShippingFee)}</b></span>
        <span>Tổng hiện tại: <b className="tabular-nums text-text-primary">{formatMoney(currentTotal)}</b></span>
      </div>
      <div>
        <label className="mb-1 block text-xs text-text-muted">Phí vận chuyển sau điều chỉnh</label>
        <input
          aria-label="Phí vận chuyển sau điều chỉnh"
          inputMode="numeric"
          value={shippingFee ? Number(shippingFee).toLocaleString("vi-VN") : ""}
          onChange={(event) => {
            setShippingFee(event.target.value.replace(/\D/g, ""));
            invalidatePreview();
          }}
          className="h-10 w-full rounded-md border border-border-default bg-surface-panel px-3 text-sm focus:border-action-primary focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-text-muted">Lý do điều chỉnh</label>
        <textarea
          aria-label="Lý do điều chỉnh phí vận chuyển"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            invalidatePreview();
          }}
          minLength={10}
          maxLength={500}
          rows={2}
          className="w-full resize-none rounded-md border border-border-default bg-surface-panel px-3 py-2 text-sm focus:border-action-primary focus:outline-none"
          placeholder="Ví dụ: bổ sung phí giao hàng theo xác nhận của khách"
        />
        <p className="mt-1 text-xs text-text-muted">{reason.length}/500, tối thiểu 10 ký tự.</p>
      </div>

      <Button variant="secondary" size="sm" onClick={requestPreview} disabled={!canPreview}>
        {preview.isPending ? "Đang tính..." : "Xem tác động"}
      </Button>

      {quoted && previewSignature === inputSignature && (
        <div className="space-y-2 rounded-md border border-status-info-border bg-status-info-bg p-3 text-xs">
          <div className="flex justify-between gap-3">
            <span>Tổng đơn sau điều chỉnh</span>
            <b className="tabular-nums">{formatMoney(quoted.after.total)}</b>
          </div>
          <div className="flex justify-between gap-3">
            <span>Chênh lệch cần đối soát</span>
            <b className="tabular-nums">{formatMoney(quoted.totalDelta)}</b>
          </div>
          <p>
            {quoted.settlement.direction === "collect"
              ? `Cần thu ${formatMoney(quoted.settlement.amount)} qua ${quoted.settlement.method}.`
              : quoted.settlement.direction === "refund"
                ? `Cần hoàn ${formatMoney(quoted.settlement.amount)} qua ${quoted.settlement.method}.`
                : "Không phát sinh thu hoặc hoàn tiền."}
          </p>
          <p className="text-text-secondary">
            Tác động: tổng đơn {quoted.effects.orderTotals}; payment {quoted.effects.paymentEntry}; audit {quoted.effects.auditEvent}; outbox {quoted.effects.outboxEvent}; tồn kho {quoted.effects.inventory}.
          </p>
        </div>
      )}

      {preview.error && (
        <InlineError message={preview.error instanceof Error ? preview.error.message : "Không tính được tác động"} />
      )}
      {apply.error && (
        <InlineError message={apply.error instanceof Error ? apply.error.message : "Không áp dụng được thay đổi"} />
      )}

      <Button variant="primary" size="sm" onClick={confirmApply} disabled={!canApply}>
        {apply.isPending ? "Đang áp dụng..." : "Xác nhận áp dụng"}
      </Button>
    </div>
  );
}
