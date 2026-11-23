import { createHash, timingSafeEqual } from "node:crypto";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";

export interface TelegramBotConfigReadModel {
  id: string;
  merchantId: string;
  tokenSecretRef: string;
  defaultStoreId: string | null;
  status: "active" | "disabled" | "revoked";
  allowedCommands: string[];
  health: Record<string, unknown>;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedTelegramBotConfig extends TelegramBotConfigReadModel {
  webhookPathSecretHash: string;
  telegramSecretTokenHash: string;
}

export interface UpsertTelegramBotConfigInput {
  id: string;
  merchantId: string;
  tokenSecretRef: string;
  webhookPathSecret: string;
  telegramSecretToken: string;
  defaultStoreId?: string | null;
  status?: "active" | "disabled" | "revoked";
  allowedCommands?: string[];
  health?: Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualHash(leftHash: string, rightHash: string): boolean {
  const left = Buffer.from(leftHash, "hex");
  const right = Buffer.from(rightHash, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function mapReadModel(row: {
  id: string;
  merchant_id: string;
  token_secret_ref: string;
  default_store_id: string | null;
  status: "active" | "disabled" | "revoked";
  allowed_commands: unknown;
  health: Record<string, unknown> | null;
  last_heartbeat_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): TelegramBotConfigReadModel {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    tokenSecretRef: row.token_secret_ref,
    defaultStoreId: row.default_store_id,
    status: row.status,
    allowedCommands: asStringArray(row.allowed_commands),
    health: row.health || {},
    lastHeartbeatAt: row.last_heartbeat_at ? new Date(String(row.last_heartbeat_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function getTelegramBotConfigReadModel(id: string): Promise<{ data: TelegramBotConfigReadModel }> {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const row = await queryOne<any>(client, `
      SELECT id, merchant_id, token_secret_ref, default_store_id, status,
        allowed_commands, health, last_heartbeat_at, created_at, updated_at
      FROM app.telegram_bot_configs
      WHERE id = $1
      LIMIT 1
    `, [id]);
    if (!row) throw new PlatformError("telegram_bot_config_not_found", "Telegram bot config not found", 404);
    return { data: mapReadModel(row) };
  });
}

export async function upsertTelegramBotConfig(input: UpsertTelegramBotConfigInput): Promise<{ data: TelegramBotConfigReadModel }> {
  if (!input.id.trim()) throw new PlatformError("validation_error", "Telegram bot config id is required", 400);
  if (!input.merchantId.trim()) throw new PlatformError("validation_error", "merchantId is required", 400);
  if (!input.tokenSecretRef.trim()) throw new PlatformError("validation_error", "tokenSecretRef is required", 400);
  if (!input.webhookPathSecret.trim()) throw new PlatformError("validation_error", "webhookPathSecret is required", 400);
  if (!input.telegramSecretToken.trim()) throw new PlatformError("validation_error", "telegramSecretToken is required", 400);

  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const result = await client.query(`
      INSERT INTO app.telegram_bot_configs (
        id, merchant_id, token_secret_ref, webhook_path_secret_hash,
        telegram_secret_token_hash, default_store_id, status, allowed_commands, health
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        merchant_id = EXCLUDED.merchant_id,
        token_secret_ref = EXCLUDED.token_secret_ref,
        webhook_path_secret_hash = EXCLUDED.webhook_path_secret_hash,
        telegram_secret_token_hash = EXCLUDED.telegram_secret_token_hash,
        default_store_id = EXCLUDED.default_store_id,
        status = EXCLUDED.status,
        allowed_commands = EXCLUDED.allowed_commands,
        health = EXCLUDED.health,
        updated_at = now()
      RETURNING id, merchant_id, token_secret_ref, default_store_id, status,
        allowed_commands, health, last_heartbeat_at, created_at, updated_at
    `, [
      input.id,
      input.merchantId,
      input.tokenSecretRef,
      sha256(input.webhookPathSecret),
      sha256(input.telegramSecretToken),
      input.defaultStoreId || null,
      input.status || "active",
      JSON.stringify(input.allowedCommands || []),
      JSON.stringify(input.health || {}),
    ]);
    return { data: mapReadModel(result.rows[0]) };
  });
}

export async function resolveTelegramWebhookConfig(configId: string, pathSecret: string, telegramSecretToken: string): Promise<ResolvedTelegramBotConfig> {
  if (!configId || !pathSecret || !telegramSecretToken) {
    throw new PlatformError("telegram_webhook_unauthorized", "Telegram webhook is not authorized", 401);
  }

  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const row = await queryOne<any>(client, `
      SELECT id, merchant_id, token_secret_ref, webhook_path_secret_hash,
        telegram_secret_token_hash, default_store_id, status, allowed_commands,
        health, last_heartbeat_at, created_at, updated_at
      FROM app.telegram_bot_configs
      WHERE id = $1
      LIMIT 1
    `, [configId]);
    if (!row || row.status !== "active") {
      throw new PlatformError("telegram_webhook_unauthorized", "Telegram webhook is not authorized", 401);
    }

    const pathMatches = safeEqualHash(row.webhook_path_secret_hash, sha256(pathSecret));
    const tokenMatches = safeEqualHash(row.telegram_secret_token_hash, sha256(telegramSecretToken));
    if (!pathMatches || !tokenMatches) {
      throw new PlatformError("telegram_webhook_unauthorized", "Telegram webhook is not authorized", 401);
    }

    return {
      ...mapReadModel(row),
      webhookPathSecretHash: row.webhook_path_secret_hash,
      telegramSecretTokenHash: row.telegram_secret_token_hash,
    };
  });
}

export async function markTelegramBotHeartbeat(configId: string, health: Record<string, unknown> = {}): Promise<void> {
  await ensurePlatformSchema();
  await withConnectedClient(async (client) => {
    await client.query(`
      UPDATE app.telegram_bot_configs
      SET health = $2::jsonb, last_heartbeat_at = now(), updated_at = now()
      WHERE id = $1
    `, [configId, JSON.stringify(health)]);
  });
}
