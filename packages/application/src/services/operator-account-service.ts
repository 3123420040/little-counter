import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "../db/client";
import { queryOne } from "../db/query";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedTransaction } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import { hashPassword, signJwt, verifyPassword } from "../middleware/auth";
import { recordAuditEntry } from "../repositories/audit-repository";
import type { OperatorContext } from "./auth-service";
import type { ChannelServiceContext } from "./channel-auth-service";
import {
  assertOperatorCanUseChannel,
  assertTemporaryPasswordAllowsLogin,
  ensureOperatorSecurityState,
  loadOperatorSecurityState,
} from "./operator-security-service";

type ProfileInput = {
  displayName?: string;
  email?: string | null;
  phoneE164?: string | null;
  locale?: string | null;
  metadata?: Record<string, unknown>;
};

type PasswordChangeInput = {
  currentPassword?: string;
  newPassword?: string;
};

type RequiredPasswordChangeInput = {
  newPassword?: string;
};

function cleanNullableText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new PlatformError("validation_error", `Value must be at most ${maxLength} characters`, 400);
  }
  return text;
}

function cleanDisplayName(value: unknown): string | null {
  if (value === undefined) return null;
  const text = String(value).trim();
  if (text.length < 2 || text.length > 120) {
    throw new PlatformError("validation_error", "Display name must be 2-120 characters", 400);
  }
  return text;
}

function normalizedEmail(email: string | null): string | null {
  return email ? email.toLowerCase() : null;
}

export function validateOperatorPassword(password: unknown): string {
  const value = typeof password === "string" ? password : "";
  if (value.length < 8 || value.length > 128) {
    throw new PlatformError(
      "password_policy_violation",
      "Password does not meet the required policy",
      400,
      { minLength: 8, maxLength: 128, rule: "length" },
    );
  }
  if (/^\s|\s$/.test(value)) {
    throw new PlatformError(
      "password_policy_violation",
      "Password does not meet the required policy",
      400,
      { minLength: 8, maxLength: 128, rule: "edge_whitespace" },
    );
  }
  return value;
}

async function loadStaffUser(client: PoolClient, operatorId: string) {
  const user = await queryOne<{
    operator_id: string;
    password_hash: string;
    display_name: string;
    role: "staff" | "manager" | "accountant" | "owner";
    organization_id: string;
    is_active: boolean;
  }>(client, `
    SELECT operator_id, password_hash, display_name, role, organization_id, is_active
    FROM medusa.staff_users
    WHERE operator_id = $1
    LIMIT 1
  `, [operatorId]);
  if (!user || !user.is_active) {
    throw new PlatformError("unauthorized", "Operator is inactive", 401);
  }
  return user;
}

async function ensureProfileRow(client: PoolClient, operatorId: string): Promise<void> {
  await client.query(`
    INSERT INTO app.operator_profiles (operator_id)
    VALUES ($1)
    ON CONFLICT (operator_id) DO NOTHING
  `, [operatorId]);
}

function authTokenFor(user: Awaited<ReturnType<typeof loadStaffUser>>, sessionVersion: number) {
  return signJwt({
    operatorId: user.operator_id,
    role: user.role,
    displayName: user.display_name,
    organizationId: user.organization_id,
    sessionVersion,
    authState: "authenticated",
  });
}

export async function updateOwnOperatorProfile(
  actor: OperatorContext,
  input: ProfileInput,
): Promise<{ data: { operatorId: string; displayName: string; profile: { email: string | null; phoneE164: string | null; locale: string | null } } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const user = await loadStaffUser(client, actor.operatorId);
    await ensureProfileRow(client, actor.operatorId);
    const displayName = cleanDisplayName(input.displayName);
    const email = cleanNullableText(input.email, 320);
    const phoneE164 = cleanNullableText(input.phoneE164, 32);
    const locale = cleanNullableText(input.locale, 32);
    const metadata = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : undefined;

    if (displayName) {
      await client.query(`
        UPDATE medusa.staff_users
        SET display_name = $2
        WHERE operator_id = $1
      `, [actor.operatorId, displayName]);
      user.display_name = displayName;
    }

    await client.query(`
      UPDATE app.operator_profiles
      SET email = CASE WHEN $7::boolean THEN $2 ELSE email END,
          normalized_email = CASE WHEN $7::boolean THEN $3 ELSE normalized_email END,
          phone_e164 = CASE WHEN $8::boolean THEN $4 ELSE phone_e164 END,
          locale = CASE WHEN $9::boolean THEN $5 ELSE locale END,
          metadata = CASE WHEN $6::jsonb IS NULL THEN metadata ELSE $6::jsonb END,
          updated_at = now()
      WHERE operator_id = $1
    `, [
      actor.operatorId,
      input.email === undefined ? null : email,
      input.email === undefined ? null : normalizedEmail(email),
      input.phoneE164 === undefined ? null : phoneE164,
      input.locale === undefined ? null : locale,
      metadata === undefined ? null : JSON.stringify(metadata),
      input.email !== undefined,
      input.phoneE164 !== undefined,
      input.locale !== undefined,
    ]);

    const profile = await queryOne<{ email: string | null; phone_e164: string | null; locale: string | null }>(client, `
      SELECT email, phone_e164, locale
      FROM app.operator_profiles
      WHERE operator_id = $1
    `, [actor.operatorId]);

    await recordAuditEntry(client, actor, "operator.profile.updated", "operator", actor.operatorId, {
      after: { displayName: user.display_name, profile },
    });

    return {
      data: {
        operatorId: actor.operatorId,
        displayName: user.display_name,
        profile: {
          email: profile?.email ?? null,
          phoneE164: profile?.phone_e164 ?? null,
          locale: profile?.locale ?? null,
        },
      },
    };
  });
}

