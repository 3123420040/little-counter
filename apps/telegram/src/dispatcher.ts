import { BackendClient } from "./backend-client";
import { type TelegramConfig } from "./config";
import { handleUpdate, type HandlerOptions } from "./handlers";
import { SessionStore } from "./session-store";
import { TelegramApi, type TelegramUpdate } from "./telegram-api";

export interface TelegramWebhookConfig {
  id: string;
  merchantId: string;
  tokenSecretRef: string;
  defaultStoreId?: string | null;
}

export interface TelegramWebhookDispatchInput {
  config: TelegramWebhookConfig;
  update: TelegramUpdate;
  baseConfig: TelegramConfig;
  tokenResolver?: (secretRef: string) => string;
  telegram?: TelegramApi;
  backend?: BackendClient;
  options?: HandlerOptions;
}

export function resolveSecretRefFromEnv(secretRef: string, env: NodeJS.ProcessEnv = process.env): string {
  if (secretRef.startsWith("env:")) {
    const key = secretRef.slice("env:".length);
    return env[key] || "";
  }
  return env[secretRef] || "";
}

export async function dispatchTelegramWebhookUpdate(input: TelegramWebhookDispatchInput): Promise<void> {
  const botToken = input.tokenResolver ? input.tokenResolver(input.config.tokenSecretRef) : resolveSecretRefFromEnv(input.config.tokenSecretRef);
  if (!botToken && !input.telegram) throw new Error("Telegram bot token secret could not be resolved");

  const scopedConfig: TelegramConfig = {
    ...input.baseConfig,
    botToken: botToken || input.baseConfig.botToken,
    telegramBotConfigId: input.config.id,
    merchantId: input.config.merchantId,
    storeId: input.config.defaultStoreId || input.baseConfig.storeId || "",
    runtimeMode: "webhook",
  };
  const telegram = input.telegram || new TelegramApi(scopedConfig);
  const backend = input.backend || new BackendClient(scopedConfig);
  const sessions = new SessionStore(backend);
  await handleUpdate(input.update, telegram, backend, sessions, {
    mutationsEnabled: scopedConfig.mutationsEnabled,
    aiOrderingEnabled: scopedConfig.aiOrderingEnabled,
    merchantId: scopedConfig.merchantId,
    storeId: scopedConfig.storeId,
    ...input.options,
  });
}
