import { timingSafeEqual } from "node:crypto";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import { headerValue, type HeadersLike } from "../http/headers";
import type { PermissionId, RequestAccess } from "@medusa-snus/contracts";
import type { Role } from "../middleware/auth";
import { resolveRequestAccess } from "./access-service";
import { assertOperatorCanUseChannel, ensureOperatorSecurityState } from "./operator-security-service";

export type ChannelProvider = "telegram";

export interface ChannelServiceContext {
  channel: ChannelProvider;
  channelUserId: string;
  serviceIdentity: string;
  merchantId?: string;
  telegramBotConfigId?: string;
  requestId?: string;
}

export interface ChannelActor {
  operatorId: string;
  role: Role;
  displayName: string;
  organizationId: string;
  merchantId?: string;
  defaultStoreId?: string | null;
  channel: ChannelProvider;
  channelUserId: string;
  serviceIdentity: string;
  requestId?: string;
  permissions: PermissionId[];
  access?: RequestAccess;
}

function configuredServiceToken(): string {
  return process.env.TELEGRAM_SERVICE_TOKEN || process.env.CHANNEL_SERVICE_TOKEN || "";
}

function serviceIdentity(): string {
  return process.env.TELEGRAM_SERVICE_ID || "telegram";
}

function legacyOrganizationIdForMerchantId(merchantId: string | undefined): string {
  return merchantId ? "" : "org_default";
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(headers: HeadersLike): string {
  const auth = headerValue(headers, "authorization");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return headerValue(headers, "x-channel-service-token").trim();
}

export function authenticateChannelServiceHeaders(headers: HeadersLike): ChannelServiceContext {
  const service = authenticateChannelServiceOnlyHeaders(headers);
  const channelUserId = headerValue(headers, "x-channel-user-id");
  if (!channelUserId) throw new PlatformError("validation_error", "X-Channel-User-Id is required", 400);
  return { ...service, channelUserId };
}

export function authenticateChannelServiceOnlyHeaders(headers: HeadersLike): Omit<ChannelServiceContext, "channelUserId"> {
  const expected = configuredServiceToken();
  if (!expected) {
    throw new PlatformError("service_token_not_configured", "Channel service token is not configured", 503);
  }

  const token = bearerToken(headers);
  if (!token || !safeEqual(token, expected)) {
    throw new PlatformError("unauthorized", "Invalid channel service token", 401);
  }

  const channel = headerValue(headers, "x-channel");
  if (channel !== "telegram") throw new PlatformError("unsupported_channel", "Unsupported channel", 400);

  const requestId = headerValue(headers, "x-request-id") || undefined;
  const merchantId = headerValue(headers, "x-merchant-id") || undefined;
  const telegramBotConfigId = headerValue(headers, "x-telegram-bot-config-id") || undefined;
  return { channel, serviceIdentity: serviceIdentity(), merchantId, telegramBotConfigId, requestId };
}

async function resolveMerchantContext(client: any, service: ChannelServiceContext): Promise<{ merchantId?: string; organizationId: string }> {
  if (service.merchantId) {
    const merchant = await queryOne<{ legacy_organization_id: string }>(client, `
      SELECT legacy_organization_id
      FROM app.merchants
      WHERE id = $1 AND status = 'active'
      LIMIT 1
    `, [service.merchantId]);
    if (!merchant) throw new PlatformError("merchant_not_found", "Merchant not found for channel request", 403);
    return { merchantId: service.merchantId, organizationId: merchant.legacy_organization_id };
  }

  if (service.telegramBotConfigId) {
    const config = await queryOne<{ merchant_id: string; legacy_organization_id: string }>(client, `
      SELECT tbc.merchant_id, m.legacy_organization_id
      FROM app.telegram_bot_configs tbc
      JOIN app.merchants m ON m.id = tbc.merchant_id AND m.status = 'active'
      WHERE tbc.id = $1 AND tbc.status = 'active'
      LIMIT 1
    `, [service.telegramBotConfigId]);
    if (!config) throw new PlatformError("telegram_bot_config_not_found", "Telegram bot config not found", 403);
    return { merchantId: config.merchant_id, organizationId: config.legacy_organization_id };
  }

  return { organizationId: legacyOrganizationIdForMerchantId(undefined) };
}

export async function resolveChannelActor(headers: HeadersLike): Promise<ChannelActor> {
  const service = authenticateChannelServiceHeaders(headers);
  await ensurePlatformSchema();

  return withConnectedClient(async (client) => {
    const merchantContext = await resolveMerchantContext(client, service);
    const identity = await queryOne<{
      operator_id: string;
      display_name: string | null;
      default_store_id: string | null;
      role: Role;
      staff_display_name: string;
      organization_id: string;
    }>(client, `
      SELECT
        oi.operator_id,
        oi.display_name,
        oi.default_store_id,
        su.display_name AS staff_display_name,
        su.role,
        su.organization_id
      FROM app.operator_identities oi
      JOIN medusa.staff_users su ON su.operator_id = oi.operator_id AND su.is_active = true
      WHERE oi.organization_id = $3
        AND oi.provider = $1
        AND oi.provider_user_id = $2
        AND ($4::text IS NULL OR oi.merchant_id = $4::text)
        AND oi.is_active = true
      ORDER BY CASE WHEN oi.merchant_id = $4::text THEN 0 ELSE 1 END
      LIMIT 1
    `, [service.channel, service.channelUserId, merchantContext.organizationId, merchantContext.merchantId || null]);

    if (!identity) {
      throw new PlatformError("channel_identity_unmapped", "Channel user is not mapped to an operator", 403);
    }

    const security = await ensureOperatorSecurityState(client, identity.operator_id);
    assertOperatorCanUseChannel(security);

    const actor: ChannelActor = {
      operatorId: identity.operator_id,
      role: identity.role,
      displayName: identity.display_name || identity.staff_display_name,
      organizationId: identity.organization_id,
      merchantId: merchantContext.merchantId,
      defaultStoreId: identity.default_store_id,
      channel: service.channel,
      channelUserId: service.channelUserId,
      serviceIdentity: service.serviceIdentity,
      requestId: service.requestId,
      permissions: [],
    };
    const access = await resolveRequestAccess(actor);
    actor.access = access;
    actor.permissions = access.permissionIds;
    return actor;
  });
}

export function requireChannelPermission(actor: ChannelActor, permissionId: PermissionId): void {
  if (!actor.permissions.includes(permissionId)) {
    throw new PlatformError("forbidden", `Missing permission: ${permissionId}`, 403);
  }
}

export async function getChannelMe(headers: HeadersLike) {
  const actor = await resolveChannelActor(headers);
  return {
    data: {
      channel: actor.channel,
      channelUserId: actor.channelUserId,
      serviceIdentity: actor.serviceIdentity,
      requestId: actor.requestId,
      operator: {
        id: actor.operatorId,
        role: actor.role,
        displayName: actor.displayName,
        organizationId: actor.organizationId,
      },
      permissions: actor.permissions,
    },
  };
}
