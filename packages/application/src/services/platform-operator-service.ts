import { randomBytes } from "node:crypto";
import type { PermissionId } from "@medusa-snus/contracts";
import { permissions, permissionIds } from "@medusa-snus/contracts";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import { queryOne } from "../db/query";
import { PlatformError } from "../errors/platform-error";
import { hashPassword } from "../middleware/auth";
import { recordAuditEntry } from "../repositories/audit-repository";
import type { OperatorContext } from "./auth-service";
import { ensureOperatorSecurityState, temporaryPasswordExpiry } from "./operator-security-service";

const PLATFORM_OWNER_GRANTS: PermissionId[] = [
  permissions.platformOperatorRead,
  permissions.platformOperatorResetPassword,
  permissions.platformOperatorSuspend,
  permissions.platformMembershipWrite,
  permissions.platformImpersonationStart,
];
const PLATFORM_OWNER_GRANT_LOCK_KEY = "platform_owner_grant_protection:v1";

function temporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

function ensurePermissionId(value: unknown): PermissionId {
  if (permissionIds.includes(value as PermissionId)) return value as PermissionId;
  throw new PlatformError("validation_error", "Unknown permission", 400);
}

async function loadOperatorExists(client: { query: Function }, operatorId: string): Promise<void> {
  const row = await queryOne<{ operator_id: string }>(client as never, `
    SELECT operator_id FROM medusa.staff_users WHERE operator_id = $1 LIMIT 1
  `, [operatorId]);
  if (!row) throw new PlatformError("resource_not_found", "Operator not found", 404, { operatorId });
}

async function lockPlatformOwnerGrants(client: { query: Function }): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    PLATFORM_OWNER_GRANT_LOCK_KEY,
  ]);
}

export async function listPlatformOperators() {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const rows = await client.query(`
      SELECT
        su.operator_id AS "operatorId",
        su.display_name AS "displayName",
        su.role,
        su.organization_id AS "organizationId",
        su.is_active AS "isActive",
        su.last_login_at AS "lastLoginAt",
        p.email,
        p.phone_e164 AS "phoneE164",
        COALESCE(sec.requires_password_change, false) AS "requiresPasswordChange",
        COALESCE(sec.global_status, 'active') AS "globalStatus",
        COALESCE(sec.session_version, 1) AS "sessionVersion",
        COALESCE(m.memberships, '[]'::jsonb) AS memberships,
        COALESCE(g.grants, '[]'::jsonb) AS "explicitGrants"
      FROM medusa.staff_users su
      LEFT JOIN app.operator_profiles p ON p.operator_id = su.operator_id
      LEFT JOIN app.operator_security_state sec ON sec.operator_id = su.operator_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'membershipId', om.id::text,
          'scopeType', om.scope_type,
          'merchantId', om.merchant_id,
          'storeId', om.store_id,
          'roleKey', om.role_key,
          'status', om.status
        ) ORDER BY om.created_at DESC) AS memberships
        FROM app.operator_memberships om
        WHERE om.operator_id = su.operator_id
      ) m ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'grantId', g.id::text,
          'permissionId', g.permission_id,
          'scopeType', g.scope_type,
          'merchantId', g.merchant_id,
          'storeId', g.store_id,
          'status', g.status,
          'validFrom', g.valid_from,
          'validTo', g.valid_to
        ) ORDER BY g.created_at DESC) AS grants
        FROM app.operator_explicit_permission_grants g
        WHERE g.operator_id = su.operator_id
      ) g ON true
      ORDER BY su.display_name ASC, su.operator_id ASC
      LIMIT 500
    `);
    return { data: rows.rows };
  });
}

export async function resetPlatformOperatorPassword(
  operatorId: string,
  actor: OperatorContext,
  input?: { reason?: string },
): Promise<{ data: { operatorId: string; temporaryPassword: string; temporaryPasswordExpiresAt: string } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await loadOperatorExists(client, operatorId);
    const secret = temporaryPassword();
    const passwordHash = await hashPassword(secret);
    const passwordExpiresAt = temporaryPasswordExpiry();
    await client.query("UPDATE medusa.staff_users SET password_hash = $2 WHERE operator_id = $1", [operatorId, passwordHash]);
    await ensureOperatorSecurityState(client, operatorId);
    await client.query(`
      UPDATE app.operator_security_state
      SET requires_password_change = true,
          temporary_password_hash = $2,
          temporary_password_expires_at = $3,
          session_version = session_version + 1,
          force_logout_after = now(),
          updated_at = now()
      WHERE operator_id = $1
    `, [operatorId, passwordHash, passwordExpiresAt]);
    await recordAuditEntry(client, actor, "platform.operator.password_reset", "operator", operatorId, {
      reason: input?.reason,
    });
    return {
      data: {
        operatorId,
        temporaryPassword: secret,
        temporaryPasswordExpiresAt: passwordExpiresAt.toISOString(),
      },
    };
  });
}

export async function setPlatformOperatorSuspension(
  operatorId: string,
  actor: OperatorContext,
  suspended: boolean,
  input?: { reason?: string },
): Promise<{ data: { operatorId: string; globalStatus: "active" | "suspended" } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await loadOperatorExists(client, operatorId);
    await ensureOperatorSecurityState(client, operatorId);
    const globalStatus = suspended ? "suspended" : "active";
    await client.query(`
      UPDATE app.operator_security_state
      SET global_status = $2,
          session_version = session_version + 1,
          force_logout_after = CASE WHEN $2 = 'suspended' THEN now() ELSE force_logout_after END,
          updated_at = now()
      WHERE operator_id = $1
    `, [operatorId, globalStatus]);
    await recordAuditEntry(client, actor, suspended ? "platform.operator.suspended" : "platform.operator.unsuspended", "operator", operatorId, {
      reason: input?.reason,
      after: { globalStatus },
    });
    return { data: { operatorId, globalStatus } };
  });
}

