import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { platformSubscriptionNowPaymentsAdapter, platformWebhookDispatcher } from "../services/platform-subscription-nowpayments-adapter";
import { PlatformError } from "../errors/platform-error";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = sortObject((value as Record<string, unknown>)[key]);
    return acc;
  }, {});
}

describe("platform_subscription NOWPayments adapter (signature/status/purpose)", () => {
  it("declares the frozen purpose: platform_subscription / platform_billing", () => {
    expect(platformSubscriptionNowPaymentsAdapter).toMatchObject({
      provider: "nowpayments",
      configPurpose: "platform_billing",
      businessPurpose: "platform_subscription",
    });
  });

  it("verifies a signed IPN payload over the recursively sorted body", async () => {
    process.env.NOWPAYMENTS_BILLING_IPN_SECRET = "platform-billing-ipn-secret-min-32-chars";
    const payload = {
      payment_id: 9876,
      order_id: "bo_test_123",
      payment_status: "finished",
      price_amount: 3588000,
      price_currency: "vnd",
      pay_currency: "usdttrc20",
      pay_amount: 142.55,
      payin_hash: "0xpayin",
      nested: { z: 1, a: 2 },
    };
    const sig = createHmac("sha512", process.env.NOWPAYMENTS_BILLING_IPN_SECRET)
      .update(JSON.stringify(sortObject(payload)))
      .digest("hex");

    const event = await platformSubscriptionNowPaymentsAdapter.verifyWebhook({
      provider: "nowpayments",
      providerConfigPurpose: "platform_billing",
      headers: { "x-nowpayments-sig": sig },
      payload,
    });

    expect(event).toMatchObject({
      provider: "nowpayments",
      businessPurpose: "platform_subscription",
      providerConfigPurpose: "platform_billing",
      status: "provider_paid",
      referenceCode: "bo_test_123",
      providerCurrency: "usdttrc20",
    });
    expect(event.providerConfigProvenance.purpose).toBe("platform_billing");
  });

  it("rejects an unsigned IPN in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.NOWPAYMENTS_BILLING_IPN_SECRET;
    await expect(
      platformSubscriptionNowPaymentsAdapter.verifyWebhook({
        provider: "nowpayments",
        providerConfigPurpose: "platform_billing",
        headers: {},
        payload: { payment_status: "finished" },
      }),
    ).rejects.toMatchObject({ code: "provider_config_missing" });
  });

  it("rejects a tampered signature", async () => {
    process.env.NOWPAYMENTS_BILLING_IPN_SECRET = "platform-billing-ipn-secret-min-32-chars";
    await expect(
      platformSubscriptionNowPaymentsAdapter.verifyWebhook({
        provider: "nowpayments",
        providerConfigPurpose: "platform_billing",
        headers: { "x-nowpayments-sig": "deadbeef" },
        payload: { payment_status: "finished" },
      }),
    ).rejects.toMatchObject({ code: "webhook_unauthorized" });
  });

  it("only accepts a terminal success status as provider_paid", async () => {
    process.env.NOWPAYMENTS_BILLING_IPN_SECRET = "platform-billing-ipn-secret-min-32-chars";
    const payloadFor = (status: string) => ({ payment_id: `np_${status}`, order_id: `bo_${status}`, payment_status: status });
    const sigFor = (status: string) =>
      createHmac("sha512", process.env.NOWPAYMENTS_BILLING_IPN_SECRET as string)
        .update(JSON.stringify(sortObject(payloadFor(status))))
        .digest("hex");

    const finished = await platformSubscriptionNowPaymentsAdapter.verifyWebhook({
      provider: "nowpayments", providerConfigPurpose: "platform_billing",
      headers: { "x-nowpayments-sig": sigFor("finished") }, payload: payloadFor("finished"),
    });
    expect(finished.status).toBe("provider_paid");

    const confirming = await platformSubscriptionNowPaymentsAdapter.verifyWebhook({
      provider: "nowpayments", providerConfigPurpose: "platform_billing",
      headers: { "x-nowpayments-sig": sigFor("confirming") }, payload: payloadFor("confirming"),
    });
    expect(confirming.status).toBe("waiting_provider");

    const failed = await platformSubscriptionNowPaymentsAdapter.verifyWebhook({
      provider: "nowpayments", providerConfigPurpose: "platform_billing",
      headers: { "x-nowpayments-sig": sigFor("partially_paid") }, payload: payloadFor("partially_paid"),
    });
    expect(failed.status).toBe("manual_review");
  });


  it("does not use merchant-retail NOWPayments credentials for platform billing quotes", async () => {
    process.env.NOWPAYMENTS_API_KEY = "merchant-retail-key-must-not-be-used";
    delete process.env.NOWPAYMENTS_BILLING_LIVE_ENABLED;

    const result = await platformSubscriptionNowPaymentsAdapter.createIntent({
      businessPurpose: "platform_subscription",
      providerConfigPurpose: "platform_billing",
      providerConfig: {
        provider: "nowpayments", purpose: "platform_billing",
        scope: { scopeType: "platform", merchantId: null, storeId: null },
        configId: "platform_billing_nowpayments", liveMode: false,
      },
      scope: { scopeKind: "platform_billing", merchantId: "merchant_default" },
      referenceCode: "bo_mock_quote",
      amount: { currencyCode: "vnd", amountVnd: "3588000" },
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    });

    expect(result.providerReference).toBe("bo_mock_quote");
    expect(result.providerQuoteSnapshot).toMatchObject({
      providerConfigPurpose: "platform_billing",
      businessPurpose: "platform_subscription",
      providerPaymentId: null,
    });
  });

  it("refuses to dispatch a merchant_retail route through the platform dispatcher", async () => {
    process.env.NOWPAYMENTS_BILLING_IPN_SECRET = "platform-billing-ipn-secret-min-32-chars";
    await expect(
      platformWebhookDispatcher.dispatch({
        routeId: "retail-nowpayments-webhook",
        provider: "nowpayments",
        businessPurpose: "retail_order",
        providerConfigPurpose: "merchant_retail",
        headers: {},
        payload: { payment_status: "finished" },
      }),
    ).rejects.toMatchObject({ code: "webhook_route_mismatch" });
  });
});
