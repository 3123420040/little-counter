import { useEffect, useMemo, useState } from "react";
import { Button } from "@medusa-snus/ui";
import { Clock3, Copy, ExternalLink } from "lucide-react";
import type { PaymentIntentResponse } from "../api/endpoints";
import { isPaymentIntentCartLocked } from "../utils/paymentIntentState";
import { PaymentIntentFinancialSummary } from "./PaymentIntentFinancialSummary";

type PaymentIntent = PaymentIntentResponse["data"];

interface PaymentIntentDialogProps {
  intent: PaymentIntent;
  busy?: boolean;
  canRenew: boolean;
  onClose: () => void;
  onChangePaymentMethod: () => void;
  onRenew: () => void;
  onCancel: () => void;
  onMockSettle: () => void;
}

function paymentIntentStatusMessage(intent: PaymentIntent): { tone: "muted" | "warning" | "danger" | "success"; text: string } {
  if (intent.status === "completed") return { tone: "success", text: "Thanh toán đã hoàn tất và đơn đã được tạo." };
  if (intent.status === "paid") return { tone: "success", text: "Provider đã báo thanh toán, hệ thống đang hoàn tất đơn." };
  if (intent.status === "expired") return { tone: "warning", text: "QR/payment intent đã hết hạn. Tạo QR mới hoặc đổi phương thức thanh toán." };
  if (intent.status === "cancelled") return { tone: "muted", text: "Payment intent đã bị hủy. Có thể tạo QR mới hoặc đổi phương thức." };
  if (intent.status === "manual_review") {
    return { tone: "danger", text: `Cần đối soát thủ công${intent.manualReviewReason ? `: ${intent.manualReviewReason}` : "."}` };
  }
  if (intent.status === "failed") return { tone: "danger", text: "Provider báo lỗi thanh toán. Tạo intent mới hoặc đổi phương thức." };
  return { tone: "muted", text: "Đang tự kiểm tra trạng thái thanh toán..." };
}

function paymentIntentMessageClass(tone: "muted" | "warning" | "danger" | "success") {
  if (tone === "success") return "border-status-success-border bg-status-success-bg text-status-success";
  if (tone === "warning") return "border-status-warning-border bg-status-warning-bg text-status-warning";
  if (tone === "danger") return "border-status-danger-border bg-status-danger-bg text-status-danger";
  return "border-border-default bg-surface-panel text-text-muted";
}

function secondsUntil(value: string, now: number) {
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, Math.floor((target - now) / 1000));
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function providerLabel(provider: PaymentIntent["provider"]) {
  if (provider === "sepay_va") return "QR tự đối soát";
  if (provider === "nowpayments") return "USDC/USDT";
  return "Local mock";
}

