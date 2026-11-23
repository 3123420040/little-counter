import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "../db/client";
import { withConnectedClient } from "../db/transaction";
import type { HeadersLike } from "../http/headers";
import { PlatformError } from "../errors/platform-error";

export type PaymentProviderKey = "mock" | "sepay_va" | "nowpayments";

export interface ProviderIntentInput {
  provider: PaymentProviderKey;
  intentId: string;
  referenceCode: string;
  amount: number;
  currencyCode: string;
  expiresAt: Date;
  description?: string;
  organizationId?: string;
  merchantId?: string;
  storeId?: string;
}

export interface ProviderIntentArtifacts {
  providerReference: string;
  paymentUrl: string | null;
  qrPayload: string | null;
  metadata: Record<string, unknown>;
}

export interface VerifiedWebhookEvent {
  provider: PaymentProviderKey;
  providerEventId: string;
  eventType: string;
  amount: number;
  currencyCode: string;
  content?: string;
  referenceCode?: string;
  providerTransactionId?: string;
  providerTransactionHash?: string;
  providerNetwork?: string;
  providerPayCurrency?: string;
  providerOccurredAt?: string;
  providerFeeAmount?: number;
  providerFeeCurrency?: string;
  grossQuantity?: string;
  providerFeeQuantity?: string;
  retailCryptoAsset?: "USDTTRC20" | "USDCMATIC";
  payload: Record<string, unknown>;
  verification: Record<string, unknown>;
  direction?: "in" | "out" | "unknown";
}

const NOWPAYMENTS_ALLOWED_PAY_CURRENCIES = new Set(["usdttrc20", "usdcmatic"]);
const NOWPAYMENTS_TERMINAL_SUCCESS_STATUSES = new Set(["finished"]);

export interface PaymentProviderAvailability {
  sepay_va: { enabled: boolean; mode: "mock" | "live"; reason?: string };
  nowpayments: { enabled: boolean; mode: "mock" | "live"; reason?: string };
}

export interface PaymentProviderScope {
  merchantId: string;
  storeId?: string | null;
}

interface RetailIntegrationConfigRow {
  provider_key: "sepay_va" | "nowpayments";
  scope_type: "merchant" | "store";
  status: "active" | "inactive" | "error";
  has_secret: boolean;
}

function env(name: string): string {
  return process.env[name]?.trim() || "";
}

function boolEnv(name: string): boolean {
  return env(name).toLowerCase() === "true";
}

function isProduction(): boolean {
  return env("NODE_ENV") === "production";
}

function intEnv(name: string, fallback: number): number {
  const parsed = Number(env(name));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function header(headers: HeadersLike, name: string): string {
  const lower = name.toLowerCase();
  const value = headers[name] ?? headers[lower] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function constantTimeEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sepayProviderOccurredAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const localAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    localAsUtc.getUTCFullYear() !== year
    || localAsUtc.getUTCMonth() !== month - 1
    || localAsUtc.getUTCDate() !== day
    || localAsUtc.getUTCHours() !== hour
    || localAsUtc.getUTCMinutes() !== minute
    || localAsUtc.getUTCSeconds() !== second
  ) return undefined;
  return new Date(localAsUtc.getTime() - 7 * 60 * 60 * 1_000).toISOString();
}

function offsetProviderOccurredAt(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
  ) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = sortObject((value as Record<string, unknown>)[key]);
    return result;
  }, {});
}

function providerMode(provider: PaymentProviderKey): "mock" | "live" {
  if (provider === "sepay_va" && boolEnv("SEPAY_LIVE_ENABLED")) return "live";
  if (provider === "nowpayments" && boolEnv("NOWPAYMENTS_LIVE_ENABLED")) return "live";
  return "mock";
}

