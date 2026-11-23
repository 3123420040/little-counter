import { resolveTelegramWebhookConfig } from "@medusa-snus/application";
import type { MedusaRequest, MedusaResponse } from "../../../../../lib/http-types";
import { body, headers, rateLimit, route } from "../../../../../lib/route-utils";

interface TelegramUpdate {
  update_id: number;
  [key: string]: unknown;
}

interface TelegramRuntime {
  loadConfig: (env?: NodeJS.ProcessEnv) => unknown;
  dispatchTelegramWebhookUpdate: (input: unknown) => Promise<void>;
}

let telegramRuntimePromise: Promise<TelegramRuntime> | null = null;

async function loadTelegramRuntime(): Promise<TelegramRuntime> {
  if (!telegramRuntimePromise) {
    telegramRuntimePromise = Promise.all([
      import("../../../../../../apps/telegram/src/config"),
      import("../../../../../../apps/telegram/src/dispatcher"),
    ]).then(([configModuleRaw, dispatcherModuleRaw]) => {
      const configModule = configModuleRaw as { loadConfig: TelegramRuntime["loadConfig"] };
      const dispatcherModule = dispatcherModuleRaw as {
        dispatchTelegramWebhookUpdate: TelegramRuntime["dispatchTelegramWebhookUpdate"];
      };
      return {
        loadConfig: configModule.loadConfig,
        dispatchTelegramWebhookUpdate: dispatcherModule.dispatchTelegramWebhookUpdate,
      };
    });
  }
  return telegramRuntimePromise;
}

function requestHeaderValue(reqHeaders: ReturnType<typeof headers>, name: string): string {
  const value = reqHeaders[name] || reqHeaders[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  await route(res, async () => {
    rateLimit(req, "default");
    const params = req.params as { configId?: string; pathSecret?: string };
    const requestHeaders = headers(req);
    const telegramSecretToken = requestHeaderValue(requestHeaders, "x-telegram-bot-api-secret-token");
    const config = await resolveTelegramWebhookConfig(params.configId || "", params.pathSecret || "", telegramSecretToken);
    const telegramRuntime = await loadTelegramRuntime();
    await telegramRuntime.dispatchTelegramWebhookUpdate({
      config,
      update: body<TelegramUpdate>(req),
      baseConfig: telegramRuntime.loadConfig({ ...process.env, TELEGRAM_ENABLED: "true", TELEGRAM_RUNTIME_MODE: "webhook" }),
    });
    return { data: { accepted: true, configId: config.id, merchantId: config.merchantId } };
  });
}