function qrImageUrl(intent: PaymentIntent) {
  const candidates = [intent.qrPayload, intent.paymentUrl].filter((value): value is string => Boolean(value));
  return candidates.find((value) => /^https?:\/\//i.test(value) && /qr|vietqr|qrcode|image/i.test(value)) || null;
}

function qrPreviewCells(value: string) {
  let seed = 0;
  for (let index = 0; index < value.length; index += 1) {
    seed = (seed * 31 + value.charCodeAt(index)) >>> 0;
  }
  return Array.from({ length: 21 * 21 }, (_, index) => {
    const row = Math.floor(index / 21);
    const col = index % 21;
    const finder =
      (row < 7 && col < 7)
      || (row < 7 && col > 13)
      || (row > 13 && col < 7);
    const finderInner =
      ((row === 0 || row === 6 || col === 0 || col === 6) && finder)
      || ((row >= 2 && row <= 4 && col >= 2 && col <= 4)
      || (row >= 2 && row <= 4 && col >= 16 && col <= 18)
      || (row >= 16 && row <= 18 && col >= 2 && col <= 4));
    if (finder) return finderInner;
    const bit = ((seed >>> (index % 24)) ^ (row * 17) ^ (col * 29) ^ index) & 1;
    return bit === 1;
  });
}

function LocalQrPreview({ value }: { value: string }) {
  const cells = qrPreviewCells(value);
  return (
    <div className="grid size-44 grid-cols-[repeat(21,minmax(0,1fr))] rounded-md border border-border-default bg-white p-2 shadow-sm" aria-label="QR local preview">
      {cells.map((active, index) => (
        <span key={index} className={active ? "bg-black" : "bg-white"} />
      ))}
    </div>
  );
}

function PaymentTimeline({ status }: { status: string }) {
  const paid = ["paid", "completed"].includes(status);
  const completed = status === "completed";
  const failed = ["expired", "cancelled", "manual_review", "failed"].includes(status);
  const steps = [
    { label: "Đang chờ", active: status === "pending", done: paid || completed, danger: failed },
    { label: "Đã nhận tiền", active: status === "paid", done: completed },
    { label: "Tạo đơn", active: completed, done: completed },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {steps.map((step) => (
        <div
          key={step.label}
          className={[
            "rounded-md border px-2 py-2 text-center text-[11px] font-medium",
            step.danger ? "border-status-danger-border bg-status-danger-bg text-status-danger" : "",
            step.done ? "border-status-success-border bg-status-success-bg text-status-success" : "",
            step.active && !step.done && !step.danger ? "border-status-warning-border bg-status-warning-bg text-status-warning" : "",
            !step.active && !step.done && !step.danger ? "border-border-default bg-surface-subtle text-text-muted" : "",
          ].join(" ")}
        >
          {step.label}
        </div>
      ))}
    </div>
  );
}

export function PaymentIntentDialog({
  intent,
  busy = false,
  canRenew,
  onClose,
  onChangePaymentMethod,
  onRenew,
  onCancel,
  onMockSettle,
}: PaymentIntentDialogProps) {
  const [now, setNow] = useState(() => Date.now());
  const locksCart = isPaymentIntentCartLocked(intent.status);
  const notice = paymentIntentStatusMessage(intent);
  const qrImage = qrImageUrl(intent);
  const qrValue = intent.qrPayload || intent.paymentUrl || intent.referenceCode || "";
  const remainingSeconds = secondsUntil(intent.expiresAt, now);

  useEffect(() => {
    if (!locksCart) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [intent.id, intent.status, locksCart]);

  const expiresAtLabel = useMemo(() => new Date(intent.expiresAt).toLocaleString("vi-VN"), [intent.expiresAt]);

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-lg bg-surface-panel p-5 shadow-lg">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-text-primary">{providerLabel(intent.provider)}</p>
            <p className="text-xs text-text-muted">{intent.provider} · {intent.status}</p>
          </div>
          <button
            className="text-text-muted disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onClose}
            disabled={busy || locksCart}
            aria-label="Đóng payment intent"
          >
            ×
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <div className="flex flex-col items-center justify-center rounded-md border border-border-default bg-surface-subtle p-4">
            {qrImage ? (
              <img
                src={qrImage}
                alt="Payment QR"
                className="size-44 rounded-md border border-border-default bg-white object-contain p-2"
              />
            ) : (
              <LocalQrPreview value={qrValue} />
            )}
            <div className="mt-3 flex items-center gap-1 rounded-full border border-status-warning-border bg-status-warning-bg px-2 py-1 text-xs font-semibold text-status-warning">
              <Clock3 size={13} />
              {intent.status === "pending" ? formatCountdown(remainingSeconds) : new Date(intent.expiresAt).toLocaleTimeString("vi-VN")}
            </div>
          </div>

          <div className="space-y-3">
            <PaymentTimeline status={intent.status} />
            <div className="rounded-md border border-border-default bg-surface-subtle p-3 text-sm">
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-text-muted">Số tiền</p>
                  <p className="text-lg font-bold tabular-nums text-text-primary">{intent.amount.toLocaleString("vi-VN")} ₫</p>
                  <PaymentIntentFinancialSummary financial={intent.financial} />
                </div>
                <div>
                  <p className="text-xs text-text-muted">Mã đối soát</p>
                  <div className="flex items-center gap-1">
                    <p className="font-mono text-sm font-semibold text-text-primary">{intent.referenceCode}</p>
                    <button
                      type="button"
                      className="text-text-muted hover:text-action-primary"
                      aria-label="Copy reference"
                      onClick={() => navigator.clipboard?.writeText(intent.referenceCode).catch(() => undefined)}
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-text-muted">Hết hạn</p>
                  <p className="font-semibold text-text-primary">{expiresAtLabel}</p>
                </div>
                {intent.completedOrderId && (
                  <div>
                    <p className="text-xs text-text-muted">Đơn đã tạo</p>
                    <p className="font-semibold text-text-primary">{intent.completedOrderId}</p>
                  </div>
                )}
              </div>
            </div>
            <div className="rounded-md border border-status-warning-border bg-status-warning-bg p-3 text-xs leading-5 text-status-warning">
              Quét QR để thanh toán đúng số tiền và đúng mã đối soát. Không hoàn tất đơn thủ công khi chưa thấy trạng thái đã nhận tiền.
            </div>
            {locksCart && (
              <div className="rounded-md border border-status-info-border bg-status-info-bg p-3 text-xs leading-5 text-status-info">
                Đã tạo mã thanh toán. Muốn đổi giảm giá/phí hoặc phương thức thanh toán, hãy hủy mã này trước.
              </div>
            )}
            {intent.paymentUrl && (
              <a className="inline-flex items-center gap-1 text-sm font-semibold text-action-primary underline" href={intent.paymentUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                Mở trang thanh toán provider
              </a>
            )}
          </div>
        </div>

        <div className="mt-3 space-y-2 rounded-md border border-border-default bg-surface-subtle p-3 text-sm">
          {intent.qrPayload && (
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-text-muted">Payload / payment target</p>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-action-primary"
                  onClick={() => navigator.clipboard?.writeText(intent.qrPayload || "").catch(() => undefined)}
                >
                  <Copy size={13} />
                  Copy
                </button>
              </div>
              <pre className="max-h-24 overflow-auto rounded bg-surface-panel p-2 text-xs">{intent.qrPayload}</pre>
            </div>
          )}
          <div className={[
            "rounded-md border px-2 py-2 text-xs",
            paymentIntentMessageClass(notice.tone),
          ].join(" ")}
          >
            {notice.text}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Button variant="secondary" onClick={onClose} disabled={busy || locksCart}>
            Đóng
          </Button>
          <Button variant="secondary" onClick={onChangePaymentMethod} disabled={busy || locksCart}>
            Đổi PT
          </Button>
          <Button variant="secondary" onClick={onRenew} disabled={busy || !canRenew}>
            Tạo QR mới
          </Button>
          <Button variant="danger" onClick={onCancel} disabled={busy || intent.status !== "pending"}>
            Hủy
          </Button>
        </div>
        <div className="mt-2">
          <Button
            variant="primary"
            className="w-full"
            onClick={onMockSettle}
            disabled={busy || !locksCart}
          >
            Settle local test
          </Button>
        </div>
      </div>
    </div>
  );
}
