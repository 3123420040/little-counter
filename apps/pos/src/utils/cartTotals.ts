/**
 * Cart-level commercial adjustment preview helper. UI totals are previews;
 * the backend normalizes totals authoritatively on sale completion.
 */
import type { CartPaymentFeePreviewV1, PaymentFeeInputV1 } from "@medusa-snus/contracts";

export type DiscountType = "percent" | "amount";

export interface CartCommercialAdjustment extends Partial<PaymentFeeInputV1> {
  discountType: DiscountType;
  /** Percent (0..100) or fixed VND amount. */
  discountValue: number;
  shippingFee: number;
}

export type CartPaymentFeePreviewState = { status: "pending" } | { status: "unavailable"; message: string }
  | { status: "ready"; preview: CartPaymentFeePreviewV1 };

export function cartTotalsForDisplay(subtotal: number, adjustment: CartCommercialAdjustment, feePreview?: CartPaymentFeePreviewState): CartTotalsPreview {
  const legacy = previewCartTotals(subtotal, adjustment);
  if (!feePreview) return adjustment.paymentFeeType !== undefined || adjustment.paymentFeeValue !== undefined
    ? { ...legacy, discountError: "Cần bản tính phụ phí từ máy chủ trước khi thanh toán." } : legacy;
  if (feePreview.status !== "ready") return { ...legacy, discountError: feePreview.status === "pending" ? "Đang cập nhật giá và phụ phí…" : feePreview.message };
  const c = feePreview.preview.data.financial.components;
  return { subtotal: c.merchandiseGrossMinor, discount: c.discountMinor, shippingFee: c.shippingMinor, payable: c.totalMinor, discountError: null };
}

export interface CartTotalsPreview {
  subtotal: number;
  discount: number;
  shippingFee: number;
  payable: number;
  discountError: string | null;
}

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env || {};
const nodeEnv = typeof process !== "undefined" ? process.env : {};
const vatRate = Number(viteEnv.VITE_VAT_RATE ?? nodeEnv.VITE_VAT_RATE ?? "0.10");
const VAT_RATE = Number.isFinite(vatRate) && vatRate >= 0 ? vatRate : 0.1;
const TAX_MODE: "inclusive" | "exclusive" = (viteEnv.VITE_TAX_MODE ?? nodeEnv.VITE_TAX_MODE) === "exclusive"
  ? "exclusive"
  : "inclusive";

export function previewCartTotals(
  subtotal: number,
  adjustment: CartCommercialAdjustment,
): CartTotalsPreview {
  let discount = 0;
  let discountError: string | null = null;

  if (adjustment.discountType === "amount") {
    const value = Math.round(adjustment.discountValue || 0);
    if (value < 0 || !Number.isFinite(adjustment.discountValue)) {
      discountError = "Giảm giá phải là số nguyên dương.";
    } else if (!Number.isInteger(adjustment.discountValue)) {
      discountError = "Giảm giá phải là số nguyên VND.";
    } else if (value > subtotal) {
      discountError = "Giảm giá không được vượt quá tạm tính.";
    } else {
      discount = value;
    }
  } else {
    const percent = Number(adjustment.discountValue || 0);
    if (percent < 0 || percent > 100) {
      discountError = "Phần trăm giảm giá phải từ 0 đến 100.";
    } else {
      discount = Math.round(subtotal * (percent / 100));
    }
  }

  const merchandisePayable = Math.max(0, subtotal - discount);
  const shippingFee = Math.max(0, Math.round(adjustment.shippingFee || 0));
  const tax = TAX_MODE === "inclusive" ? 0 : Math.round(merchandisePayable * VAT_RATE) + Math.round(shippingFee * VAT_RATE);
  const payable = TAX_MODE === "inclusive"
    ? merchandisePayable + shippingFee
    : merchandisePayable + shippingFee + tax;

  return {
    subtotal,
    discount,
    shippingFee,
    payable,
    discountError,
  };
}

export const NO_DISCOUNT: CartCommercialAdjustment = {
  discountType: "percent",
  discountValue: 0,
  shippingFee: 0,
};
