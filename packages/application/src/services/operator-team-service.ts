import { randomBytes } from "node:crypto";
import type { MerchantRoleKey, MerchantTargetScope } from "@medusa-snus/contracts";
import { getCatalogEntry } from "./package-catalog-service";
import { getMerchantSubscriptionStatus } from "./subscription-service";
import { hashPassword } from "../middleware/auth";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient, withConnectedTransaction } from "../db/transaction";
import { queryOne } from "../db/query";
import type { PoolClient } from "../db/client";
import { PlatformError } from "../errors/platform-error";
import { recordAuditEntry } from "../repositories/audit-repository";
import type { OperatorContext } from "./auth-service";
import { ensureOperatorSecurityState, temporaryPasswordExpiry } from "./operator-security-service";
import { lockActiveBusinessScopeForClient } from "./business-lifecycle-service";

export type TeamRole = Exclude<MerchantRoleKey, "owner">;
export type ScopeType = "merchant" | "store";

export interface CreateTeamOperatorInput {
  operatorId?: string;
  displayName?: string;
  role?: TeamRole;
  scopeType?: ScopeType;
  storeId?: string | null;
  email?: string | null;
  phoneE164?: string | null;
}

export interface UpdateTeamOperatorProfileInput {
  displayName?: string;
  email?: string | null;
  phoneE164?: string | null;
}

export interface UpdateTeamMembershipInput {
  role?: TeamRole;
  scopeType?: ScopeType;
  storeId?: string | null;
}

export interface TeamMutationResult {
  data: {
    membershipId: string;
    operatorId: string;
    temporaryPassword?: string;
    temporaryPasswordExpiresAt?: string;
  };
}

const NON_OWNER_ROLES: TeamRole[] = ["staff", "manager", "accountant"];

function ensureScope(scope: MerchantTargetScope, merchantId: string): void {
  if (scope.merchantId !== merchantId) {
    throw new PlatformError("forbidden", "Merchant target is not accessible", 403, { merchantId });
  }
}

function cleanOperatorId(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(text)) {
    throw new PlatformError("validation_error", "Tên đăng nhập / Username phải dài 3-64 ký tự và chỉ gồm chữ, số, dấu chấm, gạch dưới hoặc gạch nối", 400);
  }
  return text;
}

function cleanDisplayName(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 2 || text.length > 120) {
    throw new PlatformError("validation_error", "Display name must be 2-120 characters", 400);
  }
  return text;
}

function cleanRole(value: unknown): TeamRole {
  if (NON_OWNER_ROLES.includes(value as TeamRole)) return value as TeamRole;
  throw new PlatformError("validation_error", "Role must be staff, manager, or accountant", 400);
}

function cleanNullableText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) throw new PlatformError("validation_error", `Value must be at most ${maxLength} characters`, 400);
  return text;
}

function normalizeEmail(value: unknown): string | null {
  return cleanNullableText(value, 320)?.toLowerCase() || null;
}

async function cleanStoreTarget(client: PoolClient, merchantId: string, scopeType: ScopeType, storeIdInput: unknown): Promise<string | null> {
  if (scopeType === "merchant") return null;
  const storeId = cleanNullableText(storeIdInput, 128);
  if (!storeId) throw new PlatformError("validation_error", "Store is required for store-scoped team member", 400);
  const store = await queryOne<{ id: string }>(client, `
    SELECT id FROM app.stores WHERE id = $1 AND merchant_id = $2 AND status = 'active' LIMIT 1
  `, [storeId, merchantId]);
  if (!store) throw new PlatformError("store_not_found", "Store not found for merchant", 404, { storeId, merchantId });
  await lockActiveBusinessScopeForClient(client, { scopeType: "store", merchantId, storeId });
  return storeId;
}

function generateTemporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

export type TeamAuthority = {
  hasMerchantOwnerAuthority: boolean;
  hasMerchantManagerAuthority: boolean;
  storeIds: string[];
};

