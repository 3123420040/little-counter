import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PaymentProviderKey,
  ProviderAdapterCreateIntentInput,
  ProviderAdapterIntentResult,
  ProviderWebhookEvent,
  ProviderWebhookVerificationInput,
  PurposeBoundPaymentProviderAdapter,
  WebhookDispatchInput,
  WebhookDispatcher,
} from "@medusa-snus/contracts";
import { ProviderWebhookEventSchema } from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";
import {
  handlePlatformNowPaymentsWebhook,
  platformBillingIpnSecret,
  quoteNowPaymentsBillingOrder,
} from "./subscription-billing-service";

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const lower = name.toLowerCase();
  const value = headers[name] ?? headers[lower]
    ?? Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = sortObject((value as Record<string, unknown>)[key]);
    return result;
  }, {});
}

function constantTimeEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function moneyAmountVnd(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.round(value));
  return undefined;
}

function inferStatus(paymentStatus: string): ProviderWebhookEvent["status"] {
  const normalized = paymentStatus.toLowerCase();
  if (normalized === "finished" || normalized === "confirmed") return "provider_paid";
  if (normalized === "expired") return "provider_expired";
  if (normalized === "failed" || normalized === "refunded" || normalized === "partially_paid") return "manual_review";
  return "waiting_provider";
}

function providerAmountFromPayload(payload: Record<string, unknown>): string | undefined {
  const amount = stringValue(payload.actually_paid || payload.pay_amount || payload.outcome_amount);
  return amount || undefined;
}

function providerCurrencyFromPayload(payload: Record<string, unknown>): string | undefined {
  const currency = stringValue(payload.pay_currency || payload.outcome_currency || payload.currency).toLowerCase();
  return currency || undefined;
}

function inferNetworkFromCurrency(currency: string): string {
  const normalized = currency.toLowerCase();
  if (normalized.endsWith("trc20")) return "trc20";
  if (normalized.endsWith("erc20")) return "erc20";
  if (normalized.endsWith("matic") || normalized.endsWith("polygon")) return "polygon";
  if (normalized.endsWith("bsc")) return "bsc";
  return "";
}

function providerNetworkFromPayload(payload: Record<string, unknown>): string | undefined {
  const explicit = stringValue(payload.network || payload.blockchain || payload.chain).toLowerCase();
  if (explicit) return explicit;
  const currency = providerCurrencyFromPayload(payload);
  return currency ? inferNetworkFromCurrency(currency) : undefined;
}

function platformBillingProvenance(liveMode: boolean) {
  return {
    provider: "nowpayments" as PaymentProviderKey,
    purpose: "platform_billing" as const,
    scope: { scopeType: "platform" as const, merchantId: null, storeId: null },
    configId: "platform_billing_nowpayments",
    secretRefId: "NOWPAYMENTS_BILLING_IPN_SECRET",
    liveMode,
  };
}

