import type { PermissionId } from "@medusa-snus/contracts";
import type { AuthorizationTargetV1 } from "@medusa-snus/contracts/authorization-policy";
import type { OperatorContext } from "./auth-service";
import type { ChannelActor } from "./channel-auth-service";
import { requireActorAccessPermission, requireOperatingScope, resolveMerchantTargetScope, resolvePlatformReadScope, resolveReportScope, resolveRequestAccess, type ScopeActor } from "./access-service";
import type { HeadersLike } from "../http/headers";
import { PlatformError } from "../errors/platform-error";
import { ensurePlatformSchema } from "../db/schema";
import { withConnectedClient } from "../db/transaction";
import { recordAuditEntry } from "../repositories/audit-repository";
import { requireScopeCoupledAuthorization } from "./coupled-authorization-policy";

export type PermissionActor = OperatorContext | ChannelActor;

function asScopeActor(actor: PermissionActor): ScopeActor {
  return actor;
}

export async function requireActorPermission(actor: PermissionActor, permissionId: PermissionId): Promise<void> {
  await requireActorAccessPermission(asScopeActor(actor), permissionId);
}

/**
 * Returns the single membership/grant proof that couples permission and target.
 * Route adoption is a separate A2 step; callers must not combine this with an
 * independently resolved target.
 */
export async function requireScopedActorPermission(
  actor: PermissionActor,
  permissionId: PermissionId,
  target: AuthorizationTargetV1,
) {
  const scopeActor = asScopeActor(actor);
  const access = scopeActor.access || await resolveRequestAccess(scopeActor);
  return requireScopeCoupledAuthorization(access, permissionId, target);
}

async function recordReadOnlyMutationDenied(actor: OperatorContext): Promise<void> {
  await ensurePlatformSchema();
  await withConnectedClient(async (client) => {
    await recordAuditEntry(
      client,
      actor,
      "impersonation.mutation_denied",
      "impersonation_session",
      actor.impersonationSessionId || "unknown",
      {
        reason: "impersonation_read_only",
        after: {
          actualOperatorId: actor.actualOperatorId,
          effectiveOperatorId: actor.effectiveOperatorId || actor.operatorId,
          mode: actor.impersonationMode,
        },
      },
    );
  });
}

export async function assertNotReadOnlyImpersonation(actor: PermissionActor): Promise<void> {
  if ("impersonationMode" in actor && actor.impersonationMode === "read_only") {
    await recordReadOnlyMutationDenied(actor).catch(() => undefined);
    throw new PlatformError("impersonation_read_only", "Read-only impersonation cannot perform mutations", 403, {
      impersonationSessionId: actor.impersonationSessionId,
      actualOperatorId: actor.actualOperatorId,
      effectiveOperatorId: actor.effectiveOperatorId || actor.operatorId,
    });
  }
}

export async function requireMutationScope(actor: PermissionActor, headers: HeadersLike) {
  await assertNotReadOnlyImpersonation(actor);
  return requireOperatingScope(asScopeActor(actor), headers);
}

export async function requireOperatingReadScope(actor: PermissionActor, headers: HeadersLike) {
  return requireOperatingScope(asScopeActor(actor), headers);
}

export async function requireMerchantTargetScope(actor: PermissionActor, merchantId: string) {
  return resolveMerchantTargetScope(asScopeActor(actor), merchantId);
}

export async function requireReadableReportScope(actor: PermissionActor, headers: HeadersLike) {
  return resolveReportScope(asScopeActor(actor), headers);
}

export async function requirePlatformReadScope(actor: PermissionActor, headers: HeadersLike) {
  return resolvePlatformReadScope(asScopeActor(actor), headers);
}