async function loadTeamAuthority(
  client: PoolClient,
  actor: OperatorContext,
  merchantId: string,
  lock = false,
): Promise<TeamAuthority> {
  const rows = await client.query<{
    role_key: MerchantRoleKey;
    scope_type: ScopeType;
    store_id: string | null;
  }>(`
    SELECT role_key, scope_type, store_id
    FROM app.operator_memberships
    WHERE operator_id = $1
      AND merchant_id = $2
      AND status = 'active'
      AND scope_type IN ('merchant', 'store')
      AND valid_from <= now()
      AND (valid_to IS NULL OR valid_to > now())
      AND role_key IN ('owner', 'manager')
    ${lock ? "FOR UPDATE" : ""}
  `, [actor.operatorId, merchantId]);
  if (rows.rows.length === 0) {
    throw new PlatformError("forbidden", "Owner or manager team authority required", 403);
  }
  return {
    hasMerchantOwnerAuthority: rows.rows.some((row) => row.role_key === "owner" && row.scope_type === "merchant"),
    hasMerchantManagerAuthority: rows.rows.some((row) => row.role_key === "manager" && row.scope_type === "merchant"),
    storeIds: Array.from(new Set(rows.rows
      .filter((row) => row.scope_type === "store" && row.store_id)
      .map((row) => String(row.store_id)))),
  };
}

type TeamTargetAuthority = {
  hasOwnerAuthority: boolean;
  hasElevatedAuthority: boolean;
};

async function loadTeamTargetAuthority(
  client: PoolClient,
  operatorId: string,
  merchantId: string,
): Promise<TeamTargetAuthority> {
  const row = await queryOne<{ has_owner_authority: boolean; has_elevated_authority: boolean }>(client, `
    SELECT
      COALESCE(bool_or(role_key = 'owner'), false) AS has_owner_authority,
      COALESCE(bool_or(role_key IN ('owner', 'manager', 'accountant')), false) AS has_elevated_authority
    FROM app.operator_memberships
    WHERE operator_id = $1
      AND merchant_id = $2
      AND status = 'active'
      AND scope_type IN ('merchant', 'store')
      AND valid_from <= now()
      AND (valid_to IS NULL OR valid_to > now())
  `, [operatorId, merchantId]);
  return {
    hasOwnerAuthority: Boolean(row?.has_owner_authority),
    hasElevatedAuthority: Boolean(row?.has_elevated_authority),
  };
}

async function assertCanManageTarget(
  client: PoolClient,
  actor: OperatorContext,
  authority: TeamAuthority,
  membership: Awaited<ReturnType<typeof loadMembership>>,
): Promise<void> {
  assertTargetIsNonOwner(membership.role_key);
  const targetAuthority = await loadTeamTargetAuthority(client, membership.operator_id, membership.merchant_id);
  assertTeamTargetPolicy(authority, actor.operatorId, {
    operatorId: membership.operator_id,
    storeId: membership.store_id,
    ...targetAuthority,
  });
}

export function assertTeamTargetPolicy(
  authority: TeamAuthority,
  actorOperatorId: string,
  target: TeamTargetAuthority & { operatorId: string; storeId: string | null },
): void {
  if (target.operatorId === actorOperatorId) {
    throw new PlatformError("forbidden", "Operators cannot manage their own team authority", 403);
  }
  if (target.hasOwnerAuthority) {
    throw new PlatformError("forbidden", "Team tools cannot manage operators with owner authority", 403);
  }
  if (authority.hasMerchantOwnerAuthority) return;
  if (target.hasElevatedAuthority) {
    throw new PlatformError("forbidden", "Managers cannot manage peer or higher-authority operators", 403);
  }
  if (!authority.hasMerchantManagerAuthority && (!target.storeId || !authority.storeIds.includes(target.storeId))) {
    throw new PlatformError("forbidden", "Store managers can manage only members in their own store", 403);
  }
}

export function assertCanDelegateRequestedScope(
  authority: TeamAuthority,
  role: TeamRole,
  scopeType: ScopeType,
  storeId: string | null,
): void {
  if (authority.hasMerchantOwnerAuthority) return;
  if (role !== "staff") {
    throw new PlatformError("forbidden", "Managers can delegate only staff authority", 403);
  }
  if (!authority.hasMerchantManagerAuthority && (scopeType !== "store" || !storeId || !authority.storeIds.includes(storeId))) {
    throw new PlatformError("forbidden", "Store managers cannot delegate merchant or cross-store scope", 403);
  }
}

async function lockTeamOperatorEnvelope(client: PoolClient, merchantId: string, operatorId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`team_operator\u001f${merchantId}\u001f${operatorId}`],
  );
}

async function lockTeamStaffEntitlement(client: PoolClient, merchantId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`team_staff_entitlement\u001f${merchantId}`],
  );
}