export function getPaymentProviderAvailability(): PaymentProviderAvailability {
  const sepayMode = providerMode("sepay_va");
  const cryptoProvider = env("CRYPTO_PROVIDER") || "nowpayments";
  const sepayRequested = boolEnv("SEPAY_PAYMENTS_ENABLED") || boolEnv("SEPAY_LIVE_ENABLED");
  const cryptoRequested = boolEnv("CRYPTO_PAYMENTS_ENABLED") || boolEnv("NOWPAYMENTS_LIVE_ENABLED");
  const cryptoLive = providerMode("nowpayments") === "live";
  const cryptoMerchantApproved = !isProduction() || boolEnv("CRYPTO_MERCHANT_APPROVED");
  const sepayEnabled = sepayRequested && (!isProduction() || sepayMode === "live");
  const cryptoEnabled = cryptoRequested
    && cryptoProvider === "nowpayments"
    && (!isProduction() || (cryptoLive && cryptoMerchantApproved));

  const sepayReason = !sepayRequested
    ? "provider_disabled"
    : isProduction() && sepayMode !== "live"
      ? "live_provider_not_enabled"
      : undefined;
  const cryptoReason = !cryptoRequested
    ? "provider_disabled"
    : cryptoProvider !== "nowpayments"
      ? "unsupported_provider"
      : isProduction() && !cryptoLive
        ? "live_provider_not_enabled"
        : isProduction() && !cryptoMerchantApproved
          ? "merchant_not_approved"
          : undefined;

  return {
    sepay_va: {
      enabled: sepayEnabled,
      mode: sepayMode,
      reason: sepayReason,
    },
    nowpayments: {
      enabled: cryptoEnabled,
      mode: providerMode("nowpayments"),
      reason: cryptoReason,
    },
  };
}

function applyScopedRetailConfig(
  availability: PaymentProviderAvailability,
  provider: RetailIntegrationConfigRow["provider_key"],
  config: RetailIntegrationConfigRow | undefined,
): void {
  // Process-level switches are the outer kill switch. A scoped row may only
  // further restrict availability; it can never turn a globally disabled
  // provider on.
  if (!config || !availability[provider].enabled) return;
  if (config.status !== "active") {
    availability[provider] = {
      ...availability[provider],
      enabled: false,
      reason: config.status === "error"
        ? "integration_config_error"
        : "integration_config_inactive",
    };
    return;
  }
  if (!config.has_secret) {
    availability[provider] = {
      ...availability[provider],
      enabled: false,
      reason: "integration_config_missing_secret",
    };
  }
}

export async function resolvePaymentProviderAvailabilityForClient(
  client: PoolClient,
  scope: PaymentProviderScope,
): Promise<PaymentProviderAvailability> {
  const merchantId = String(scope.merchantId || "").trim();
  if (!merchantId) {
    throw new PlatformError("scope_required", "Payment provider readiness requires merchant scope", 409);
  }
  const availability = getPaymentProviderAvailability();
  const result = await client.query<RetailIntegrationConfigRow>(`
    SELECT provider_key, scope_type, status,
           (secret_digest IS NOT NULL) AS has_secret
    FROM app.integration_configs
    WHERE purpose = 'merchant_retail'
      AND provider_key IN ('sepay_va', 'nowpayments')
      AND merchant_id = $1
      AND (
        scope_type = 'merchant'
        OR (scope_type = 'store' AND store_id = $2)
      )
    ORDER BY provider_key,
             CASE scope_type WHEN 'store' THEN 0 ELSE 1 END,
             updated_at DESC,
             id
  `, [merchantId, scope.storeId || null]);
  const effective = new Map<RetailIntegrationConfigRow["provider_key"], RetailIntegrationConfigRow>();
  for (const row of result.rows) {
    if (!effective.has(row.provider_key)) effective.set(row.provider_key, row);
  }
  applyScopedRetailConfig(availability, "sepay_va", effective.get("sepay_va"));
  applyScopedRetailConfig(availability, "nowpayments", effective.get("nowpayments"));
  return availability;
}

export function resolvePaymentProviderAvailability(
  scope: PaymentProviderScope,
): Promise<PaymentProviderAvailability> {
  return withConnectedClient((client) => resolvePaymentProviderAvailabilityForClient(client, scope));
}

export async function createProviderIntent(input: ProviderIntentInput): Promise<ProviderIntentArtifacts> {
  if (input.provider === "mock") return createMockIntent(input);
  if (input.provider === "sepay_va") {
    return providerMode(input.provider) === "live" ? createSepayIntent(input) : createLocalSepayIntent(input);
  }
  return providerMode(input.provider) === "live" ? createNowPaymentsIntent(input) : createLocalNowPaymentsIntent(input);
}