export async function changeOwnOperatorPassword(
  actor: OperatorContext,
  input: PasswordChangeInput,
): Promise<{ data: { token: string } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const user = await loadStaffUser(client, actor.operatorId);
    const currentPassword = typeof input.currentPassword === "string" ? input.currentPassword : "";
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw new PlatformError("invalid_current_password", "Current password is incorrect", 400);
    }
    const newPassword = validateOperatorPassword(input.newPassword);
    const passwordHash = await hashPassword(newPassword);
    await client.query(`
      UPDATE medusa.staff_users
      SET password_hash = $2
      WHERE operator_id = $1
    `, [actor.operatorId, passwordHash]);
    await ensureOperatorSecurityState(client, actor.operatorId);
    const updated = await queryOne<{ session_version: number }>(client, `
      UPDATE app.operator_security_state
      SET requires_password_change = false,
          temporary_password_hash = NULL,
          temporary_password_expires_at = NULL,
          password_changed_at = now(),
          session_version = session_version + 1,
          updated_at = now()
      WHERE operator_id = $1
      RETURNING session_version
    `, [actor.operatorId]);
    const sessionVersion = Number(updated?.session_version || 1);
    await recordAuditEntry(client, actor, "operator.password.changed", "operator", actor.operatorId, {});
    return { data: { token: authTokenFor(user, sessionVersion) } };
  });
}

export async function completeRequiredOperatorPasswordChange(
  actor: OperatorContext,
  input: RequiredPasswordChangeInput,
): Promise<{ data: { token: string } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const user = await loadStaffUser(client, actor.operatorId);
    await ensureOperatorSecurityState(client, actor.operatorId);
    await client.query(`
      SELECT operator_id
      FROM app.operator_security_state
      WHERE operator_id = $1
      FOR UPDATE
    `, [actor.operatorId]);
    const security = await loadOperatorSecurityState(client, actor.operatorId);
    if (!security) {
      throw new PlatformError("security_state_missing", "Operator security state is missing", 500);
    }
    if (!security.requiresPasswordChange) {
      throw new PlatformError("password_change_not_required", "Password change is not required", 409);
    }
    assertTemporaryPasswordAllowsLogin(security);
    const newPassword = validateOperatorPassword(input.newPassword);
    const passwordHash = await hashPassword(newPassword);
    await client.query(`
      UPDATE medusa.staff_users
      SET password_hash = $2
      WHERE operator_id = $1
    `, [actor.operatorId, passwordHash]);
    const updated = await queryOne<{ session_version: number }>(client, `
      UPDATE app.operator_security_state
      SET requires_password_change = false,
          temporary_password_hash = NULL,
          temporary_password_expires_at = NULL,
          password_changed_at = now(),
          session_version = session_version + 1,
          updated_at = now()
      WHERE operator_id = $1
      RETURNING session_version
    `, [actor.operatorId]);
    const sessionVersion = Number(updated?.session_version || security.sessionVersion + 1);
    await recordAuditEntry(client, actor, "operator.password.required_change_completed", "operator", actor.operatorId, {});
    return { data: { token: authTokenFor(user, sessionVersion) } };
  });
}

export async function logoutAllOperatorSessions(actor: OperatorContext): Promise<{ data: { ok: true } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await ensureOperatorSecurityState(client, actor.operatorId);
    await client.query(`
      UPDATE app.operator_security_state
      SET session_version = session_version + 1,
          force_logout_after = now(),
          updated_at = now()
      WHERE operator_id = $1
    `, [actor.operatorId]);
    await recordAuditEntry(client, actor, "operator.sessions.logout_all", "operator", actor.operatorId, {});
    return { data: { ok: true } };
  });
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createOwnTelegramLinkToken(actor: OperatorContext): Promise<{ data: { token: string; expiresAt: string } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `operator-identity-link-token:${actor.operatorId}:telegram`,
    ]);
    await client.query(`
      UPDATE app.operator_identity_link_tokens
      SET expires_at = LEAST(expires_at, now())
      WHERE operator_id = $1
        AND provider = 'telegram'
        AND consumed_at IS NULL
        AND expires_at > now()
    `, [actor.operatorId]);
    const token = `tlg_${randomBytes(18).toString("base64url")}`;
    const row = await queryOne<{ expires_at: Date | string }>(client, `
      INSERT INTO app.operator_identity_link_tokens (operator_id, provider, token_hash, expires_at)
      VALUES ($1, 'telegram', $2, now() + INTERVAL '15 minutes')
      RETURNING expires_at
    `, [actor.operatorId, tokenHash(token)]);
    await recordAuditEntry(client, actor, "operator.telegram.link_token_created", "operator", actor.operatorId, {});
    return { data: { token, expiresAt: new Date(row!.expires_at).toISOString() } };
  });
}