async function syncLegacyStaffRole(client: PoolClient, operatorId: string): Promise<void> {
  const highest = await queryOne<{ role_key: MerchantRoleKey }>(client, `
    SELECT role_key
    FROM app.operator_memberships
    WHERE operator_id = $1
      AND status = 'active'
      AND scope_type IN ('merchant', 'store')
      AND valid_from <= now()
      AND (valid_to IS NULL OR valid_to > now())
    ORDER BY CASE role_key
      WHEN 'owner' THEN 0
      WHEN 'manager' THEN 1
      WHEN 'accountant' THEN 2
      ELSE 3
    END
    LIMIT 1
  `, [operatorId]);
  if (!highest) return;
  await client.query(`
    UPDATE medusa.staff_users
    SET role = $2
    WHERE operator_id = $1
  `, [operatorId, highest.role_key]);
}

async function assertStaffLimitAllowsOperator(
  client: PoolClient,
  merchantId: string,
  operatorId: string,
): Promise<void> {
  const alreadyCounted = await queryOne<{ exists: boolean }>(client, `
    SELECT EXISTS (
      SELECT 1
      FROM app.operator_memberships
      WHERE merchant_id = $1
        AND operator_id = $2
        AND scope_type IN ('merchant', 'store')
        AND status = 'active'
        AND valid_from <= now()
        AND (valid_to IS NULL OR valid_to > now())
    ) AS exists
  `, [merchantId, operatorId]);
  if (alreadyCounted?.exists) return;

  const subscription = await getMerchantSubscriptionStatus(merchantId, { client });
  const catalog = await getCatalogEntry(subscription.packageKey, { client });
  const count = await queryOne<{ count: string }>(client, `
    SELECT COUNT(DISTINCT operator_id)::text AS count
    FROM app.operator_memberships
    WHERE merchant_id = $1
      AND scope_type IN ('merchant', 'store')
      AND status = 'active'
      AND valid_from <= now()
      AND (valid_to IS NULL OR valid_to > now())
  `, [merchantId]);
  if (Number(count?.count || 0) >= catalog.staffLimit) {
    throw new PlatformError("staff_limit_exceeded", "Merchant staff limit has been reached", 409, {
      merchantId,
      staffLimit: catalog.staffLimit,
    });
  }
}

async function loadMembership(client: PoolClient, membershipId: string, lock = false) {
  const membership = await queryOne<{
    id: string;
    operator_id: string;
    merchant_id: string;
    store_id: string | null;
    role_key: MerchantRoleKey;
    status: string;
  }>(client, `
    SELECT id::text, operator_id, merchant_id, store_id, role_key, status
    FROM app.operator_memberships
    WHERE id::text = $1
      AND scope_type IN ('merchant', 'store')
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
  `, [membershipId]);
  if (!membership) throw new PlatformError("resource_not_found", "Team membership not found", 404, { membershipId });
  return membership;
}

type TeamMembershipStatus = "active" | "disabled" | "pending" | "revoked";

function assertMembershipStatus(
  membership: Awaited<ReturnType<typeof loadMembership>>,
  expectedStatus: TeamMembershipStatus,
): void {
  if (membership.status !== expectedStatus) {
    throw new PlatformError("membership_state_conflict", `Team membership must be ${expectedStatus}`, 409, {
      membershipId: membership.id,
      status: membership.status,
    });
  }
}

async function loadMembershipForMutation(
  client: PoolClient,
  membershipId: string,
  expectedStatus: TeamMembershipStatus,
  options: { lockStaffEntitlement?: boolean } = {},
) {
  const initial = await loadMembership(client, membershipId);
  await lockActiveBusinessScopeForClient(client, initial.store_id
    ? { scopeType: "store", merchantId: initial.merchant_id, storeId: initial.store_id }
    : { scopeType: "merchant", merchantId: initial.merchant_id });
  if (options.lockStaffEntitlement) await lockTeamStaffEntitlement(client, initial.merchant_id);
  await lockTeamOperatorEnvelope(client, initial.merchant_id, initial.operator_id);
  const locked = await loadMembership(client, membershipId, true);
  if (locked.merchant_id !== initial.merchant_id || locked.operator_id !== initial.operator_id
    || locked.store_id !== initial.store_id) {
    throw new PlatformError("membership_changed", "Team membership changed during mutation", 409);
  }
  assertMembershipStatus(locked, expectedStatus);
  return locked;
}

function assertTargetIsNonOwner(role: MerchantRoleKey): void {
  if (role === "owner") {
    throw new PlatformError("forbidden", "Owner memberships cannot be managed by team tools", 403);
  }
}

