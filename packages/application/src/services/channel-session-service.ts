import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { resolveChannelActor, type ChannelActor } from "./channel-auth-service";

export interface ChannelSessionInput {
  state?: Record<string, unknown>;
  expiresAt?: string | null;
}

function normalizeState(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformError("validation_error", "Session state must be an object", 400);
  }
  return value as Record<string, unknown>;
}

function normalizeExpiresAt(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new PlatformError("validation_error", "expiresAt must be an ISO timestamp", 400);
  }
  return new Date(timestamp).toISOString();
}

export function normalizeChannelSessionInput(input: ChannelSessionInput = {}): Required<ChannelSessionInput> {
  return {
    state: normalizeState(input.state),
    expiresAt: normalizeExpiresAt(input.expiresAt),
  };
}

interface SessionRow extends Record<string, unknown> {
  state: Record<string, unknown>;
  expires_at: Date | string | null;
  updated_at: Date | string;
  store_id: string | null;
  merchant_id: string | null;
}

function shapeSession(actor: ChannelActor, row: SessionRow | null, options: { stale?: boolean } = {}) {
  if (options.stale) {
    return {
      data: {
        channel: actor.channel,
        channelUserId: actor.channelUserId,
        operatorId: actor.operatorId,
        merchantId: actor.merchantId || null,
        storeId: row?.store_id || null,
        state: {},
        expiresAt: null,
        updatedAt: null,
      },
    };
  }
  return {
    data: {
      channel: actor.channel,
      channelUserId: actor.channelUserId,
      operatorId: actor.operatorId,
      merchantId: actor.merchantId || null,
      storeId: row?.store_id || null,
      state: row?.state || {},
      expiresAt: row?.expires_at || null,
      updatedAt: row?.updated_at || null,
    },
  };
}

export async function getChannelSession(headers: HeadersLike) {
  const actor = await resolveChannelActor(headers);
  await ensurePlatformSchema();

  return withConnectedClient(async (client) => {
    const session = await queryOne<SessionRow>(client, `
      SELECT state, expires_at, updated_at, store_id, merchant_id
      FROM app.bot_sessions
      WHERE organization_id = $1
        AND provider = $2
        AND provider_user_id = $3
        AND ($4::text IS NULL OR merchant_id = $4::text)
      LIMIT 1
    `, [actor.organizationId, actor.channel, actor.channelUserId, actor.merchantId || null]);

    if (session?.expires_at && new Date(String(session.expires_at)).getTime() <= Date.now()) {
      await client.query(`
        DELETE FROM app.bot_sessions
        WHERE organization_id = $1 AND provider = $2 AND provider_user_id = $3
          AND ($4::text IS NULL OR merchant_id = $4::text)
      `, [actor.organizationId, actor.channel, actor.channelUserId, actor.merchantId || null]);
      return shapeSession(actor, null, { stale: true });
    }

    return shapeSession(actor, session);
  });
}

export async function updateChannelSession(headers: HeadersLike, input: ChannelSessionInput) {
  const actor = await resolveChannelActor(headers);
  const { state, expiresAt } = normalizeChannelSessionInput(input);
  await ensurePlatformSchema();

  return withConnectedClient(async (client) => {
    const params = [
      actor.organizationId,
      actor.merchantId || null,
      typeof state.storeId === "string" ? state.storeId : null,
      actor.channel,
      actor.channelUserId,
      actor.operatorId,
      JSON.stringify(state),
      expiresAt,
    ];
    const updateResult = await client.query(`
      UPDATE app.bot_sessions
      SET store_id = COALESCE($3::text, store_id),
        operator_id = $6,
        state = $7::jsonb,
        expires_at = $8::timestamptz,
        updated_at = now()
      WHERE organization_id = $1
        AND provider = $4
        AND provider_user_id = $5
        AND (($2::text IS NULL AND merchant_id IS NULL) OR merchant_id = $2::text)
      RETURNING state, expires_at, updated_at, store_id, merchant_id
    `, params);
    const result = (updateResult.rowCount || 0) > 0 ? updateResult : await client.query(`
      INSERT INTO app.bot_sessions (
        organization_id, merchant_id, store_id, provider, provider_user_id, operator_id, state, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
      RETURNING state, expires_at, updated_at, store_id, merchant_id
    `, params);

    const row = result.rows[0] as SessionRow;
    return shapeSession(actor, row);
  });
}

export async function clearChannelSession(headers: HeadersLike) {
  const actor = await resolveChannelActor(headers);
  await ensurePlatformSchema();

  return withConnectedClient(async (connectedClient) => {
    await connectedClient.query(`
      DELETE FROM app.bot_sessions
      WHERE organization_id = $1 AND provider = $2 AND provider_user_id = $3
        AND ($4::text IS NULL OR merchant_id = $4::text)
    `, [actor.organizationId, actor.channel, actor.channelUserId, actor.merchantId || null]);

    return {
      data: {
        channel: actor.channel,
        channelUserId: actor.channelUserId,
        operatorId: actor.operatorId,
        merchantId: actor.merchantId || null,
        cleared: true,
      },
    };
  });
}