function createMockIntent(input: ProviderIntentInput): ProviderIntentArtifacts {
  return {
    providerReference: `mock_${input.intentId}`,
    paymentUrl: `/payment-intents/${encodeURIComponent(input.intentId)}/mock-settle`,
    qrPayload: `MOCK|${input.referenceCode}|${Math.round(input.amount)}|${input.currencyCode.toUpperCase()}`,
    metadata: { mode: "mock" },
  };
}

function createLocalSepayIntent(input: ProviderIntentInput): ProviderIntentArtifacts {
  return {
    providerReference: input.referenceCode,
    paymentUrl: null,
    qrPayload: `SEPAY|AMOUNT=${Math.round(input.amount)}|CONTENT=${input.referenceCode}|EXPIRY=${intEnv("PAYMENT_QR_EXPIRY_SECONDS", 900)}`,
    metadata: {
      mode: "mock",
      provider: "sepay_va",
      providerConfigPurpose: "merchant_retail",
      providerConfigId: "local_merchant_retail",
    },
  };
}

async function createSepayIntent(input: ProviderIntentInput): Promise<ProviderIntentArtifacts> {
  const apiBase = env("SEPAY_API_BASE") || "https://userapi.sepay.vn/v2";
  const bankAccountId = env("SEPAY_BANK_ACCOUNT_ID");
  const token = env("SEPAY_API_TOKEN");
  const providerConfigId = env("SEPAY_MERCHANT_RETAIL_CONFIG_ID");
  if (!bankAccountId) throw new PlatformError("provider_config_missing", "SEPAY_BANK_ACCOUNT_ID is required for live SePay payments", 503);
  if (!token) throw new PlatformError("provider_config_missing", "SEPAY_API_TOKEN is required for live SePay payments", 503);
  if (!providerConfigId) throw new PlatformError("provider_config_missing", "SEPAY_MERCHANT_RETAIL_CONFIG_ID is required for retail provenance", 503);

  const duration = Math.max(60, Math.round((input.expiresAt.getTime() - Date.now()) / 1000));
  const requestBody: Record<string, unknown> = {
    order_code: input.referenceCode,
    amount: Math.round(input.amount),
    duration,
    with_qrcode: "1",
  };
  if (env("SEPAY_TERMINAL_ID")) requestBody.tid = env("SEPAY_TERMINAL_ID");
  if (env("SEPAY_VA_PREFIX")) requestBody.va_prefix = env("SEPAY_VA_PREFIX");
  if (env("SEPAY_QRCODE_TEMPLATE")) requestBody.qrcode_template = env("SEPAY_QRCODE_TEMPLATE");

  const response = await fetch(`${apiBase.replace(/\/$/, "")}/bank-accounts/${encodeURIComponent(bankAccountId)}/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new PlatformError("provider_request_failed", `SePay create order failed with HTTP ${response.status}`, 502, { provider: "sepay_va", status: response.status, payload });
  }
  const data = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
  return {
    providerReference: String(data.id || data.order_id || input.referenceCode),
    paymentUrl: typeof data.qr_code_url === "string" ? data.qr_code_url : null,
    qrPayload: String(data.qr_code || data.qr_code_url || data.va_number || input.referenceCode),
    metadata: {
      mode: "live",
      provider: "sepay_va",
      providerConfigPurpose: "merchant_retail",
      providerConfigId,
      providerResponse: sanitizeProviderPayload(data),
    },
  };
}

function createLocalNowPaymentsIntent(input: ProviderIntentInput): ProviderIntentArtifacts {
  const payCurrency = (env("NOWPAYMENTS_MERCHANT_RETAIL_PAY_CURRENCY") || "usdttrc20").toLowerCase();
  return {
    providerReference: input.referenceCode,
    paymentUrl: `/payment-intents/${encodeURIComponent(input.intentId)}/mock-settle`,
    qrPayload: `NOWPAYMENTS|AMOUNT=${Math.round(input.amount)}|CURRENCY=${input.currencyCode.toUpperCase()}|ORDER=${input.referenceCode}`,
    metadata: {
      mode: "mock",
      provider: "nowpayments",
      providerConfigPurpose: "merchant_retail",
      providerConfigId: "local_merchant_retail",
      destinationWalletRef: "local_mock_wallet",
      payCurrency,
    },
  };
}

async function createNowPaymentsIntent(input: ProviderIntentInput): Promise<ProviderIntentArtifacts> {
  const apiBase = env("NOWPAYMENTS_API_BASE") || "https://api.nowpayments.io/v1";
  const configPurpose = env("NOWPAYMENTS_CONFIG_PURPOSE");
  if (configPurpose !== "merchant_retail") {
    throw new PlatformError("provider_config_invalid", "Retail NOWPayments requires merchant_retail credentials", 503, {
      provider: "nowpayments",
      purpose: configPurpose,
    });
  }
  const apiKey = env("NOWPAYMENTS_MERCHANT_RETAIL_API_KEY");
  const callbackUrl = env("NOWPAYMENTS_MERCHANT_RETAIL_IPN_CALLBACK_URL");
  const providerConfigId = env("NOWPAYMENTS_MERCHANT_RETAIL_CONFIG_ID");
  const destinationWalletRef = env("NOWPAYMENTS_MERCHANT_RETAIL_WALLET_REF");
  if (!apiKey) throw new PlatformError("provider_config_missing", "NOWPAYMENTS_MERCHANT_RETAIL_API_KEY is required for live retail NOWPayments", 503);
  if (!callbackUrl) throw new PlatformError("provider_config_missing", "NOWPAYMENTS_MERCHANT_RETAIL_IPN_CALLBACK_URL is required for live retail NOWPayments", 503);
  if (!providerConfigId) throw new PlatformError("provider_config_missing", "NOWPAYMENTS_MERCHANT_RETAIL_CONFIG_ID is required for retail provenance", 503);
  if (!destinationWalletRef) throw new PlatformError("provider_config_missing", "NOWPAYMENTS_MERCHANT_RETAIL_WALLET_REF is required for retail provenance", 503);

  const payCurrency = (env("NOWPAYMENTS_MERCHANT_RETAIL_PAY_CURRENCY") || "usdttrc20").toLowerCase();
  if (!NOWPAYMENTS_ALLOWED_PAY_CURRENCIES.has(payCurrency)) {
    throw new PlatformError("provider_config_invalid", "NOWPayments pay currency is not allowed for retail", 503, {
      provider: "nowpayments",
      payCurrency,
    });
  }
  const priceCurrency = env("NOWPAYMENTS_MERCHANT_RETAIL_PRICE_CURRENCY") || "usd";
  if (priceCurrency.toLowerCase() !== "usd") {
    throw new PlatformError("provider_config_invalid", "NOWPayments retail quote currency must be USD", 503, {
      provider: "nowpayments",
      priceCurrency,
    });
  }
  const vndUsdRateText = env("NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE");
  const vndUsdRate = Number(vndUsdRateText);
  if (!Number.isFinite(vndUsdRate) || vndUsdRate <= 0) {
    throw new PlatformError("provider_config_missing", "NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE is required for live retail quote snapshots", 503);
  }
  const priceAmount = Number((input.amount / vndUsdRate).toFixed(2));
  const quotedAt = new Date();
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/payment`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      price_amount: priceAmount,
      price_currency: priceCurrency,
      pay_currency: payCurrency,
      ipn_callback_url: callbackUrl,
      order_id: input.referenceCode,
      order_description: input.description || `SNUS payment ${input.referenceCode}`,
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new PlatformError("provider_request_failed", `NOWPayments create payment failed with HTTP ${response.status}`, 502, { provider: "nowpayments", status: response.status, payload });
  }
  const providerReference = stringValue(payload.payment_id || payload.invoice_id);
  if (!providerReference) {
    throw new PlatformError("provider_response_invalid", "NOWPayments create payment response is missing payment_id/invoice_id", 502);
  }
  const expectedProviderAmount = decimalValue(payload.pay_amount);
  if (!expectedProviderAmount || Number(expectedProviderAmount) <= 0) {
    throw new PlatformError("provider_response_invalid", "NOWPayments create payment response is missing a positive pay_amount", 502);
  }
  return {
    providerReference,
    paymentUrl: typeof payload.invoice_url === "string" ? payload.invoice_url : null,
    qrPayload: String(payload.pay_address || payload.payment_url || payload.invoice_url || input.referenceCode),
    metadata: {
      mode: "live",
      provider: "nowpayments",
      providerConfigPurpose: "merchant_retail",
      providerConfigId,
      destinationWalletRef,
      expectedProviderAmount,
      expectedProviderCurrency: payCurrency,
      payCurrency,
      quote: {
        vndAmount: input.amount,
        quotedUsdAmount: priceAmount,
        vndUsdRate,
        expectedProviderAmount,
        exchangeRateSource: "NOWPAYMENTS_MERCHANT_RETAIL_VND_USD_RATE",
        quotedAt: quotedAt.toISOString(),
        quoteExpiresAt: input.expiresAt.toISOString(),
        payCurrency,
      },
      providerResponse: sanitizeProviderPayload(payload),
    },
  };
}

