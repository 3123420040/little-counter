import { PlatformLifecycleCommandV1Schema, PlatformLifecycleCommandResultV1Schema, permissions, type PlatformLifecycleCommandResultV1 } from "@medusa-snus/contracts";
import type { PoolClient } from "../db/client";
import { withScopedIdempotency } from "../db/idempotency";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedTransaction } from "../db/transaction";
import { PlatformError } from "../errors/platform-error";
import type { HeadersLike } from "../http/headers";
import { recordAuditEntry } from "../repositories/audit-repository";
import { platformRolePermissionIds } from "./access-service";
import type { OperatorContext } from "./auth-service";
import type { PermissionActor } from "./permission-service";

/** Fresh command authority is also required for idempotent replay. */
async function assertPlatformAdminCommandAuthority(client: PoolClient, actor: PermissionActor, lockRows: boolean): Promise<void> {
  if ("channel" in actor || actor.impersonationSessionId || actor.impersonationMode || actor.authState !== "authenticated"
    || !Number.isSafeInteger(actor.sessionVersion) || !actor.sessionExpiresAt || !Number.isFinite(Date.parse(actor.sessionExpiresAt))) {
    throw new PlatformError("forbidden", "An authenticated platform admin session is required", 403);
  }
  await client.query("SAVEPOINT platform_authority_guard; RELEASE SAVEPOINT platform_authority_guard");
  const staff = await client.query<{ is_active: boolean }>(`SELECT is_active FROM medusa.staff_users WHERE operator_id=$1${lockRows ? " FOR SHARE" : ""}`, [actor.operatorId]);
  const security = await client.query<{ global_status: string; session_version: number; requires_password_change: boolean }>(`
    SELECT global_status,session_version,requires_password_change FROM app.operator_security_state WHERE operator_id=$1${lockRows ? " FOR SHARE" : ""}`, [actor.operatorId]);
  const memberships = await client.query<{ id: string }>(`SELECT id::text FROM app.operator_memberships
    WHERE operator_id=$1 AND scope_type='platform' AND role_key='platform_admin' AND status='active'
      AND merchant_id IS NULL AND store_id IS NULL
      AND valid_from<=clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp())
    ORDER BY id${lockRows ? " FOR SHARE" : ""}`, [actor.operatorId]);
  const state = security.rows[0];
  const fresh = await client.query<{ valid: boolean }>(`SELECT $2::timestamptz>clock_timestamp() AND EXISTS(
    SELECT 1 FROM app.operator_memberships WHERE id=ANY($1::uuid[]) AND status='active'
      AND valid_from<=clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp())) AS valid`,
  [memberships.rows.map(row => row.id), actor.sessionExpiresAt]);
  if (!staff.rows[0]?.is_active || !state || state.global_status !== "active" || state.requires_password_change
    || state.session_version !== actor.sessionVersion || !fresh.rows[0]?.valid
    || !platformRolePermissionIds.platform_admin.includes(permissions.platformWrite)) {
    throw new PlatformError("forbidden", "Active platform admin membership and platform write permission are required", 403);
  }
}

export async function lockPlatformAdminCommandAuthority(client: PoolClient, actor: PermissionActor): Promise<void> {
  await assertPlatformAdminCommandAuthority(client, actor, true);
}

type EntityRow = { id: string; status: "active" | "suspended" | "closed"; status_version: string; status_changed_at: Date | null };
function result(kind: "merchant" | "store", row: EntityRow, changed: boolean): PlatformLifecycleCommandResultV1 {
  return PlatformLifecycleCommandResultV1Schema.parse({ entityType: kind, entityId: row.id, status: row.status,
    statusVersion: Number(row.status_version), statusChangedAt: row.status_changed_at?.toISOString() ?? null, changed });
}

export async function changePlatformBusinessStatus(kind: "merchant" | "store", entityId: string, rawInput: unknown, actor: PermissionActor, headers: HeadersLike) {
  if (!["merchant", "store"].includes(kind) || typeof entityId !== "string" || !entityId.trim() || entityId !== entityId.trim()) {
    throw new PlatformError("validation_error", "A concrete merchant or store is required", 400);
  }
  const parsed = PlatformLifecycleCommandV1Schema.safeParse(rawInput);
  if (!parsed.success) throw new PlatformError("validation_error", "Invalid lifecycle status, version or reason", 400);
  const input = parsed.data;
  await ensurePlatformSchema();
  return withConnectedTransaction(async client => {
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'");
    // Team writers lock entity before staff; preliminary denial must not invert that order.
    await assertPlatformAdminCommandAuthority(client, actor, false);
    const staff = actor as OperatorContext;
    const outcome = await withScopedIdempotency(client, headers, { entityId, ...input }, `platform:${staff.operatorId}`,
      `platform.${kind}.status`, async () => {
        const storeTarget = kind === "store" ? (await client.query<{ merchant_id: string }>(
          "SELECT merchant_id FROM app.stores WHERE id=$1", [entityId])).rows[0] : null;
        if (kind === "store" && !storeTarget) throw new PlatformError("resource_not_found", "Store not found", 404);
        const merchantId = kind === "merchant" ? entityId : storeTarget!.merchant_id;
        const parent = (await client.query<EntityRow>(`SELECT id,status,status_version::text,status_changed_at FROM app.merchants WHERE id=$1 FOR ${kind === "merchant" ? "UPDATE" : "SHARE"}`, [merchantId])).rows[0];
        if (!parent) throw new PlatformError("resource_not_found", "Merchant not found", 404);
        const target = kind === "merchant" ? parent : (await client.query<EntityRow>(`
          SELECT id,status,status_version::text,status_changed_at FROM app.stores WHERE id=$1 AND merchant_id=$2 FOR UPDATE`, [entityId, merchantId])).rows[0];
        if (!target) throw new PlatformError("scope_changed", "Store ownership changed; reload before editing", 409);
        // Membership/session time may have elapsed while the target lock was waiting.
        await lockPlatformAdminCommandAuthority(client, actor);
        if (target.status === "closed" || parent.status === "closed") throw new PlatformError("entity_closed", "Closed entities are read-only", 409);
        if (Number(target.status_version) !== input.expectedVersion) throw new PlatformError("lifecycle_version_conflict", "Lifecycle state changed; reload before editing", 409);
        if (kind === "store" && input.status === "active" && parent.status !== "active") {
          throw new PlatformError("parent_suspended", "Enable the merchant before enabling its store", 409);
        }
        if (target.status === input.status) return { data: result(kind, target, false) };
        if (input.expectedVersion === Number.MAX_SAFE_INTEGER) throw new PlatformError("lifecycle_version_exhausted", "Lifecycle version requires administrative repair", 409);
        const table = kind === "merchant" ? "merchants" : "stores";
        const next = (await client.query<EntityRow>(`UPDATE app.${table} SET status=$2,status_version=status_version+1,
          status_changed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND status_version=$3
          RETURNING id,status,status_version::text,status_changed_at`, [entityId, input.status, input.expectedVersion])).rows[0];
        if (!next) throw new PlatformError("lifecycle_version_conflict", "Lifecycle state changed; reload before editing", 409);
        await recordAuditEntry(client, staff, `platform.${kind}.status_changed`, kind, entityId, {
          merchantId, storeId: kind === "store" ? entityId : undefined, reason: input.reason,
          before: { status: target.status, statusVersion: input.expectedVersion },
          after: { status: next.status, statusVersion: Number(next.status_version) },
        });
        return { data: result(kind, next, true) };
      }, 200);
    await lockPlatformAdminCommandAuthority(client, actor);
    return outcome;
  });
}
