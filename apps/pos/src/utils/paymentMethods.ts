import type { PaymentMethod } from "@medusa-snus/contracts";

export type PaymentProviderAvailability = {
  sepay_va?: { enabled: boolean; mode?: string; reason?: string };
  nowpayments?: { enabled: boolean; mode?: string; reason?: string };
};

export type PaymentIntentPaymentMethod = Extract<PaymentMethod, "sepay_va" | "nowpayments">;

export function isPaymentIntentPaymentMethod(paymentMethod: PaymentMethod | string): paymentMethod is PaymentIntentPaymentMethod {
  return paymentMethod === "sepay_va" || paymentMethod === "nowpayments";
}

export function checkoutPaymentMethods(
  paymentProviders: PaymentProviderAvailability,
  featureEntitlements: Set<string>,
): Partial<Record<PaymentMethod, boolean>> {
  return {
    cash: true,
    bank_transfer: true,
    cod: true,
    sepay_va: paymentProviders.sepay_va?.enabled ? featureEntitlements.has("sepay_qr_payment") : undefined,
    nowpayments: paymentProviders.nowpayments?.enabled && featureEntitlements.has("crypto_payment") ? true : undefined,
  };
}