export async function createTeamOperator(
  merchantId: string,
  input: CreateTeamOperatorInput,
  actor: OperatorContext,
  scope: MerchantTargetScope,
): Promise<TeamMutationResult> {
  ensureScope(scope, merchantId);
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    await lockActiveBusinessScopeForClient(client, { scopeType: "merchant", merchantId });
    await lockTeamStaffEntitlement(client, merchantId);
    const authority = await loadTeamAuthority(client, actor, merchantId, true);

    const operatorId = cleanOperatorId(input.operatorId);
    const displayName = cleanDisplayName(input.displayName);
    const role = cleanRole(input.role);
    const scopeType: ScopeType = input.scopeType === "store" ? "store" : "merchant";
    const storeId = await cleanStoreTarget(client, merchantId, scopeType, input.storeId);
    assertCanDelegateRequestedScope(authority, role, scopeType, storeId);
    await lockTeamOperatorEnvelope(client, merchantId, operatorId);
    await assertStaffLimitAllowsOperator(client, merchantId, operatorId);

    const exists = await queryOne<{ operator_id: string }>(client, `
      SELECT operator_id FROM medusa.staff_users WHERE operator_id = $1 LIMIT 1
    `, [operatorId]);
    if (exists) {
      throw new PlatformError("operator_exists", "Tên đăng nhập / Username đã tồn tại", 409, { operatorId });
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const passwordExpiresAt = temporaryPasswordExpiry();
    await client.query(`
      INSERT INTO medusa.staff_users (operator_id, password_hash, display_name, role, is_active, organization_id)
      SELECT $1, $2, $3, $4, true, m.legacy_organization_id
      FROM app.merchants m
      WHERE m.id = $5
    `, [operatorId, passwordHash, displayName, role, merchantId]);

    await client.query(`
      INSERT INTO app.operator_profiles (operator_id, email, normalized_email, phone_e164)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (operator_id) DO UPDATE
      SET email = EXCLUDED.email,
          normalized_email = EXCLUDED.normalized_email,
          phone_e164 = EXCLUDED.phone_e164,
          updated_at = now()
    `, [
      operatorId,
      cleanNullableText(input.email, 320),
      normalizeEmail(input.email),
      cleanNullableText(input.phoneE164, 32),
    ]);

    const membership = await queryOne<{ id: string }>(client, `
      INSERT INTO app.operator_memberships (operator_id, scope_type, merchant_id, store_id, role_key, status, granted_by)
      VALUES ($1, $2, $3, $4, $5, 'active', $6)
      RETURNING id::text
    `, [operatorId, scopeType, merchantId, storeId, role, actor.operatorId]);
    if (!membership) throw new PlatformError("team_create_failed", "Team member creation failed", 500);

    await client.query(`
      INSERT INTO app.operator_security_state (
        operator_id, requires_password_change, session_version, global_status,
        temporary_password_hash, temporary_password_expires_at
      )
      VALUES ($1, true, 1, 'active', $2, $3)
      ON CONFLICT (operator_id) DO UPDATE
      SET requires_password_change = true,
          temporary_password_hash = EXCLUDED.temporary_password_hash,
          temporary_password_expires_at = EXCLUDED.temporary_password_expires_at,
          session_version = app.operator_security_state.session_version + 1,
          updated_at = now()
    `, [operatorId, passwordHash, passwordExpiresAt]);

    await recordAuditEntry(client, actor, "team.operator.created", "operator", operatorId, {
      after: { membershipId: membership.id, merchantId, storeId, role },
      merchantId,
      storeId: storeId || undefined,
    });

    return {
      data: {
        membershipId: membership.id,
        operatorId,
        temporaryPassword,
        temporaryPasswordExpiresAt: passwordExpiresAt.toISOString(),
      },
    };
  });
}

