import { afterEach, describe, expect, it } from "vitest";
import type { OperatorContext } from "../services/auth-service";
import { createPaymentIntent } from "../services/payment-intent-service";
import { getCrossSellRecommendations } from "../services/recommendation-service";

const originalPackage = process.env.APP_PACKAGE_KEY;
const originalFlags = process.env.FEATURE_FLAGS;
const originalSepayPaymentsEnabled = process.env.SEPAY_PAYMENTS_ENABLED;
const originalSepayLiveEnabled = process.env.SEPAY_LIVE_ENABLED;
const originalCryptoPaymentsEnabled = process.env.CRYPTO_PAYMENTS_ENABLED;
const originalNowPaymentsLiveEnabled = process.env.NOWPAYMENTS_LIVE_ENABLED;
const originalCryptoProvider = process.env.CRYPTO_PROVIDER;

const actor: OperatorContext = {
  operatorId: "op_owner",
  role: "owner",
  displayName: "Owner",
  organizationId: "org_default",
};

afterEach(() => {
  if (originalPackage === undefined) delete process.env.APP_PACKAGE_KEY;
  else process.env.APP_PACKAGE_KEY = originalPackage;
  if (originalFlags === undefined) delete process.env.FEATURE_FLAGS;
  else process.env.FEATURE_FLAGS = originalFlags;
  if (originalSepayPaymentsEnabled === undefined) delete process.env.SEPAY_PAYMENTS_ENABLED;
  else process.env.SEPAY_PAYMENTS_ENABLED = originalSepayPaymentsEnabled;
  if (originalSepayLiveEnabled === undefined) delete process.env.SEPAY_LIVE_ENABLED;
  else process.env.SEPAY_LIVE_ENABLED = originalSepayLiveEnabled;
  if (originalCryptoPaymentsEnabled === undefined) delete process.env.CRYPTO_PAYMENTS_ENABLED;
  else process.env.CRYPTO_PAYMENTS_ENABLED = originalCryptoPaymentsEnabled;
  if (originalNowPaymentsLiveEnabled === undefined) delete process.env.NOWPAYMENTS_LIVE_ENABLED;
  else process.env.NOWPAYMENTS_LIVE_ENABLED = originalNowPaymentsLiveEnabled;
  if (originalCryptoProvider === undefined) delete process.env.CRYPTO_PROVIDER;
  else process.env.CRYPTO_PROVIDER = originalCryptoProvider;
});

describe("paid feature guards", () => {
  it("blocks SePay payment intent creation for Basic before provider/DB work", async () => {
    process.env.APP_PACKAGE_KEY = "basic";
    delete process.env.FEATURE_FLAGS;

    await expect(createPaymentIntent({ "idempotency-key": "guard-sepay-basic" }, {
      provider: "sepay_va",
      order: {
        items: [{ variantId: "var_mint_20", quantity: 1 }],
        paymentMethod: "sepay_va",
        amountReceived: 0,
      },
    }, actor)).rejects.toMatchObject({
      code: "feature_not_entitled",
      statusCode: 403,
      details: { feature: "sepay_qr_payment", packageKey: "basic" },
    });
  });

  it("blocks cross-sell recommendations for Basic before query work", async () => {
    process.env.APP_PACKAGE_KEY = "basic";
    delete process.env.FEATURE_FLAGS;

    await expect(getCrossSellRecommendations({
      items: [{ variantId: "var_mint_20", quantity: 1 }],
      merchantId: "merchant_default",
    })).rejects.toMatchObject({
      code: "feature_not_entitled",
      statusCode: 403,
      details: { feature: "smart_cross_sell", packageKey: "basic" },
    });
  });

  it("blocks SePay payment intent creation for Plus when provider kill switch is off", async () => {
    process.env.APP_PACKAGE_KEY = "plus";
    delete process.env.FEATURE_FLAGS;
    process.env.SEPAY_PAYMENTS_ENABLED = "false";
    process.env.SEPAY_LIVE_ENABLED = "false";

    await expect(createPaymentIntent({ "idempotency-key": "guard-sepay-provider-disabled" }, {
      provider: "sepay_va",
      order: {
        items: [{ variantId: "var_mint_20", quantity: 1 }],
        paymentMethod: "sepay_va",
        amountReceived: 0,
      },
    }, actor)).rejects.toMatchObject({
      code: "provider_disabled",
      statusCode: 503,
      details: { provider: "sepay_va", reason: "provider_disabled" },
    });
  });

  it("blocks NOWPayments payment intent creation for Plus when crypto provider config is off", async () => {
    process.env.APP_PACKAGE_KEY = "plus";
    delete process.env.FEATURE_FLAGS;
    process.env.CRYPTO_PAYMENTS_ENABLED = "false";
    process.env.NOWPAYMENTS_LIVE_ENABLED = "false";
    process.env.CRYPTO_PROVIDER = "nowpayments";

    await expect(createPaymentIntent({ "idempotency-key": "guard-nowpayments-provider-disabled" }, {
      provider: "nowpayments",
      order: {
        items: [{ variantId: "var_mint_20", quantity: 1 }],
        paymentMethod: "nowpayments",
        amountReceived: 0,
      },
    }, actor)).rejects.toMatchObject({
      code: "provider_disabled",
      statusCode: 503,
      details: { provider: "nowpayments", reason: "provider_disabled" },
    });
  });
});
