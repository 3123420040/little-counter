import { describe, expect, it } from "vitest";
import {
  PLATFORM_CONFIG_PURPOSE_OPTIONS,
  buildPlatformProviderConfigInput,
  canShowPlatformIntegrationWriteForm,
  platformIntegrationReadiness,
  platformIntegrationTargetLabel,
} from "./platform-integration-contract";

describe("PlatformIntegrationsScreen contract helpers", () => {
  it.each([
    [{ scope: "platform" }, "platform"],
    [{ scope: "merchant", merchantId: "merchant_a", merchantName: "Merchant A" }, "Merchant A"],
    [{ scope: "store", merchantId: "merchant_a", storeId: "store_a", storeName: "Store A" }, "Store A"],
  ] as const)("renders the %s target without falling back to platform", (config, expected) => {
    expect(platformIntegrationTargetLabel(config)).toBe(expected);
  });

  it("offers only canonical provider config purposes", () => {
    expect(PLATFORM_CONFIG_PURPOSE_OPTIONS.map((option) => option.value)).toEqual([
      "platform_billing",
      "merchant_retail",
    ]);
  });

  it("only shows write-only mutation controls to integration_config:write users", () => {
    expect(canShowPlatformIntegrationWriteForm(["platform:read", "integration_config:read"])).toBe(false);
    expect(canShowPlatformIntegrationWriteForm(["platform:read", "integration_config:read", "integration_config:write"])).toBe(true);
  });

  it("builds a concrete store target and omits secret entirely for disable", () => {
    const payload = buildPlatformProviderConfigInput({
      action: "disable",
      providerKey: "nowpayments",
      purpose: "merchant_retail",
      scope: "store",
      merchantId: "merchant_a",
      storeId: "store_a",
    }, "");

    expect(payload).toEqual({
      action: "disable",
      providerKey: "nowpayments",
      purpose: "merchant_retail",
      scope: "store",
      merchantId: "merchant_a",
      storeId: "store_a",
    });
    expect("secret" in payload).toBe(false);
  });

  it("labels configured local provider state without claiming live readiness", () => {
    const readiness = platformIntegrationReadiness({
      configId: "cfg_local",
      providerKey: "sepay_va",
      purpose: "merchant_retail",
      scope: "merchant",
      merchantId: "merchant_a",
      status: "active",
      hasSecret: true,
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
    });

    expect(readiness).toEqual({
      label: "Đã cấu hình",
      tone: "success",
      detail: "Đã có cấu hình; trạng thái này không chứng minh provider live.",
    });
  });

  it("prioritizes required provider action over an active status", () => {
    const readiness = platformIntegrationReadiness({
      configId: "cfg_action",
      providerKey: "nowpayments",
      purpose: "platform_billing",
      scope: "platform",
      status: "active",
      hasSecret: true,
      requiredAction: "Xác minh callback",
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
    });

    expect(readiness).toMatchObject({ label: "Cần xử lý", tone: "danger", detail: "Xác minh callback" });
  });
});