export function verifySepayWebhook(headers: HeadersLike, payload: Record<string, unknown>, rawBody?: string): VerifiedWebhookEvent {
  const mode = env("SEPAY_WEBHOOK_AUTH_MODE") || (env("SEPAY_WEBHOOK_SECRET") ? "hmac" : "none");
  const secret = env("SEPAY_WEBHOOK_SECRET");
  const providerConfigId = env("SEPAY_MERCHANT_RETAIL_CONFIG_ID") || null;
  if (isProduction() && !providerConfigId) {
    throw new PlatformError(
      "provider_config_missing",
      "SEPAY_MERCHANT_RETAIL_CONFIG_ID is required in production",
      500,
    );
  }
  const verification: Record<string, unknown> = {
    mode,
    authenticated: false,
    providerConfigPurpose: "merchant_retail",
    providerConfigId,
  };
  if (mode === "api_key") {
    const auth = header(headers, "authorization");
    const expected = secret ? `Apikey ${secret}` : "";
    if (!secret || !auth || !constantTimeEquals(expected, auth)) {
      throw new PlatformError("webhook_unauthorized", "Invalid SePay webhook API key", 401);
    }
    verification.authenticated = true;
    verification.signatureAlgorithm = "api-key";
    verification.payloadSha256 = sha256Text(JSON.stringify(sortObject(payload)));
  } else if (mode === "hmac") {
    const signature = header(headers, "x-sepay-signature");
    const timestamp = Number(header(headers, "x-sepay-timestamp"));
    if (!secret || !signature || !timestamp) throw new PlatformError("webhook_unauthorized", "Missing SePay webhook signature", 401);
    if (typeof rawBody !== "string" || rawBody.length === 0) {
      throw new PlatformError("webhook_unauthorized", "Missing SePay raw body for HMAC verification", 401);
    }
    const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (skewSeconds > intEnv("SEPAY_WEBHOOK_MAX_SKEW_SECONDS", 300)) {
      throw new PlatformError("webhook_unauthorized", "Expired SePay webhook signature timestamp", 401);
    }
    const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
    if (!constantTimeEquals(expected, signature)) throw new PlatformError("webhook_unauthorized", "Invalid SePay webhook signature", 401);
    verification.authenticated = true;
    verification.signatureAlgorithm = "hmac-sha256";
    verification.rawBodyPreserved = true;
    verification.signedPayloadSha256 = sha256Text(rawBody);
    verification.timestampSkewSeconds = skewSeconds;
  } else if (mode === "none") {
    if (isProduction()) {
      throw new PlatformError(
        "provider_config_invalid",
        "Unauthenticated SePay webhook mode is disabled in production",
        500,
      );
    }
    verification.payloadSha256 = sha256Text(JSON.stringify(sortObject(payload)));
  } else if (mode !== "none") {
    throw new PlatformError("provider_config_invalid", "Unsupported SEPAY_WEBHOOK_AUTH_MODE", 500);
  }

  return {
    provider: "sepay_va",
    providerEventId: requireStableProviderEventId(
      [payload.id, payload.transaction_id, payload.reference],
      "sepay_va",
    ),
    eventType: String(payload.event || payload.type || "sepay.transaction"),
    amount: Number(payload.transferAmount || payload.amount || payload.transfer_amount || 0),
    currencyCode: "vnd",
    content: String(payload.content || payload.description || payload.transferContent || ""),
    referenceCode: typeof payload.code === "string" ? payload.code : typeof payload.referenceCode === "string" ? payload.referenceCode : undefined,
    providerOccurredAt: sepayProviderOccurredAt(payload.transactionDate),
    direction: sepayTransferDirection(payload.transferType),
    payload,
    verification,
  };
}

