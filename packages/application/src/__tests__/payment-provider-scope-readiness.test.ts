import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePaymentProviderAvailabilityForClient } from "../services/payment-provider-service";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function enableLocalProviders(): void {
  process.env.NODE_ENV = "test";
  process.env.SEPAY_PAYMENTS_ENABLED = "true";
  process.env.SEPAY_LIVE_ENABLED = "false";
  process.env.CRYPTO_PAYMENTS_ENABLED = "true";
  process.env.NOWPAYMENTS_LIVE_ENABLED = "false";
  process.env.CRYPTO_PROVIDER = "nowpayments";
}

describe("scoped retail payment readiness", () => {
  it("uses the store row before merchant state and fails closed on unhealthy config", async () => {
    enableLocalProviders();
    const query = vi.fn().mockResolvedValue({
      rows: [
        { provider_key: "sepay_va", scope_type: "store", status: "inactive", has_secret: true },
        { provider_key: "sepay_va", scope_type: "merchant", status: "active", has_secret: true },
        { provider_key: "nowpayments", scope_type: "merchant", status: "error", has_secret: true },
      ],
    });

    const result = await resolvePaymentProviderAvailabilityForClient(
      { query } as never,
      { merchantId: "merchant_scope_a", storeId: "store_scope_a" },
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("CASE scope_type WHEN 'store' THEN 0 ELSE 1 END"),
      ["merchant_scope_a", "store_scope_a"],
    );
    expect(result.sepay_va).toMatchObject({
      enabled: false,
      reason: "integration_config_inactive",
    });
    expect(result.nowpayments).toMatchObject({
      enabled: false,
      reason: "integration_config_error",
    });
  });

  it("requires secret evidence but retains env fallback only when no scoped row exists", async () => {
    enableLocalProviders();
    const query = vi.fn().mockResolvedValue({
      rows: [
        { provider_key: "nowpayments", scope_type: "merchant", status: "active", has_secret: false },
      ],
    });

    const result = await resolvePaymentProviderAvailabilityForClient(
      { query } as never,
      { merchantId: "merchant_scope_b", storeId: null },
    );

    expect(result.sepay_va).toMatchObject({ enabled: true, mode: "mock" });
    expect(result.nowpayments).toMatchObject({
      enabled: false,
      reason: "integration_config_missing_secret",
    });
  });

  it("never lets a database row override a process-level kill switch", async () => {
    enableLocalProviders();
    process.env.CRYPTO_PAYMENTS_ENABLED = "false";
    const query = vi.fn().mockResolvedValue({
      rows: [
        { provider_key: "nowpayments", scope_type: "merchant", status: "active", has_secret: true },
      ],
    });

    const result = await resolvePaymentProviderAvailabilityForClient(
      { query } as never,
      { merchantId: "merchant_scope_c", storeId: "store_scope_c" },
    );

    expect(result.nowpayments).toMatchObject({
      enabled: false,
      reason: "provider_disabled",
    });
  });
});