export const platformSubscriptionNowPaymentsAdapter: PurposeBoundPaymentProviderAdapter = {
  provider: "nowpayments",
  configPurpose: "platform_billing",
  businessPurpose: "platform_subscription",

  async createIntent(input: ProviderAdapterCreateIntentInput): Promise<ProviderAdapterIntentResult> {
    if (input.businessPurpose !== "platform_subscription" || input.providerConfigPurpose !== "platform_billing") {
      throw new PlatformError("provider_purpose_mismatch", "NOWPayments platform adapter only supports platform_subscription/platform_billing", 400);
    }

    const amountVnd = input.amount.amountVnd;
    const quote = await quoteNowPaymentsBillingOrder({
      amountVnd,
      payCurrency: process.env.NOWPAYMENTS_BILLING_PAY_CURRENCY || undefined,
      orderId: input.referenceCode,
    });

    return {
      providerReference: quote.providerPaymentId || input.referenceCode,
      paymentUrl: null,
      qrPayload: `NOWPAYMENTS|PURPOSE=platform_subscription|AMOUNT_VND=${amountVnd}|PAY=${quote.providerAmount}|CURRENCY=${quote.providerCurrency}|ORDER=${input.referenceCode}`,
      providerQuoteSnapshot: {
        provider: "nowpayments",
        providerConfigPurpose: "platform_billing",
        businessPurpose: "platform_subscription",
        amountVnd,
        providerPaymentId: quote.providerPaymentId,
        providerCurrency: quote.providerCurrency,
        providerNetwork: quote.providerNetwork,
        providerAmount: quote.providerAmount,
        quoteExpiresAt: quote.quoteExpiresAt,
        providerFeeAbsorbedBy: "platform",
      },
      metadata: {
        provider: "nowpayments",
        providerConfigPurpose: "platform_billing",
        businessPurpose: "platform_subscription",
        quoteExpiresAt: quote.quoteExpiresAt,
      },
    };
  },

  async verifyWebhook(input: ProviderWebhookVerificationInput): Promise<ProviderWebhookEvent> {
    if (input.provider !== "nowpayments" || input.providerConfigPurpose !== "platform_billing") {
      throw new PlatformError("provider_purpose_mismatch", "Expected NOWPayments platform_billing webhook", 400);
    }

    const secret = platformBillingIpnSecret();
    const signature = header(input.headers, "x-nowpayments-sig");
    const liveMode = Boolean(secret);
    if (!secret && process.env.NODE_ENV === "production") {
      throw new PlatformError("provider_config_missing", "NOWPAYMENTS_BILLING_IPN_SECRET is required in production", 500);
    }
    if (secret) {
      if (!signature) throw new PlatformError("webhook_unauthorized", "Missing NOWPayments billing IPN signature", 401);
      const expected = createHmac("sha512", secret).update(JSON.stringify(sortObject(input.payload))).digest("hex");
      if (!constantTimeEquals(expected, signature)) {
        throw new PlatformError("webhook_unauthorized", "Invalid NOWPayments billing IPN signature", 401);
      }
    }

    const paymentStatus = stringValue(input.payload.payment_status || input.payload.status).toLowerCase();
    const providerPaymentId = stringValue(input.payload.payment_id || input.payload.invoice_id || input.payload.purchase_id);
    const providerEventId = stringValue(input.payload.payment_id || input.payload.invoice_id || input.payload.order_id || `now_evt_${Date.now()}`);
    const referenceCode = stringValue(input.payload.order_id || input.payload.referenceCode) || undefined;
    const priceAmountVnd = moneyAmountVnd(input.payload.price_currency === "vnd" ? input.payload.price_amount : undefined);
    const providerAmountStr = providerAmountFromPayload(input.payload);
    const providerCurrency = providerCurrencyFromPayload(input.payload);

    const event = ProviderWebhookEventSchema.parse({
      provider: "nowpayments",
      providerEventId,
      businessPurpose: "platform_subscription",
      providerConfigPurpose: "platform_billing",
      providerConfigProvenance: platformBillingProvenance(liveMode),
      status: inferStatus(paymentStatus),
      referenceCode,
      amount: priceAmountVnd ? { currencyCode: "vnd", amountVnd: priceAmountVnd } : undefined,
      providerAmount: providerAmountStr ? { value: providerAmountStr } : undefined,
      providerCurrency,
      occurredAt: new Date().toISOString(),
      payload: input.payload,
    });

    if (!providerPaymentId && !referenceCode && event.status === "provider_paid") {
      throw new PlatformError("provider_payload_invalid", "NOWPayments platform IPN missing payment_id", 400);
    }

    return event;
  },
};

export const platformWebhookDispatcher: WebhookDispatcher = {
  async dispatch(input: WebhookDispatchInput): Promise<ProviderWebhookEvent> {
    if (
      input.routeId !== "platform-nowpayments-webhook"
      || input.provider !== "nowpayments"
      || input.businessPurpose !== "platform_subscription"
      || input.providerConfigPurpose !== "platform_billing"
    ) {
      throw new PlatformError("webhook_route_mismatch", "Unsupported platform webhook route", 400);
    }
    const event = await platformSubscriptionNowPaymentsAdapter.verifyWebhook({
      provider: input.provider,
      providerConfigPurpose: input.providerConfigPurpose,
      headers: input.headers,
      payload: input.payload,
      rawBody: input.rawBody,
    });

    await handlePlatformNowPaymentsWebhook({
      providerEventId: event.providerEventId,
      eventType: `nowpayments.${String(input.payload.payment_status || input.payload.status || "payment")}`,
      paymentStatus: stringValue(input.payload.payment_status || input.payload.status).toLowerCase(),
      providerPaymentId: stringValue(input.payload.payment_id || input.payload.invoice_id || input.payload.purchase_id),
      payCurrency: stringValue(input.payload.pay_currency || input.payload.outcome_currency || input.payload.currency).toLowerCase(),
      providerNetwork: providerNetworkFromPayload(input.payload),
      payAmount: Number(input.payload.actually_paid || input.payload.pay_amount || input.payload.outcome_amount || 0),
      priceAmount: Number(input.payload.price_amount || 0),
      priceCurrency: stringValue(input.payload.price_currency || "").toLowerCase(),
      orderId: stringValue(input.payload.order_id || ""),
      orderDescription: stringValue(input.payload.order_description || ""),
      payload: input.payload,
    });

    return event;
  },
};
