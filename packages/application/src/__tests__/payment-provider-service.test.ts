import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderIntent,
  getPaymentProviderAvailability,
  verifyNowPaymentsWebhook,
  verifySepayWebhook,
} from "../services/payment-provider-service";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = sorted((value as Record<string, unknown>)[key]);
    return acc;
  }, {});
}

describe("payment provider service", () => {
  it("keeps crypto provider unavailable until explicit config enables it", () => {
    process.env.APP_PACKAGE_KEY = "ai_fan";
    delete process.env.CRYPTO_PAYMENTS_ENABLED;
    delete process.env.NOWPAYMENTS_LIVE_ENABLED;
    expect(getPaymentProviderAvailability().nowpayments).toMatchObject({
      enabled: false,
      reason: "provider_disabled",
    });

    process.env.CRYPTO_PAYMENTS_ENABLED = "true";
    process.env.CRYPTO_PROVIDER = "nowpayments";
    expect(getPaymentProviderAvailability().nowpayments).toMatchObject({
      enabled: true,
      mode: "mock",
    });
  });

  it("requires explicit merchant approval for production crypto availability", () => {
    process.env.NODE_ENV = "production";
    process.env.CRYPTO_PAYMENTS_ENABLED = "true";
    process.env.CRYPTO_PROVIDER = "nowpayments";
    process.env.NOWPAYMENTS_LIVE_ENABLED = "true";
    delete process.env.CRYPTO_MERCHANT_APPROVED;

    expect(getPaymentProviderAvailability().nowpayments).toMatchObject({
      enabled: false,
      mode: "live",
      reason: "merchant_not_approved",
    });

    process.env.CRYPTO_MERCHANT_APPROVED = "true";
    expect(getPaymentProviderAvailability().nowpayments).toMatchObject({
      enabled: true,
      mode: "live",
    });
  });

  it("creates local SePay artifacts unless live mode is explicitly enabled", async () => {
    process.env.SEPAY_LIVE_ENABLED = "false";
    const result = await createProviderIntent({
      provider: "sepay_va",
      intentId: "pi_test",
      referenceCode: "PIABC123456",
      amount: 250000,
      currencyCode: "vnd",
      expiresAt: new Date(Date.now() + 900_000),
    });

    expect(result).toMatchObject({
      providerReference: "PIABC123456",
      paymentUrl: null,
    });
    expect(result.qrPayload).toContain("CONTENT=PIABC123456");
    expect(result.metadata).toMatchObject({ mode: "mock", provider: "sepay_va" });
  });

  it("requires live SePay account configuration when live mode is enabled", async () => {
    process.env.SEPAY_LIVE_ENABLED = "true";
    await expect(createProviderIntent({
      provider: "sepay_va",
      intentId: "pi_test",
      referenceCode: "PIABC123456",
      amount: 250000,
      currencyCode: "vnd",
      expiresAt: new Date(Date.now() + 900_000),
    })).rejects.toMatchObject({ code: "provider_config_missing" });
  });

  it("verifies SePay HMAC signatures against timestamp and body", () => {
    process.env.SEPAY_WEBHOOK_AUTH_MODE = "hmac";
    process.env.SEPAY_WEBHOOK_SECRET = "test-sepay-webhook-secret-min-32-chars";
    const timestamp = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({ id: 123, code: "PIABC123456", transferAmount: 250000, transferType: "in" });
    const signature = `sha256=${createHmac("sha256", process.env.SEPAY_WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest("hex")}`;

    const event = verifySepayWebhook({
      "x-sepay-timestamp": String(timestamp),
      "x-sepay-signature": signature,
    }, JSON.parse(rawBody), rawBody);

    expect(event).toMatchObject({
      provider: "sepay_va",
      providerEventId: "123",
      referenceCode: "PIABC123456",
      amount: 250000,
      direction: "in",
    });
  });

  it("normalizes outgoing SePay transfers without allowing random event ids", () => {
    process.env.SEPAY_WEBHOOK_AUTH_MODE = "none";

    const event = verifySepayWebhook({}, {
      id: "txn-out-1",
      code: "PIABC123456",
      transferAmount: 250000,
      transferType: "out",
    });

    expect(event).toMatchObject({
      providerEventId: "txn-out-1",
      direction: "out",
    });
    expect(() => verifySepayWebhook({}, { code: "PIABC123456", transferAmount: 250000, transferType: "in" }))
      .toThrow("missing a stable provider event id");
  });

  it("rejects invalid SePay API key webhooks", () => {
    process.env.SEPAY_WEBHOOK_AUTH_MODE = "api_key";
    process.env.SEPAY_WEBHOOK_SECRET = "test-sepay-webhook-secret-min-32-chars";

    expect(() => verifySepayWebhook({ authorization: "Apikey wrong" }, { id: 1 }, "{}")).toThrow("Invalid SePay webhook API key");
  });

  it("verifies NOWPayments IPN HMAC signatures over recursively sorted payload", () => {
    process.env.NOWPAYMENTS_CONFIG_PURPOSE = "merchant_retail";
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET = "test-nowpayments-ipn-secret-min-32-chars";
    const payload = {
      order_id: "PIABC123456",
      payment_id: 12345,
      payment_status: "finished",
      price_amount: 12.5,
      price_currency: "usd",
      pay_currency: "usdttrc20",
      actually_paid: "12.500000",
      outcome_fee: "0.062500",
      fee_currency: "usdttrc20",
      payin_hash: "0xnowpayments-payin-hash",
      nested: { z: 1, a: 2 },
    };
    const signature = createHmac("sha512", process.env.NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET)
      .update(JSON.stringify(sorted(payload)))
      .digest("hex");

    const event = verifyNowPaymentsWebhook({ "x-nowpayments-sig": signature }, payload);

    expect(event).toMatchObject({
      provider: "nowpayments",
      providerEventId: "12345",
      referenceCode: "PIABC123456",
      eventType: "nowpayments.finished",
      amount: 12.5,
      providerTransactionId: "12345",
      providerTransactionHash: "0xnowpayments-payin-hash",
      providerNetwork: "trc20",
      providerPayCurrency: "usdttrc20",
      grossQuantity: "12.500000",
      providerFeeQuantity: "0.062500",
      verification: expect.objectContaining({ terminal: true, providerFeeResolved: true }),
    });
  });

  it("marks non-terminal NOWPayments IPNs as non-terminal evidence", () => {
    process.env.NOWPAYMENTS_CONFIG_PURPOSE = "merchant_retail";
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET = "test-nowpayments-ipn-secret-min-32-chars";
    const payload = {
      order_id: "PIABC123456",
      payment_id: 12345,
      payment_status: "waiting",
      price_amount: 12.5,
      price_currency: "usd",
      pay_currency: "usdttrc20",
    };
    const signature = createHmac("sha512", process.env.NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET)
      .update(JSON.stringify(sorted(payload)))
      .digest("hex");

    const event = verifyNowPaymentsWebhook({ "x-nowpayments-sig": signature }, payload);

    expect(event.verification).toMatchObject({ terminal: false, paymentStatus: "waiting" });
  });

  it("rejects bridged USDC.e / MATICUSDCE into manual review evidence", () => {
    process.env.NOWPAYMENTS_CONFIG_PURPOSE = "merchant_retail";
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET = "test-nowpayments-ipn-secret-min-32-chars";
    const payload = {
      order_id: "PIABC123456",
      payment_id: 12345,
      payment_status: "finished",
      price_amount: 12.5,
      price_currency: "usd",
      pay_currency: "maticusdce",
    };
    const signature = createHmac("sha512", process.env.NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET)
      .update(JSON.stringify(sorted(payload)))
      .digest("hex");

    const event = verifyNowPaymentsWebhook({ "x-nowpayments-sig": signature }, payload);

    expect(event.providerPayCurrency).toBe("maticusdce");
    expect(event.verification).toMatchObject({ assetRejected: true, reason: "unsupported_pay_currency" });
  });

  it("accepts native USDCMATIC and rejects a conflicting explicit network", () => {
    process.env.NOWPAYMENTS_CONFIG_PURPOSE = "merchant_retail";
    const native = verifyNowPaymentsWebhook({}, {
      order_id: "PIUSDCMATIC1",
      payment_id: 7001,
      payment_status: "finished",
      pay_currency: "usdcmatic",
      actually_paid: "10.000000",
      outcome_fee: "0.010000",
      fee_currency: "usdcmatic",
      payin_hash: "0xnative-usdc-polygon",
      network: "polygon",
    });
    expect(native).toMatchObject({
      providerPayCurrency: "usdcmatic",
      providerNetwork: "matic",
      grossQuantity: "10.000000",
      providerFeeQuantity: "0.010000",
      verification: expect.objectContaining({ asset: "USDCMATIC", assetRejected: false }),
    });

    const wrongNetwork = verifyNowPaymentsWebhook({}, {
      order_id: "PIUSDCMATIC2",
      payment_id: 7002,
      payment_status: "finished",
      pay_currency: "usdcmatic",
      actually_paid: "10.000000",
      outcome_fee: "0.010000",
      fee_currency: "usdcmatic",
      payin_hash: "0xwrong-network",
      network: "ethereum",
    });
    expect(wrongNetwork.verification).toMatchObject({ assetRejected: true, reason: "unsupported_asset_network" });
  });

  it("does not treat confirmed or sending as terminal retail settlement", () => {
    process.env.NOWPAYMENTS_CONFIG_PURPOSE = "merchant_retail";
    for (const status of ["confirmed", "sending"]) {
      const event = verifyNowPaymentsWebhook({}, {
        order_id: `PI${status.toUpperCase()}`,
        payment_id: `np-${status}`,
        payment_status: status,
        pay_currency: "usdttrc20",
      });
      expect(event.verification).toMatchObject({ terminal: false, paymentStatus: status });
    }
  });

  it("keeps missing provider fee evidence unresolved", () => {
    process.env.NOWPAYMENTS_CONFIG_PURPOSE = "merchant_retail";
    const event = verifyNowPaymentsWebhook({}, {
      order_id: "PIMISSINGFEE",
      payment_id: "np-missing-fee",
      payment_status: "finished",
      pay_currency: "usdttrc20",
      actually_paid: "2.000000",
      payin_hash: "0xmissing-fee",
    });
    expect(event.providerFeeQuantity).toBeUndefined();
    expect(event.verification).toMatchObject({ terminal: true, providerFeeResolved: false });
  });

  it("requires purpose-bound merchant retail credentials with no generic fallback", async () => {
    process.env.NOWPAYMENTS_LIVE_ENABLED = "true";
    process.env.NOWPAYMENTS_CONFIG_PURPOSE = "platform_billing";
    process.env.NOWPAYMENTS_API_KEY = "platform-or-generic-key";
    await expect(createProviderIntent({
      provider: "nowpayments",
      intentId: "pi_wrong_purpose",
      referenceCode: "PIWRONGPURPOSE",
      amount: 250000,
      currencyCode: "vnd",
      expiresAt: new Date(Date.now() + 900_000),
      merchantId: "merchant_a",
      storeId: "store_a",
    })).rejects.toMatchObject({ code: "provider_config_invalid" });

    process.env.NOWPAYMENTS_CONFIG_PURPOSE = "merchant_retail";
    await expect(createProviderIntent({
      provider: "nowpayments",
      intentId: "pi_no_retail_key",
      referenceCode: "PINORETAILKEY",
      amount: 250000,
      currencyCode: "vnd",
      expiresAt: new Date(Date.now() + 900_000),
      merchantId: "merchant_a",
      storeId: "store_a",
    })).rejects.toMatchObject({ code: "provider_config_missing" });
  });

  it("persists retail config, wallet and quote provenance from live payment creation", async () => {
    process.env.NOWPAYMENTS_LIVE_ENABLED = "true";
    process.env.NOWPAYMENTS_CONFIG_PURPOSE = "merchant_retail";
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_API_KEY = "merchant-retail-test-key";
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_IPN_CALLBACK_URL = "https://example.test/api/webhooks/crypto/nowpayments";
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_CONFIG_ID = "cfg_merchant_a_retail";
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_WALLET_REF = "wallet_merchant_a_usdt";
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_PAY_CURRENCY = "usdttrc20";
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE = "25000";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      payment_id: "np-live-7001",
      pay_amount: "10.000000",
      pay_currency: "usdttrc20",
      pay_address: "provider-deposit-address",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createProviderIntent({
      provider: "nowpayments",
      intentId: "pi_live_retail",
      referenceCode: "PILIVERETAIL",
      amount: 250000,
      currencyCode: "vnd",
      expiresAt: new Date("2026-06-21T02:15:00.000Z"),
      merchantId: "merchant_a",
      storeId: "store_a",
    });

    expect(result).toMatchObject({
      providerReference: "np-live-7001",
      metadata: {
        providerConfigPurpose: "merchant_retail",
        providerConfigId: "cfg_merchant_a_retail",
        destinationWalletRef: "wallet_merchant_a_usdt",
        expectedProviderAmount: "10.000000",
        expectedProviderCurrency: "usdttrc20",
        quote: {
          vndAmount: 250000,
          quotedUsdAmount: 10,
          vndUsdRate: 25000,
          expectedProviderAmount: "10.000000",
          exchangeRateSource: "NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE",
          quoteExpiresAt: "2026-06-21T02:15:00.000Z",
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.metadata)).not.toContain("merchant-retail-test-key");
  });
});
