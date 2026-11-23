import type { PoolClient } from "pg";
import { permissions } from "@medusa-snus/contracts";
import { PlatformError } from "../errors/platform-error";
import { platformRolePermissionIds } from "../services/access-service";
import type { OperatorContext } from "../services/auth-service";
import type { PermissionActor } from "../services/permission-service";

export function requirePlatformMcpStaffSession(actor: PermissionActor): OperatorContext {
  if ("channel" in actor || actor.impersonationSessionId || actor.impersonationMode || actor.authState !== "authenticated"
    || !Number.isSafeInteger(actor.sessionVersion) || actor.sessionVersion! < 1 || actor.sessionVersion! > 2147483647
    || !actor.sessionExpiresAt || !Number.isFinite(Date.parse(actor.sessionExpiresAt))) {
    throw new PlatformError("forbidden", "An authenticated platform staff session is required", 403);
  }
  return actor;
}
export async function lockPlatformMcpAdminForClient(db: PoolClient, actor: OperatorContext) {
  const row = await db.query<{ allowed: boolean }>("SELECT integration.lock_platform_mcp_admin($1,$2,$3) AS allowed",
    [actor.operatorId, actor.sessionVersion, actor.sessionExpiresAt]);
  if (!row.rows[0]?.allowed || !platformRolePermissionIds.platform_admin.includes(permissions.platformWrite)) {
    throw new PlatformError("forbidden", "Current platform admin authority is required", 403);
  }
}
export async function readPlatformMcpReaderRoleForClient(db: PoolClient, actor: OperatorContext) {
  const row = (await db.query<{ role: "platform_admin" | "platform_readonly" | null }>(
    "SELECT integration.platform_mcp_reader_role($1,$2,$3) AS role", [actor.operatorId, actor.sessionVersion, actor.sessionExpiresAt])).rows[0];
  if (!row?.role || !platformRolePermissionIds[row.role]?.includes(permissions.platformRead)) {
    throw new PlatformError("forbidden", "Current platform read authority is required", 403);
  }
  return row.role;
}