export async function updateTeamOperatorProfile(
  membershipId: string,
  actor: OperatorContext,
  input: UpdateTeamOperatorProfileInput,
) {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const membership = await loadMembershipForMutation(client, membershipId, "active");
    const authority = await loadTeamAuthority(client, actor, membership.merchant_id, true);
    await assertCanManageTarget(client, actor, authority, membership);

    const current = await queryOne<{
      operator_id: string;
      display_name: string | null;
      email: string | null;
      phone_e164: string | null;
    }>(client, `
      SELECT su.operator_id, su.display_name, p.email, p.phone_e164
      FROM medusa.staff_users su
      LEFT JOIN app.operator_profiles p ON p.operator_id = su.operator_id
      WHERE su.operator_id = $1
      LIMIT 1
    `, [membership.operator_id]);
    if (!current) throw new PlatformError("resource_not_found", "Operator not found", 404, { operatorId: membership.operator_id });

    const displayName = input.displayName === undefined ? current.display_name || membership.operator_id : cleanDisplayName(input.displayName);
    const email = input.email === undefined ? current.email : cleanNullableText(input.email, 320);
    const phoneE164 = input.phoneE164 === undefined ? current.phone_e164 : cleanNullableText(input.phoneE164, 32);

    await client.query(`
      UPDATE medusa.staff_users
      SET display_name = $2
      WHERE operator_id = $1
    `, [membership.operator_id, displayName]);
    await client.query(`
      INSERT INTO app.operator_profiles (operator_id, email, normalized_email, phone_e164)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (operator_id) DO UPDATE
      SET email = EXCLUDED.email,
          normalized_email = EXCLUDED.normalized_email,
          phone_e164 = EXCLUDED.phone_e164,
          updated_at = now()
    `, [membership.operator_id, email, normalizeEmail(email), phoneE164]);

    await recordAuditEntry(client, actor, "team.operator.profile_updated", "operator", membership.operator_id, {
      before: {
        displayName: current.display_name,
        email: current.email,
        phoneE164: current.phone_e164,
      },
      after: { displayName, email, phoneE164 },
      merchantId: membership.merchant_id,
      storeId: membership.store_id || undefined,
    });

    return {
      data: {
        membershipId,
        operatorId: membership.operator_id,
        displayName,
        email,
        phoneE164,
      },
    };
  });
}

export async function updateTeamMembership(
  membershipId: string,
  actor: OperatorContext,
  input: UpdateTeamMembershipInput,
) {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const membership = await loadMembershipForMutation(client, membershipId, "active");
    const authority = await loadTeamAuthority(client, actor, membership.merchant_id, true);
    await assertCanManageTarget(client, actor, authority, membership);

    const role = input.role === undefined ? membership.role_key as TeamRole : cleanRole(input.role);
    const currentScopeType: ScopeType = membership.store_id ? "store" : "merchant";
    const scopeType: ScopeType = input.scopeType === undefined ? currentScopeType : input.scopeType === "store" ? "store" : "merchant";
    const storeId = await cleanStoreTarget(client, membership.merchant_id, scopeType, input.storeId ?? membership.store_id);
    assertCanDelegateRequestedScope(authority, role, scopeType, storeId);

    const changed = role !== membership.role_key
      || scopeType !== (membership.store_id ? "store" : "merchant")
      || storeId !== membership.store_id;

    await client.query(`
      UPDATE app.operator_memberships
      SET role_key = $2,
          scope_type = $3,
          store_id = $4,
          updated_at = now()
      WHERE id::text = $1
    `, [membershipId, role, scopeType, storeId]);
    await syncLegacyStaffRole(client, membership.operator_id);

    if (changed) {
      await ensureOperatorSecurityState(client, membership.operator_id);
      await client.query(`
        UPDATE app.operator_security_state
        SET session_version = session_version + 1,
            force_logout_after = now(),
            updated_at = now()
        WHERE operator_id = $1
      `, [membership.operator_id]);
    }

    await recordAuditEntry(client, actor, "team.membership.updated", "operator_membership", membershipId, {
      before: {
        role: membership.role_key,
        scopeType: membership.store_id ? "store" : "merchant",
        storeId: membership.store_id,
      },
      after: { role, scopeType, storeId },
      merchantId: membership.merchant_id,
      storeId: storeId || undefined,
    });

    return {
      data: {
        membershipId,
        operatorId: membership.operator_id,
        role,
        scopeType,
        storeId,
      },
    };
  });
}

export async function listTeamOperatorAudit(
  membershipId: string,
  actor: OperatorContext,
) {
  await ensurePlatformSchema();
  return withConnectedClient(async (client) => {
    const membership = await loadMembership(client, membershipId);
    const authority = await loadTeamAuthority(client, actor, membership.merchant_id);
    await assertCanManageTarget(client, actor, authority, membership);
    const rows = await client.query(`
      SELECT
        id::text,
        action,
        actor_id AS "actorId",
        reason,
        before,
        after,
        created_at AS "createdAt"
      FROM audit.events
      WHERE merchant_id = $1
        AND action LIKE 'team.%'
        AND (subject_id = $2 OR subject_id = $3)
      ORDER BY created_at DESC
      LIMIT 100
    `, [membership.merchant_id, membership.operator_id, membershipId]);
    return { data: rows.rows };
  });
}