export async function grantPlatformOperatorPermission(
  operatorId: string,
  actor: OperatorContext,
  input: { permissionId?: string; reason?: string },
) {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await loadOperatorExists(client, operatorId);
    const permissionId = ensurePermissionId(input.permissionId);
    if (permissionId === permissions.platformImpersonationStart) {
      await lockPlatformOwnerGrants(client);
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `platform-operator-permission:${operatorId}:${permissionId}`,
    ]);
    const existingGrant = await queryOne<{ id: string }>(client, `
      SELECT id::text
      FROM app.operator_explicit_permission_grants
      WHERE operator_id = $1
        AND permission_id = $2
        AND scope_type = 'platform'
        AND merchant_id IS NULL
        AND store_id IS NULL
        AND status = 'active'
        AND valid_to IS NULL
      LIMIT 1
    `, [operatorId, permissionId]);
    const grant = existingGrant
      ? await queryOne<{ id: string }>(client, `
        UPDATE app.operator_explicit_permission_grants
        SET reason = $2,
            granted_by = $3,
            updated_at = now()
        WHERE id::text = $1
        RETURNING id::text
      `, [existingGrant.id, input.reason || "", actor.operatorId])
      : await queryOne<{ id: string }>(client, `
        INSERT INTO app.operator_explicit_permission_grants (
          operator_id, permission_id, scope_type, granted_by, reason
        )
        VALUES ($1, $2, 'platform', $3, $4)
        RETURNING id::text
      `, [operatorId, permissionId, actor.operatorId, input.reason || ""]);
    if (!grant) throw new PlatformError("permission_grant_failed", "Could not grant platform permission", 500);
    await ensureOperatorSecurityState(client, operatorId);
    await client.query(`
      UPDATE app.operator_security_state
      SET session_version = session_version + 1, updated_at = now()
      WHERE operator_id = $1
    `, [operatorId]);
    await recordAuditEntry(client, actor, "platform.operator.permission_granted", "operator", operatorId, {
      reason: input.reason,
      after: { grantId: grant?.id, permissionId },
    });
    return { data: { grantId: grant?.id, operatorId, permissionId } };
  });
}

async function assertNotLastPlatformOwnerGrant(client: { query: Function }, grantId: string): Promise<void> {
  const grant = await queryOne<{ operator_id: string; permission_id: PermissionId }>(client as never, `
    SELECT operator_id, permission_id
    FROM app.operator_explicit_permission_grants
    WHERE id::text = $1
      AND scope_type = 'platform'
      AND merchant_id IS NULL
      AND store_id IS NULL
      AND status = 'active'
      AND valid_from <= now()
      AND (valid_to IS NULL OR valid_to > now())
    LIMIT 1
  `, [grantId]);
  if (!grant || grant.permission_id !== permissions.platformImpersonationStart) return;
  const remaining = await queryOne<{ count: string }>(client as never, `
    SELECT COUNT(DISTINCT operator_id)::text AS count
    FROM app.operator_explicit_permission_grants
    WHERE permission_id = $1
      AND scope_type = 'platform'
      AND merchant_id IS NULL
      AND store_id IS NULL
      AND status = 'active'
      AND valid_from <= now()
      AND (valid_to IS NULL OR valid_to > now())
      AND id::text <> $2
  `, [permissions.platformImpersonationStart, grantId]);
  if (Number(remaining?.count || 0) < 1) {
    throw new PlatformError("last_platform_owner_grant", "Cannot remove the last Platform Owner impersonation grant", 409);
  }
}

export async function revokePlatformOperatorPermission(
  grantId: string,
  actor: OperatorContext,
  input?: { reason?: string },
) {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockPlatformOwnerGrants(client);
    await assertNotLastPlatformOwnerGrant(client, grantId);
    const revoked = await queryOne<{ operator_id: string; permission_id: PermissionId }>(client, `
      UPDATE app.operator_explicit_permission_grants
      SET status = 'revoked',
          revoked_by = $2,
          revoked_at = now(),
          reason = COALESCE($3, reason),
          updated_at = now()
      WHERE id::text = $1 AND status = 'active'
      RETURNING operator_id, permission_id
    `, [grantId, actor.operatorId, input?.reason || null]);
    if (!revoked) throw new PlatformError("resource_not_found", "Permission grant not found", 404, { grantId });
    await ensureOperatorSecurityState(client, revoked.operator_id);
    await client.query(`
      UPDATE app.operator_security_state
      SET session_version = session_version + 1, updated_at = now()
      WHERE operator_id = $1
    `, [revoked.operator_id]);
    await recordAuditEntry(client, actor, "platform.operator.permission_revoked", "operator", revoked.operator_id, {
      reason: input?.reason,
      before: { grantId, permissionId: revoked.permission_id },
    });
    return { data: { grantId, operatorId: revoked.operator_id, permissionId: revoked.permission_id, status: "revoked" } };
  });
}

export { PLATFORM_OWNER_GRANTS, PLATFORM_OWNER_GRANT_LOCK_KEY };