function sepayTransferDirection(value: unknown): "in" | "out" | "unknown" {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "in" || normalized === "+") return "in";
  if (normalized === "out" || normalized === "-") return "out";
  return "unknown";
}

/**
 * Stable provider transaction/event dedupe id.
 * The provider MUST supply an immutable id; we never generate random ids
 * for events that will be persisted in the unique event ledger.
 */
function requireStableProviderEventId(candidates: unknown[], provider: PaymentProviderKey): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate !== 0) return String(candidate);
  }
  throw new PlatformError(
    "provider_event_id_missing",
    `${provider} webhook is missing a stable provider event id`,
    400,
  );
}

export function verifyNowPaymentsWebhook(headers: HeadersLike, payload: Record<string, unknown>): VerifiedWebhookEvent {
  const configPurpose = env("NOWPAYMENTS_CONFIG_PURPOSE");
  if (configPurpose !== "merchant_retail") {
    throw new PlatformError("provider_config_invalid", "Retail NOWPayments webhook requires merchant_retail configuration", 503, {
      provider: "nowpayments",
      purpose: configPurpose || null,
    });
  }
  const secret = env("NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET");
  const providerConfigId = env("NOWPAYMENTS_MERCHANT_RETAIL_CONFIG_ID") || null;
  if (isProduction() && !providerConfigId) {
    throw new PlatformError(
      "provider_config_missing",
      "NOWPAYMENTS_MERCHANT_RETAIL_CONFIG_ID is required in production",
      500,
    );
  }
  const signature = header(headers, "x-nowpayments-sig");
  const canonicalPayload = JSON.stringify(sortObject(payload));
  const verification: Record<string, unknown> = {
    mode: secret ? "hmac_sha512" : "none",
    authenticated: false,
    providerConfigPurpose: "merchant_retail",
    providerConfigId,
    signedPayloadSha256: sha256Text(canonicalPayload),
  };
  if (secret) {
    if (!signature) throw new PlatformError("webhook_unauthorized", "Missing NOWPayments IPN signature", 401);
    const expected = createHmac("sha512", secret).update(canonicalPayload).digest("hex");
    if (!constantTimeEquals(expected, signature)) throw new PlatformError("webhook_unauthorized", "Invalid NOWPayments IPN signature", 401);
    verification.authenticated = true;
    verification.signatureAlgorithm = "hmac-sha512";
  } else if (process.env.NODE_ENV === "production") {
    throw new PlatformError("provider_config_missing", "NOWPAYMENTS_MERCHANT_RETAIL_IPN_SECRET is required in production", 500);
  }

  const status = String(payload.payment_status || payload.status || "");
  const payCurrency = stringValue(payload.pay_currency || payload.outcome_currency || payload.currency);
  const transactionId = stringValue(payload.payment_id || payload.invoice_id || payload.purchase_id || payload.order_id);
  const transactionHash = stringValue(
    payload.payin_hash
      || payload.payout_hash
      || payload.outcome_hash
      || payload.transaction_hash
      || payload.tx_hash
      || payload.hash,
  );
  const network = stringValue(payload.network || payload.blockchain || payload.chain || inferNetworkFromCurrency(payCurrency));
  const normalizedAsset = normalizeRetailCryptoAsset(payCurrency, network);

  // Locked provider policy: only USDTTRC20 (TRON) and native USDCMATIC (Polygon)
  // are accepted. MATICUSDCE / USDC.e and any other network are rejected.
  const payCurrencyNormalized = payCurrency.toLowerCase();
  if (!NOWPAYMENTS_ALLOWED_PAY_CURRENCIES.has(payCurrencyNormalized) || !normalizedAsset) {
    return {
      provider: "nowpayments",
      providerEventId: requireStableProviderEventId(
        [payload.payment_id, payload.invoice_id, payload.order_id],
        "nowpayments",
      ),
      eventType: `nowpayments.${status || "payment"}`,
      amount: Number(payload.price_amount || payload.actually_paid || payload.pay_amount || 0),
      currencyCode: String(payload.price_currency || payload.pay_currency || "usd").toLowerCase(),
      content: String(payload.order_description || payload.order_id || ""),
      referenceCode: typeof payload.referenceCode === "string" ? payload.referenceCode : typeof payload.order_id === "string" ? payload.order_id : undefined,
      providerTransactionId: transactionId || undefined,
      providerTransactionHash: transactionHash || undefined,
      providerNetwork: network ? normalizeNetwork(network) : undefined,
      providerPayCurrency: payCurrencyNormalized || undefined,
      providerOccurredAt: offsetProviderOccurredAt(
        firstDefined(payload.updated_at, payload.payment_updated_at),
      ),
      payload,
      verification: {
        ...verification,
        assetRejected: true,
        reason: NOWPAYMENTS_ALLOWED_PAY_CURRENCIES.has(payCurrencyNormalized)
          ? "unsupported_asset_network"
          : "unsupported_pay_currency",
      },
    };
  }

  // Fee quantity and currency (merchant-held asset accounting evidence).
  const grossQuantity = decimalValue(payload.actually_paid);
  const feeQuantity = decimalValue(firstDefined(payload.fee, payload.outcome_fee, payload.network_fee));
  const feeCurrency = stringValue(payload.fee_currency || payload.outcome_currency);
  const providerFeeResolved = feeQuantity !== undefined
    && feeCurrency.toLowerCase() === payCurrencyNormalized;
  const feeAmountRaw = providerFeeResolved ? Number(feeQuantity) : Number.NaN;

  return {
    provider: "nowpayments",
    providerEventId: requireStableProviderEventId(
      [payload.payment_id, payload.invoice_id, payload.order_id],
      "nowpayments",
    ),
    eventType: `nowpayments.${status || "payment"}`,
    amount: Number(grossQuantity || payload.pay_amount || 0),
    currencyCode: payCurrencyNormalized,
    content: String(payload.order_description || payload.order_id || ""),
    referenceCode: typeof payload.referenceCode === "string" ? payload.referenceCode : typeof payload.order_id === "string" ? payload.order_id : undefined,
    providerTransactionId: transactionId || undefined,
    providerTransactionHash: transactionHash || undefined,
    providerNetwork: normalizedAsset.network,
    providerPayCurrency: payCurrency ? payCurrency.toLowerCase() : undefined,
    providerOccurredAt: offsetProviderOccurredAt(
      firstDefined(payload.updated_at, payload.payment_updated_at),
    ),
    providerFeeAmount: Number.isFinite(feeAmountRaw) ? feeAmountRaw : undefined,
    providerFeeCurrency: providerFeeResolved ? feeCurrency.toLowerCase() : undefined,
    grossQuantity,
    providerFeeQuantity: providerFeeResolved ? feeQuantity : undefined,
    retailCryptoAsset: normalizedAsset.asset,
    payload,
    verification: {
      ...verification,
      paymentStatus: status.toLowerCase(),
      terminal: NOWPAYMENTS_TERMINAL_SUCCESS_STATUSES.has(status.toLowerCase()),
      asset: normalizedAsset.asset,
      assetRejected: false,
      providerFeeResolved,
    },
  };
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function decimalValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) return undefined;
  return text;
}