export async function resetTeamOperatorPassword(
  membershipId: string,
  actor: OperatorContext,
): Promise<TeamMutationResult> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const membership = await loadMembershipForMutation(client, membershipId, "active");
    const authority = await loadTeamAuthority(client, actor, membership.merchant_id, true);
    await assertCanManageTarget(client, actor, authority, membership);

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const passwordExpiresAt = temporaryPasswordExpiry();
    await client.query(`
      UPDATE medusa.staff_users
      SET password_hash = $2
      WHERE operator_id = $1
    `, [membership.operator_id, passwordHash]);
    await ensureOperatorSecurityState(client, membership.operator_id);
    await client.query(`
      UPDATE app.operator_security_state
      SET requires_password_change = true,
          temporary_password_hash = $2,
          temporary_password_expires_at = $3,
          session_version = session_version + 1,
          force_logout_after = now(),
          updated_at = now()
      WHERE operator_id = $1
    `, [membership.operator_id, passwordHash, passwordExpiresAt]);
    await recordAuditEntry(client, actor, "team.operator.password_reset", "operator", membership.operator_id, {
      merchantId: membership.merchant_id,
      storeId: membership.store_id || undefined,
    });
    return {
      data: {
        membershipId: membership.id,
        operatorId: membership.operator_id,
        temporaryPassword,
        temporaryPasswordExpiresAt: passwordExpiresAt.toISOString(),
      },
    };
  });
}

export async function disableTeamMembership(
  membershipId: string,
  actor: OperatorContext,
  input?: { reason?: string },
): Promise<{ data: { membershipId: string; status: "disabled" } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const membership = await loadMembershipForMutation(client, membershipId, "active");
    const authority = await loadTeamAuthority(client, actor, membership.merchant_id, true);
    await assertCanManageTarget(client, actor, authority, membership);
    await client.query(`
      UPDATE app.operator_memberships
      SET status = 'disabled', updated_at = now()
      WHERE id::text = $1
    `, [membershipId]);
    await syncLegacyStaffRole(client, membership.operator_id);
    await ensureOperatorSecurityState(client, membership.operator_id);
    await client.query(`
      UPDATE app.operator_security_state
      SET session_version = session_version + 1,
          force_logout_after = now(),
          updated_at = now()
      WHERE operator_id = $1
    `, [membership.operator_id]);
    await recordAuditEntry(client, actor, "team.membership.disabled", "operator_membership", membershipId, {
      before: { status: membership.status },
      after: { status: "disabled" },
      reason: input?.reason,
      merchantId: membership.merchant_id,
      storeId: membership.store_id || undefined,
    });
    return { data: { membershipId, status: "disabled" } };
  });
}

export async function enableTeamMembership(
  membershipId: string,
  actor: OperatorContext,
): Promise<{ data: { membershipId: string; status: "active" } }> {
  await ensurePlatformSchema();
  return withConnectedTransaction(async (client) => {
    const membership = await loadMembershipForMutation(client, membershipId, "disabled", { lockStaffEntitlement: true });
    const authority = await loadTeamAuthority(client, actor, membership.merchant_id, true);
    await assertCanManageTarget(client, actor, authority, membership);
    assertCanDelegateRequestedScope(
      authority,
      membership.role_key as TeamRole,
      membership.store_id ? "store" : "merchant",
      membership.store_id,
    );
    await assertStaffLimitAllowsOperator(client, membership.merchant_id, membership.operator_id);
    const security = await ensureOperatorSecurityState(client, membership.operator_id);
    if (security.globalStatus !== "active") {
      throw new PlatformError("operator_suspended", "Globally suspended operator cannot be enabled", 409);
    }
    await client.query(`
      UPDATE app.operator_memberships
      SET status = 'active', updated_at = now()
      WHERE id::text = $1 AND status = 'disabled'
    `, [membershipId]);
    await syncLegacyStaffRole(client, membership.operator_id);
    await client.query(`
      UPDATE app.operator_security_state
      SET session_version = session_version + 1,
          updated_at = now()
      WHERE operator_id = $1
    `, [membership.operator_id]);
    await recordAuditEntry(client, actor, "team.membership.enabled", "operator_membership", membershipId, {
      before: { status: membership.status },
      after: { status: "active" },
      merchantId: membership.merchant_id,
      storeId: membership.store_id || undefined,
    });
    return { data: { membershipId, status: "active" } };
  });
}