export async function consumeOwnTelegramLinkToken(
  service: ChannelServiceContext,
  input: { token?: string; displayName?: string | null },
): Promise<{ data: { operatorId: string; linked: true } }> {
  await ensurePlatformSchema();
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!token) throw new PlatformError("validation_error", "Telegram link token is required", 400);
  if (service.channel !== "telegram") throw new PlatformError("unsupported_channel", "Only Telegram link tokens are supported", 400);

  return withConnectedTransaction(async (client) => {
    const link = await queryOne<{
      id: string;
      operator_id: string;
      display_name: string | null;
      organization_id: string;
      expires_at: Date | string;
      consumed_at: Date | null;
    }>(client, `
      SELECT t.id::text, t.operator_id, su.display_name, su.organization_id, t.expires_at, t.consumed_at
      FROM app.operator_identity_link_tokens t
      JOIN medusa.staff_users su ON su.operator_id = t.operator_id AND su.is_active = true
      WHERE t.provider = 'telegram'
        AND t.token_hash = $1
      LIMIT 1
    `, [tokenHash(token)]);
    if (!link || link.consumed_at || new Date(link.expires_at).getTime() <= Date.now()) {
      throw new PlatformError("invalid_link_token", "Telegram link token is invalid or expired", 400);
    }

    const security = await ensureOperatorSecurityState(client, link.operator_id);
    assertOperatorCanUseChannel(security);

    let organizationId = link.organization_id || "org_default";
    if (service.merchantId) {
      const membership = await queryOne<{ organization_id: string }>(client, `
        SELECT m.legacy_organization_id AS organization_id
        FROM app.operator_memberships om
        JOIN app.merchants m ON m.id = om.merchant_id
        WHERE om.operator_id = $1
          AND om.merchant_id = $2
          AND om.status = 'active'
          AND om.scope_type IN ('merchant', 'store')
          AND (om.valid_to IS NULL OR om.valid_to > now())
        LIMIT 1
      `, [link.operator_id, service.merchantId]);
      if (!membership) {
        throw new PlatformError("forbidden", "Operator is not active in this merchant", 403, { merchantId: service.merchantId });
      }
      organizationId = membership.organization_id || organizationId;
    }

    await client.query(`
      DELETE FROM app.operator_identities
      WHERE provider = 'telegram'
        AND (
          ($1::text IS NOT NULL AND merchant_id = $1 AND (provider_user_id = $2 OR operator_id = $3))
          OR ($1::text IS NULL AND organization_id = $4 AND merchant_id IS NULL AND (provider_user_id = $2 OR operator_id = $3))
        )
    `, [service.merchantId || null, service.channelUserId, link.operator_id, organizationId]);

    await client.query(`
      INSERT INTO app.operator_identities (
        organization_id, merchant_id, provider, provider_user_id, operator_id,
        display_name, audit_evidence, is_active, verified_at
      )
      VALUES ($1, $2, 'telegram', $3, $4, $5, $6::jsonb, true, now())
    `, [
      organizationId,
      service.merchantId || null,
      service.channelUserId,
      link.operator_id,
      cleanNullableText(input.displayName, 160) || link.display_name || link.operator_id,
      JSON.stringify({
        linkedBy: "operator_self_service_token",
        telegramBotConfigId: service.telegramBotConfigId || null,
      }),
    ]);

    await client.query(`
      UPDATE app.operator_identity_link_tokens
      SET consumed_at = now()
      WHERE id::text = $1
    `, [link.id]);

    await recordAuditEntry(client, {
      operatorId: link.operator_id,
      role: "system",
      organizationId,
      channel: "telegram",
      channelUserId: service.channelUserId,
      serviceIdentity: service.serviceIdentity,
      requestId: service.requestId,
    }, "operator.telegram.linked", "operator", link.operator_id, {
      after: {
        providerUserId: service.channelUserId,
        merchantId: service.merchantId || null,
      },
      merchantId: service.merchantId,
    });

    return { data: { operatorId: link.operator_id, linked: true } };
  });
}

export async function unlinkOwnTelegramIdentity(actor: OperatorContext): Promise<{ data: { ok: true } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await client.query(`
      UPDATE app.operator_identities
      SET is_active = false, updated_at = now()
      WHERE operator_id = $1 AND provider = 'telegram' AND is_active = true
    `, [actor.operatorId]);
    await recordAuditEntry(client, actor, "operator.telegram.unlinked", "operator", actor.operatorId, {});
    return { data: { ok: true } };
  });
}
