import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BackendClient } from "./backend-client";
import { loadConfig, type TelegramConfig } from "./config";
import { handleUpdate, type HandlerOptions } from "./handlers";
import { SessionStore } from "./session-store";
import { TelegramApi, type TelegramUpdate } from "./telegram-api";

interface RuntimeLogger {
  log?: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface PollingLeaseRecord {
  holderId: string;
  mode: "polling";
  acquiredAt: string;
  expiresAt: string;
}

function writeHeartbeat(file: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, new Date().toISOString());
  } catch (error) {
    console.error("Telegram heartbeat write failed:", error);
  }
}

function readLease(file: string): PollingLeaseRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PollingLeaseRecord;
    return parsed?.mode === "polling" && parsed.holderId ? parsed : null;
  } catch {
    return null;
  }
}

function leaseHolderId(): string {
  return process.env.TELEGRAM_POLLING_LEASE_HOLDER_ID || `poller-${process.pid}`;
}

function leaseExpired(record: PollingLeaseRecord): boolean {
  const expiresAt = Date.parse(record.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

export async function acquirePollingLease(file: string, ttlSeconds: number, holderId = leaseHolderId()): Promise<PollingLeaseRecord> {
  mkdirSync(dirname(file), { recursive: true });
  const existing = readLease(file);
  if (existing && !leaseExpired(existing) && existing.holderId !== holderId) {
    throw new Error(`Telegram polling lease already held by ${existing.holderId}. Set TELEGRAM_RUNTIME_MODE=polling for exactly one local process or use webhook mode.`);
  }
  const record: PollingLeaseRecord = {
    holderId,
    mode: "polling",
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
  writeFileSync(file, JSON.stringify(record));
  return record;
}

export async function renewPollingLease(file: string, ttlSeconds: number, holderId = leaseHolderId()): Promise<PollingLeaseRecord> {
  const existing = readLease(file);
  if (!existing || existing.holderId !== holderId || leaseExpired(existing)) {
    return acquirePollingLease(file, ttlSeconds, holderId);
  }
  const record: PollingLeaseRecord = { ...existing, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  writeFileSync(file, JSON.stringify(record));
  return record;
}

export async function dispatchPendingNotifications(
  telegram: Pick<TelegramApi, "sendMessage">,
  backend: Pick<BackendClient, "claimNotifications" | "markNotificationSent" | "markNotificationFailed">,
): Promise<void> {
  const notifications = await backend.claimNotifications(10);
  for (const notification of notifications.data) {
    try {
      await telegram.sendMessage(notification.telegramUserId, notification.text);
      await backend.markNotificationSent(notification.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Telegram dispatch failed";
      await backend.markNotificationFailed(notification.id, message);
    }
  }
}

export async function dispatchPendingNotificationsSafely(
  telegram: Pick<TelegramApi, "sendMessage">,
  backend: Pick<BackendClient, "claimNotifications" | "markNotificationSent" | "markNotificationFailed">,
  logger: RuntimeLogger = console,
): Promise<void> {
  try {
    await dispatchPendingNotifications(telegram, backend);
  } catch (error) {
    logger.error("Telegram notification dispatch failed:", error);
  }
}

export async function pollTelegramUpdatesSafely(
  telegram: Pick<TelegramApi, "getUpdates">,
  offset: number | undefined,
  timeout: number,
  logger: RuntimeLogger = console,
): Promise<{ updates: TelegramUpdate[]; offset: number | undefined }> {
  try {
    return {
      updates: await telegram.getUpdates(offset, timeout),
      offset,
    };
  } catch (error) {
    logger.error("Telegram update polling failed:", error);
    return { updates: [], offset };
  }
}

export async function processTelegramUpdates(
  updates: TelegramUpdate[],
  offset: number | undefined,
  telegram: TelegramApi,
  backend: BackendClient,
  sessions: SessionStore,
  options: HandlerOptions,
  logger: RuntimeLogger = console,
): Promise<number | undefined> {
  let nextOffset = offset;
  for (const update of updates) {
    nextOffset = update.update_id + 1;
    try {
      logger.log?.("Telegram update received:", describeUpdate(update));
      await handleUpdate(update, telegram, backend, sessions, options);
    } catch (error) {
      logger.error("Telegram update handling failed:", error);
    }
  }
  return nextOffset;
}

function describeUpdate(update: TelegramUpdate): string {
  const message = update.message;
  if (message) {
    const text = message.text?.trim() || "";
    const command = text.startsWith("/") ? text.split(/\s+/)[0] : text ? "text" : "message";
    return `updateId=${update.update_id} type=message chatId=${message.chat.id} userId=${message.from?.id || ""} command=${command}`;
  }

  const callback = update.callback_query;
  if (callback) {
    const action = callback.data?.split(":")[0] || "callback";
    return `updateId=${update.update_id} type=callback userId=${callback.from?.id || ""} action=${action}`;
  }

  return `updateId=${update.update_id} type=unknown`;
}

export async function startPolling(config: TelegramConfig, telegram = new TelegramApi(config), backend = new BackendClient(config)): Promise<void> {
  if (!config.enabled) {
    console.log("Telegram adapter disabled by TELEGRAM_ENABLED=false");
    return;
  }
  if (config.runtimeMode !== "polling") {
    console.log("Telegram adapter is not polling because TELEGRAM_RUNTIME_MODE is webhook");
    return;
  }

  await acquirePollingLease(config.pollingLeaseFile, config.pollingLeaseTtlSeconds);
  const sessions = new SessionStore(backend);
  let offset: number | undefined;

  console.log("Telegram adapter polling started");
  writeHeartbeat(config.heartbeatFile);
  setInterval(() => writeHeartbeat(config.heartbeatFile), 15_000);
  for (;;) {
    const polled = await pollTelegramUpdatesSafely(telegram, offset, config.pollTimeoutSeconds);
    offset = polled.offset;
    writeHeartbeat(config.heartbeatFile);
    await renewPollingLease(config.pollingLeaseFile, config.pollingLeaseTtlSeconds);
    await dispatchPendingNotificationsSafely(telegram, backend);
    offset = await processTelegramUpdates(
      polled.updates,
      offset,
      telegram,
      backend,
      sessions,
      {
        mutationsEnabled: config.mutationsEnabled,
        aiOrderingEnabled: config.aiOrderingEnabled,
        merchantId: config.merchantId,
        storeId: config.storeId,
      },
    );
  }
}

export async function start() {
  const config = loadConfig();
  await startPolling(config);
}

if (process.argv[1]?.endsWith("/index.ts") || process.argv[1]?.endsWith("/index.js")) {
  start().catch((error) => {
    console.error("Telegram adapter failed:", error);
    process.exit(1);
  });
}
