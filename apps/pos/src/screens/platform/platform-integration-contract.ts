import type { IntegrationConfigScope, ProviderConfigPurpose } from "@medusa-snus/contracts";
import type {
  PlatformIntegrationDto,
  ProviderAction,
  SetProviderConfigInput,
} from "../../api/settings-endpoints";

export type PlatformIntegrationReadiness = {
  label: string;
  tone: "success" | "warning" | "danger";
  detail: string;
};

export function platformIntegrationReadiness(config: PlatformIntegrationDto): PlatformIntegrationReadiness {
  if (config.status === "error" || config.requiredAction) {
    return {
      label: "Cần xử lý",
      tone: "danger",
      detail: config.requiredAction || config.healthSummary || "Cấu hình provider đang báo lỗi.",
    };
  }
  if (config.status !== "active") {
    return {
      label: "Đang tắt",
      tone: "warning",
      detail: config.healthSummary || "Cấu hình chưa được bật cho luồng này.",
    };
  }
  if (!config.hasSecret) {
    return {
      label: "Thiếu cấu hình",
      tone: "warning",
      detail: "Chưa có secret/config payload write-only.",
    };
  }
  return {
    label: "Đã cấu hình",
    tone: "success",
    detail: config.healthSummary || "Đã có cấu hình; trạng thái này không chứng minh provider live.",
  };
}

export const PLATFORM_CONFIG_PURPOSE_OPTIONS = [
  { value: "platform_billing", label: "Platform billing" },
  { value: "merchant_retail", label: "Merchant retail" },
] as const satisfies ReadonlyArray<{ value: ProviderConfigPurpose; label: string }>;

type PlatformIntegrationTarget = {
  scope: IntegrationConfigScope;
  merchantId?: string;
  merchantName?: string;
  storeId?: string;
  storeName?: string;
};

export function platformIntegrationTargetLabel(config: PlatformIntegrationTarget): string {
  if (config.scope === "store") return config.storeName || config.storeId || "store";
  if (config.scope === "merchant") return config.merchantName || config.merchantId || "merchant";
  return "platform";
}

export function platformIntegrationPurposeForScope(scope: IntegrationConfigScope): ProviderConfigPurpose {
  return scope === "platform" ? "platform_billing" : "merchant_retail";
}

export function canShowPlatformIntegrationWriteForm(permissionIds: readonly string[]): boolean {
  return permissionIds.includes("integration_config:write");
}

export type PlatformIntegrationFormInput = {
  action: ProviderAction;
  providerKey: SetProviderConfigInput["providerKey"];
  purpose: ProviderConfigPurpose;
  scope: IntegrationConfigScope;
  merchantId: string;
  storeId: string;
};

export function buildPlatformProviderConfigInput(form: PlatformIntegrationFormInput, secret: string): SetProviderConfigInput {
  const command = form.action === "disable"
    ? { action: "disable" as const }
    : { action: form.action, secret };
  if (form.scope === "platform") {
    return { ...command, providerKey: form.providerKey, purpose: "platform_billing", scope: "platform" };
  }
  if (form.scope === "store") {
    return {
      ...command,
      providerKey: form.providerKey,
      purpose: "merchant_retail",
      scope: "store",
      merchantId: form.merchantId,
      storeId: form.storeId,
    };
  }
  return {
    ...command,
    providerKey: form.providerKey,
    purpose: "merchant_retail",
    scope: "merchant",
    merchantId: form.merchantId,
  };
}