function normalizeNetwork(value: string): string {
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, "");
  if (["trc20", "tron"].includes(normalized)) return "trc20";
  if (["matic", "polygon", "polygonpos"].includes(normalized)) return "matic";
  return normalized;
}

function normalizeRetailCryptoAsset(
  payCurrency: string,
  network: string,
): { asset: "USDTTRC20" | "USDCMATIC"; network: "trc20" | "matic" } | null {
  const currency = payCurrency.toLowerCase();
  const normalizedNetwork = normalizeNetwork(network || inferNetworkFromCurrency(currency));
  if (currency === "usdttrc20" && normalizedNetwork === "trc20") {
    return { asset: "USDTTRC20", network: "trc20" };
  }
  if (currency === "usdcmatic" && normalizedNetwork === "matic") {
    return { asset: "USDCMATIC", network: "matic" };
  }
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function inferNetworkFromCurrency(currency: string): string {
  const normalized = currency.toLowerCase();
  if (normalized.endsWith("trc20")) return "trc20";
  if (normalized.endsWith("matic")) return "matic";
  if (normalized.endsWith("erc20")) return "erc20";
  if (normalized.endsWith("bsc")) return "bsc";
  if (normalized.endsWith("sol")) return "solana";
  if (normalized.endsWith("polygon")) return "polygon";
  return "";
}

function sanitizeProviderPayload(payload: Record<string, unknown>) {
  const blocked = new Set(["api_key", "token", "authorization", "secret"]);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !blocked.has(key.toLowerCase())));
}
