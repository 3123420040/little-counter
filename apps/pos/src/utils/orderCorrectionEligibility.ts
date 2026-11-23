import type { OrderListItem } from "../api/endpoints";

export interface OrderCorrectionEligibility {
  allowed: boolean;
  reason?: string;
}

const EXTERNAL_PAYMENT_METHODS = new Set([
  "sepay_va",
  "nowpayments",
  "crypto_usdc",
  "crypto_usdt",
]);

const BLOCKED_PAYMENT_STATUSES = new Set([
  "chargeback",
  "manual_review",
  "partially_refunded",
  "refunded",
]);

export function getOrderCorrectionEligibility(order: OrderListItem): OrderCorrectionEligibility {
  if (order.status === "canceled") {
    return { allowed: false, reason: "Đơn đã hủy không thể điều chỉnh." };
  }

  if (order.paymentEntries?.some((entry) => (
    entry.direction === "refund"
    && entry.status === "posted"
    && entry.source !== "order_correction"
  ))) {
    return { allowed: false, reason: "Đơn đã có hoàn tiền; hãy dùng quy trình hoàn tiền/đối soát." };
  }

  if (order.correctionSummary?.hasPendingSettlement) {
    return { allowed: false, reason: "Đơn đang có chênh lệch điều chỉnh chưa đối soát." };
  }

  const paymentStatus = String(order.paymentStatus || "").toLowerCase();
  if (BLOCKED_PAYMENT_STATUSES.has(paymentStatus)) {
    return { allowed: false, reason: "Trạng thái thanh toán hiện tại cần quy trình đối soát riêng." };
  }

  const paymentMethod = String(
    order.paymentMethod
      || order.paymentEntries?.find((entry) => entry.direction === "charge")?.method
      || "",
  ).toLowerCase();
  if (EXTERNAL_PAYMENT_METHODS.has(paymentMethod)) {
    return {
      allowed: false,
      reason: "Đơn dùng nhà cung cấp thanh toán ngoài không thể điều chỉnh trong phiên bản này.",
    };
  }

  return { allowed: true };
}
