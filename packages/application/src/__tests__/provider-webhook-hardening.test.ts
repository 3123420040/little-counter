import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import apiMiddlewares from "../../../../src/api/middlewares";
import {
  verifyNowPaymentsWebhook,
  verifySepayWebhook,
} from "../services/payment-provider-service";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = sortCanonical((value as Record<string, unknown>)[key]);
    return result;
  }, {});
}

describe("PAY-02E provider webhook hardening", () => {
  it("fails SePay HMAC closed when the exact raw body is unavailable", () => {
    process.env.SEPAY_WEBHOOK_AUTH_MODE = "hmac";
    process.env.SEPAY_WEBHOOK_SECRET = "test-sepay-webhook-secret-min-32-chars";
    process.env.SEPAY_MERCHANT_RETAIL_CONFIG_ID = "sepay-retail-primary";
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = { id: "sepay-raw-required", transferAmount: 125000, transferType: "in" };
    const reconstructed = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", process.env.SEPAY_WEBHOOK_SECRET)
      .update(`${timestamp}.${reconstructed}`)
      .digest("hex")}`;

    expect(() => verifySepayWebhook({
      "x-sepay-timestamp": String(timestamp),
      "x-sepay-signature": signature,
    }, payload)).toThrow("raw body");
  });

  it("rejects unauthenticated SePay mode in production even when feature flags drift", () => {
    process.env.NODE_ENV = "production";
    process.env.SEPAY_WEBHOOK_AUTH_MODE = "none";
    process.env.SEPAY_MERCHANT_RETAIL_CONFIG_ID = "sepay-retail-primary";
    process.env.SEPAY_PAYMENTS_ENABLED = "false";
    process.env.SEPAY_LIVE_ENABLED = "false";

    expect(() => verifySepayWebhook({}, {
      id: "sepay-prod-none",
      transferAmount: 125000,
      transferType: "in",
    }, "{}"))
      .toThrow("Unauthenticated SePay webhook mode is disabled in production");
  });

  it("binds SePay HMAC verification to the exact signed-byte digest", () => {
    process.env.SEPAY_WEBHOOK_AUTH_MODE = "hmac";
    process.env.SEPAY_WEBHOOK_SECRET = "test-sepay-webhook-secret-min-32-chars";
    process.env.SEPAY_MERCHANT_RETAIL_CONFIG_ID = "sepay-retail-primary";
    const timestamp = Math.floor(Date.now() / 1000);
    const rawBody = '{"transferType":"in", "transferAmount":125000,"id":"sepay-digest","transactionDate":"2026-08-05 10:00:00"}';
    const signature = `sha256=${createHmac("sha256", process.env.SEPAY_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex")}`;

    const event = verifySepayWebhook({
      "x-sepay-timestamp": String(timestamp),
      "x-sepay-signature": signature,
    }, JSON.parse(rawBody), rawBody);

    expect(event.verification).toMatchObject({
      mode: "hmac",
      authenticated: true,
      signatureAlgorithm: "hmac-sha256",
      rawBodyPreserved: true,
      signedPayloadSha256: createHash("sha256").update(rawBody).digest("hex"),
      providerConfigPurpose: "merchant_retail",
      providerConfigId: "sepay-retail-primary",
    });
    expect(event.providerOccurredAt).toBe("2026-08-05T03:00:00.000Z");
  });

  it("authenticates a well-formed SePay API-key header without persisting the secret", () => {
    process.env.SEPAY_WEBHOOK_AUTH_MODE = "api_key";
    process.env.SEPAY_WEBHOOK_SECRET = "test-sepay-webhook-secret-min-32-chars";
    process.env.SEPAY_MERCHANT_RETAIL_CONFIG_ID = "sepay-retail-primary";
    const payload = { id: "sepay-api-key", transferAmount: 125000, transferType: "in" };

    const event = verifySepayWebhook({
      authorization: `Apikey ${process.env.SEPAY_WEBHOOK_SECRET}`,
    }, payload, JSON.stringify(payload));

    expect(event.verification).toMatchObject({
      mode: "api_key",
      authenticated: true,
      signatureAlgorithm: "api-key",
      providerConfigPurpose: "merchant_retail",
      providerConfigId: "sepay-retail-primary",
    });
    expect(JSON.stringify(event.verification)).not.toContain(process.env.SEPAY_WEBHOOK_SECRET);
  });

  it("fails production SePay closed without exact retail config identity", () => {
    process.env.NODE_ENV = "production";
    process.env.SEPAY_WEBHOOK_AUTH_MODE = "hmac";
    process.env.SEPAY_WEBHOOK_SECRET = "test-sepay-webhook-secret-min-32-chars";
    delete process.env.SEPAY_MERCHANT_RETAIL_CONFIG_ID;

    expect(() => verifySepayWebhook({}, { id: "sepay-no-config" }, "{}"))
      .toThrow("SEPAY_MERCHANT_RETAIL_CONFIG_ID is required in production");
  });

  it("binds a signed NOWPayments payload to retail config provenance", () => {
    process.env.NOWPAYMENTS_CONFIG_PURPOSE = "merchant_retail";
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_CONFIG_ID = "cfg_retail_primary";
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET = "test-nowpayments-ipn-secret-min-32-chars";
    const payload = {
      order_id: "PINOWDIGEST",
      payment_id: "np-digest-1",
      payment_status: "finished",
      pay_currency: "usdttrc20",
      actually_paid: "5.000000",
      payin_hash: "0xnow-digest",
      updated_at: "2026-08-05T03:00:00.000Z",
      nested: { z: 1, a: 2 },
    };
    const canonical = JSON.stringify(sortCanonical(payload));
    const signature = createHmac("sha512", process.env.NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET)
      .update(canonical)
      .digest("hex");

    const event = verifyNowPaymentsWebhook({ "x-nowpayments-sig": signature }, payload);

    expect(event.verification).toMatchObject({
      authenticated: true,
      signatureAlgorithm: "hmac-sha512",
      signedPayloadSha256: createHash("sha256").update(canonical).digest("hex"),
      providerConfigPurpose: "merchant_retail",
      providerConfigId: "cfg_retail_primary",
    });
    expect(event.providerOccurredAt).toBe("2026-08-05T03:00:00.000Z");
  });

  it("fails production NOWPayments closed without exact retail config identity", () => {
    process.env.NODE_ENV = "production";
    process.env.NOWPAYMENTS_CONFIG_PURPOSE = "merchant_retail";
    delete process.env.NOWPAYMENTS_MERCHANT_RETAIL_CONFIG_ID;
    process.env.NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET = "test-nowpayments-ipn-secret-min-32-chars";
    const payload = {
      order_id: "PINOCONFIG",
      payment_id: "np-no-config",
      payment_status: "finished",
      pay_currency: "usdttrc20",
    };
    const canonical = JSON.stringify(sortCanonical(payload));
    const signature = createHmac("sha512", process.env.NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET)
      .update(canonical)
      .digest("hex");

    expect(() => verifyNowPaymentsWebhook({ "x-nowpayments-sig": signature }, payload))
      .toThrow("NOWPAYMENTS_MERCHANT_RETAIL_CONFIG_ID is required in production");
  });

  it("preserves raw request bytes on every public SePay route", () => {
    const routes = (apiMiddlewares as unknown as {
      routes: Array<{
        matcher: string;
        methods?: string[];
        bodyParser?: { preserveRawBody?: boolean };
      }>;
    }).routes;

    for (const matcher of ["/webhooks/sepay", "/api/webhooks/sepay"]) {
      expect(routes).toContainEqual(expect.objectContaining({
        matcher,
        methods: expect.arrayContaining(["POST"]),
        bodyParser: expect.objectContaining({ preserveRawBody: true }),
      }));
    }
  });

  it("keeps the Medusa middleware boundary compatible with the runtime ts-node resolver", () => {
    const source = readFileSync(resolve("src/api/middlewares.ts"), "utf8");

    expect(source).toContain('require("@medusajs/framework/http")');
    expect(source).not.toContain('from "@medusajs/framework/http"');
  });
});
