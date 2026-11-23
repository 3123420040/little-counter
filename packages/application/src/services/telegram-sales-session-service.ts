import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import { authenticateChannelServiceHeaders } from "./channel-auth-service";
import { normalizeChannelSessionInput, type ChannelSessionInput } from "./channel-session-service";

interface TelegramSalesSessionContext {
  channel: "telegram";
  channelUserId: string;
  serviceIdentity: string;
  merchantId: string;
  storeId: string;
  organizationId: string;
  telegramBotConfigId?: string;
  requestId?: string;
}

interface SessionRow extends Record<string, unknown> {
  state: Record<string, unknown>;
  expires_at: Date | string | null;
  updated_at: Date | string;
  merchant_id: string | null;
  store_id: string | null;
}

async function resolveTelegramSalesSessionContext(headers: HeadersLike): Promise<TelegramSalesSessionContext> {
  const service = authenticateChannelServiceHeaders(headers);
  const requestedStoreId = headerValue(headers, "x-store-id") || headerValue(headers, "x-operating-store-id");

  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    let merchantId = service.merchantId || "";
    let configStoreId: string | null = null;
    if (!merchantId && service.telegramBotConfigId) {
      const config = await queryOne<{ merchant_id: string; default_store_id: string | null }>(client, `
        SELECT merchant_id, default_store_id
        FROM app.telegram_bot_configs
        WHERE id = $1 AND status = 'active'
        LIMIT 1
      `, [service.telegramBotConfigId]);
      if (!config) throw new PlatformError("telegram_bot_config_not_found", "Telegram bot config not found", 403);
      merchantId = config.merchant_id;
      configStoreId = config.default_store_id;
    }
    if (!merchantId) throw new PlatformError("scope_required", "Telegram sales session requires merchant scope", 409);

    const merchant = await queryOne<{ legacy_organization_id: string }>(client, `
      SELECT legacy_organization_id
      FROM app.merchants
      WHERE id = $1 AND status = 'active'
      LIMIT 1
    `, [merchantId]);
    if (!merchant) throw new PlatformError("merchant_not_found", "Merchant not found for Telegram sales session", 403);

    const targetStoreId = requestedStoreId || configStoreId || null;
    const store = await queryOne<{ id: string }>(client, `
      SELECT id
      FROM app.stores
      WHERE merchant_id = $1
        AND status = 'active'
        AND ($2::text IS NULL OR id = $2::text)
      ORDER BY CASE WHEN id = $2::text THEN 0 WHEN is_primary THEN 1 ELSE 2 END, display_name ASC
      LIMIT 1
    `, [merchantId, targetStoreId]);
    if (!store) throw new PlatformError("scope_required", "Telegram sales session requires an active store", 409);

    return {
      channel: service.channel,
      channelUserId: service.channelUserId,
      serviceIdentity: service.serviceIdentity,
      merchantId,
      storeId: store.id,
      organizationId: merchant.legacy_organization_id,
      telegramBotConfigId: service.telegramBotConfigId,
      requestId: service.requestId,
    };
  });
}

function shapeSession(ctx: TelegramSalesSessionContext, row: SessionRow | null, options: { stale?: boolean } = {}) {
  return {
    data: {
      channel: ctx.channel,
      channelUserId: ctx.channelUserId,
      actorType: "telegram_customer" as const,
      merchantId: ctx.merchantId,
      storeId: row?.store_id || ctx.storeId,
      state: options.stale ? {} : row?.state || {},
      expiresAt: options.stale ? null : row?.expires_at || null,
      updatedAt: options.stale ? null : row?.updated_at || null,
    },
  };
}

export async function getTelegramSalesSession(headers: HeadersLike) {
  const ctx = await resolveTelegramSalesSessionContext(headers);

  return withConnectedClient(async (client) => {
    const session = await queryOne<SessionRow>(client, `
      SELECT state, expires_at, updated_at, merchant_id, store_id
      FROM app.bot_sessions
      WHERE organization_id = $1
        AND merchant_id = $2
        AND provider = $3
        AND provider_user_id = $4
      LIMIT 1
    `, [ctx.organizationId, ctx.merchantId, ctx.channel, ctx.channelUserId]);

    if (session?.expires_at && new Date(String(session.expires_at)).getTime() <= Date.now()) {
      await client.query(`
        DELETE FROM app.bot_sessions
        WHERE organization_id = $1
          AND merchant_id = $2
          AND provider = $3
          AND provider_user_id = $4
      `, [ctx.organizationId, ctx.merchantId, ctx.channel, ctx.channelUserId]);
      return shapeSession(ctx, null, { stale: true });
    }

    return shapeSession(ctx, session);
  });
}

export async function updateTelegramSalesSession(headers: HeadersLike, input: ChannelSessionInput) {
  const ctx = await resolveTelegramSalesSessionContext(headers);
  const { state, expiresAt } = normalizeChannelSessionInput(input);

  return withConnectedClient(async (client) => {
    const params = [
      ctx.organizationId,
      ctx.merchantId,
      ctx.storeId,
      ctx.channel,
      ctx.channelUserId,
      JSON.stringify(state),
      expiresAt,
    ];
    const updateResult = await client.query(`
      UPDATE app.bot_sessions
      SET store_id = $3,
          operator_id = NULL,
          state = $6::jsonb,
          expires_at = $7::timestamptz,
          updated_at = now()
      WHERE organization_id = $1
        AND merchant_id = $2
        AND provider = $4
        AND provider_user_id = $5
      RETURNING state, expires_at, updated_at, merchant_id, store_id
    `, params);
    const result = (updateResult.rowCount || 0) > 0 ? updateResult : await client.query(`
      INSERT INTO app.bot_sessions (
        organization_id, merchant_id, store_id, provider, provider_user_id, operator_id, state, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, $7::timestamptz)
      RETURNING state, expires_at, updated_at, merchant_id, store_id
    `, params);

    return shapeSession(ctx, result.rows[0] as SessionRow);
  });
}

export async function clearTelegramSalesSession(headers: HeadersLike) {
  const ctx = await resolveTelegramSalesSessionContext(headers);

  return withConnectedClient(async (client) => {
    await client.query(`
      DELETE FROM app.bot_sessions
      WHERE organization_id = $1
        AND merchant_id = $2
        AND provider = $3
        AND provider_user_id = $4
    `, [ctx.organizationId, ctx.merchantId, ctx.channel, ctx.channelUserId]);

    return {
      data: {
        channel: ctx.channel,
        channelUserId: ctx.channelUserId,
        actorType: "telegram_customer" as const,
        merchantId: ctx.merchantId,
        storeId: ctx.storeId,
        cleared: true,
      },
    };
  });
}
