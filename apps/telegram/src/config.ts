export interface TelegramConfig {
  enabled: boolean;
  runtimeMode: "polling" | "webhook";
  mutationsEnabled: boolean;
  aiOrderingEnabled: boolean;
  botToken: string;
  telegramBotConfigId: string;
  merchantId: string;
  storeId: string;
  backendBaseUrl: string;
  backendApiPrefix: string;
  serviceToken: string;
  serviceId: string;
  pollTimeoutSeconds: number;
  heartbeatFile: string;
  pollingLeaseFile: string;
  pollingLeaseTtlSeconds: number;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when TELEGRAM_ENABLED=true`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const enabled = env.TELEGRAM_ENABLED === "true";
  return {
    enabled,
    runtimeMode: env.TELEGRAM_RUNTIME_MODE === "webhook" ? "webhook" : "polling",
    mutationsEnabled: env.TELEGRAM_MUTATIONS_ENABLED !== "false",
    aiOrderingEnabled: env.TELEGRAM_AI_ORDERING_ENABLED === "true",
    botToken: enabled ? required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN") : env.TELEGRAM_BOT_TOKEN || "",
    telegramBotConfigId: env.TELEGRAM_BOT_CONFIG_ID || "",
    merchantId: env.TELEGRAM_MERCHANT_ID || "",
    storeId: env.TELEGRAM_STORE_ID || "",
    backendBaseUrl: (env.BACKEND_BASE_URL || "http://localhost:8080").replace(/\/+$/, ""),
    backendApiPrefix: normalizeApiPrefix(env.BACKEND_API_PREFIX ?? "/api"),
    serviceToken: enabled ? required(env.TELEGRAM_SERVICE_TOKEN, "TELEGRAM_SERVICE_TOKEN") : env.TELEGRAM_SERVICE_TOKEN || "",
    serviceId: env.TELEGRAM_SERVICE_ID || "telegram",
    pollTimeoutSeconds: Math.max(5, Number(env.TELEGRAM_POLL_TIMEOUT_SECONDS || 25)),
    heartbeatFile: env.TELEGRAM_HEARTBEAT_FILE || "/tmp/telegram-adapter.heartbeat",
    pollingLeaseFile: env.TELEGRAM_POLLING_LEASE_FILE || "/tmp/telegram-adapter.polling.lease.json",
    pollingLeaseTtlSeconds: Math.max(30, Number(env.TELEGRAM_POLLING_LEASE_TTL_SECONDS || 90)),
  };
}

function normalizeApiPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}
