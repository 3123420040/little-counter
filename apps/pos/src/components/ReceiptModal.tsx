import { useState } from "react";
import { X, Printer, Mail } from "lucide-react";
import { emailReceipt } from "../api/endpoints";
import { RECEIPT_STORE } from "../config/receipt";
import type { OrderPaymentFeeFinancialSnapshotV1 } from "@medusa-snus/contracts";

interface ReceiptModalProps {
  order: {
    orderId?: string;
    orderNumber: string;
    total: number;
    subtotal: number;
    tax: number;
    discount: number;
    shippingFee?: number;
    change: number;
    paymentMethod: string;
    items: Array<{ name: string; quantity: number; unitPrice: number; lineTotal: number }>;
    createdAt: string;
    financial?: OrderPaymentFeeFinancialSnapshotV1;
  };
  onClose: () => void;
}

export function ReceiptModal({ order, onClose }: ReceiptModalProps) {
  const [emailed, setEmailed] = useState(false);
  const [emailError, setEmailError] = useState("");
  const paymentLabel = order.paymentMethod === "cash"
    ? "Cash"
    : order.paymentMethod === "bank" || order.paymentMethod === "bank_transfer"
      ? "Bank transfer"
      : order.paymentMethod === "cod"
        ? "COD"
        : order.paymentMethod;

  function handlePrint() {
    window.print();
  }

  async function handleEmail() {
    if (!order.orderId) return;
    setEmailError("");
    try {
      await emailReceipt(order.orderId);
      setEmailed(true);
      setTimeout(() => setEmailed(false), 3000);
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "Could not send receipt email.");
    }
  }

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto rounded-xl bg-white p-6 animate-slide-up shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm">
          {/* Header */}
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-text-primary">Receipt</h2>
            <button
              onClick={onClose}
              aria-label="Close receipt"
              className="text-text-muted hover:text-text-primary transition-colors no-print"
            >
              <X size={20} />
            </button>
          </div>

          {/* Store Info */}
          <div className="mb-3 text-center">
            <p className="font-semibold text-text-primary">{RECEIPT_STORE.name}</p>
            <p className="text-xs text-text-muted">{RECEIPT_STORE.address}</p>
            <p className="text-xs text-text-muted">{order.orderNumber}</p>
          </div>

          {/* Items */}
          <div className="mb-3 border-y border-dashed border-gray-300 py-2">
            {order.items.map((item, idx) => (
              <div key={idx} className="flex items-start justify-between gap-2 py-0.5 text-xs">
                <span className="break-words text-text-primary">
                  {item.name} <span className="whitespace-nowrap">×{item.quantity}</span>
                </span>
                <span className="shrink-0 tabular-nums text-text-primary">
                  {item.lineTotal.toLocaleString("vi-VN")} ₫
                </span>
              </div>
            ))}
          </div>

          {/* Totals */}
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-text-muted">Subtotal</span>
              <span className="tabular-nums text-text-primary">
                {order.subtotal.toLocaleString("vi-VN")} ₫
              </span>
            </div>
            {order.discount > 0 && (
              <div className="flex justify-between">
                <span className="text-text-muted">Discount</span>
                <span className="tabular-nums text-status-danger">
                  −{order.discount.toLocaleString("vi-VN")} ₫
                </span>
              </div>
            )}
            {Number(order.shippingFee || 0) > 0 && (
              <div className="flex justify-between">
                <span className="text-text-muted">Shipping</span>
                <span className="tabular-nums text-text-primary">
                  {Number(order.shippingFee || 0).toLocaleString("vi-VN")} ₫
                </span>
              </div>
            )}
            {order.financial && <div className="flex justify-between">
              <span className="text-text-muted">Phí thanh toán</span>
              <span className="tabular-nums text-text-primary">{order.financial.components.paymentFeeMinor.toLocaleString("vi-VN")} ₫</span>
            </div>}
            <div className="flex justify-between">
              <span className="text-text-muted">{order.financial?.components.taxMode === "exclusive" ? "VAT" : "VAT included"}</span>
              <span className="tabular-nums text-text-primary">
                {order.tax.toLocaleString("vi-VN")} ₫
              </span>
            </div>
            <div className="flex justify-between border-t border-dashed border-gray-300 pt-1 font-bold text-base">
              <span className="text-text-primary">Total</span>
              <span className="tabular-nums text-text-primary">
                {order.total.toLocaleString("vi-VN")} ₫
              </span>
            </div>
            {order.change > 0 && (
              <div className="flex justify-between font-bold">
                <span className="text-status-success">Change</span>
                <span className="tabular-nums text-status-success">
                  {order.change.toLocaleString("vi-VN")} ₫
                </span>
              </div>
            )}
            <div className="flex justify-between text-text-muted">
              <span>Payment</span>
              <span>{paymentLabel}</span>
            </div>
            <div className="pt-2 text-center text-text-muted">
              {new Date(order.createdAt).toLocaleString("en-GB")}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-4 grid grid-cols-2 gap-2 no-print">
          <button
            onClick={handlePrint}
            className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border-default
                       py-2 text-sm text-text-secondary hover:bg-surface-hover transition-colors"
          >
            <Printer size={16} /> Print receipt
          </button>
          <button
            onClick={handleEmail}
            className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border-default
                       py-2 text-sm text-text-secondary hover:bg-surface-hover transition-colors"
          >
            <Mail size={16} /> {emailed ? "Sent" : "Send email"}
          </button>
          <button
            onClick={onClose}
            className="col-span-2 flex h-10 items-center justify-center rounded-md bg-action-primary
                       text-sm font-semibold text-text-inverse transition-colors hover:bg-action-primary-hover"
          >
            Done
          </button>
        </div>
        {emailError && (
          <p className="mt-2 text-xs text-status-danger no-print">{emailError}</p>
        )}
      </div>
    </div>
  );
}
