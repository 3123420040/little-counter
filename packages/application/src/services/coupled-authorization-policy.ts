import type {
  MembershipScopeType,
  MembershipSummary,
  PermissionId,
  RequestAccess,
} from "@medusa-snus/contracts";
import { permissions } from "@medusa-snus/contracts";
import {
  AuthorizationTargetV1Schema,
  ScopeCoupledAuthorizationDecisionV1Schema,
  type AuthorizationTargetV1,
  type ScopeCoupledAuthorizationDecisionV1,
} from "@medusa-snus/contracts/authorization-policy";
import { PlatformError } from "../errors/platform-error";

type MembershipAuthorizationEvidence = MembershipSummary & {
  validFrom?: string;
  validTo?: string | null;
};

function effectiveAt(
  validFrom: string | undefined,
  validTo: string | null | undefined,
  now: Date,
): boolean {
  const nowMs = now.getTime();
  const fromMs = validFrom ? Date.parse(validFrom) : Number.NEGATIVE_INFINITY;
  const toMs = validTo ? Date.parse(validTo) : Number.POSITIVE_INFINITY;
  return Number.isFinite(nowMs)
    && !Number.isNaN(fromMs)
    && !Number.isNaN(toMs)
    && fromMs <= nowMs
    && nowMs < toMs;
}

function scopeSpecificity(
  scopeType: MembershipScopeType,
  merchantId: string | null,
  storeId: string | null,
  target: AuthorizationTargetV1,
  sharedMerchantAccess = false,
): number | null {
  if (target.scopeType === "platform") return scopeType === "platform" ? 0 : null;
  if (scopeType === "platform") return null;
  if (target.scopeType === "merchant") {
    if (merchantId !== target.merchantId) return null;
    if (scopeType === "merchant") return 0;
    // Customer and category defaults serve staff across their assigned merchant.
    return scopeType === "store" && Boolean(storeId) && sharedMerchantAccess ? 1 : null;
  }
  if (merchantId !== target.merchantId) return null;
  if (scopeType === "store") return storeId === target.storeId ? 0 : null;
  return scopeType === "merchant" ? 1 : null;
}

/**
 * Authorizes from one effective membership or explicit grant that contains
 * both the permission and the requested target. Aggregate permissionIds and
 * platform visibility are deliberately never used as business-scope proof.
 */
export function decideScopeCoupledAuthorization(
  access: RequestAccess,
  permissionId: PermissionId,
  targetInput: AuthorizationTargetV1,
  now = new Date(),
): ScopeCoupledAuthorizationDecisionV1 {
  const target = AuthorizationTargetV1Schema.parse(targetInput);
  const candidates: Array<{
    specificity: number;
    sourceOrder: number;
    sourceId: string;
    sourceType: "membership" | "explicit_grant";
    scopeType: MembershipScopeType;
  }> = [];

  for (const membership of access.memberships as MembershipAuthorizationEvidence[]) {
    if (
      membership.status !== "active"
      || !effectiveAt(membership.validFrom, membership.validTo, now)
      || !membership.permissionIds.includes(permissionId)
    ) continue;
    const specificity = scopeSpecificity(
      membership.scopeType,
      membership.merchantId,
      membership.storeId,
      target,
      permissionId === permissions.customerRead || permissionId === permissions.customerWrite || permissionId === permissions.categoryRead,
    );
    if (specificity === null) continue;
    candidates.push({
      specificity,
      sourceOrder: 0,
      sourceId: membership.membershipId,
      sourceType: "membership",
      scopeType: membership.scopeType,
    });
  }

  for (const grant of access.explicitPermissions) {
    if (
      grant.permissionId !== permissionId
      || !effectiveAt(grant.validFrom, grant.validTo, now)
    ) continue;
    const specificity = scopeSpecificity(
      grant.scopeType,
      grant.merchantId,
      grant.storeId,
      target,
    );
    if (specificity === null) continue;
    candidates.push({
      specificity,
      sourceOrder: 1,
      sourceId: grant.grantId,
      sourceType: "explicit_grant",
      scopeType: grant.scopeType,
    });
  }

  candidates.sort((left, right) => (
    left.specificity - right.specificity
    || left.sourceOrder - right.sourceOrder
    || (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0)
  ));
  const proof = candidates[0];
  return ScopeCoupledAuthorizationDecisionV1Schema.parse({
    allowed: Boolean(proof),
    permissionId,
    target,
    proof: proof ? {
      sourceType: proof.sourceType,
      sourceId: proof.sourceId,
      scopeType: proof.scopeType,
    } : null,
  });
}

export function requireScopeCoupledAuthorization(
  access: RequestAccess,
  permissionId: PermissionId,
  target: AuthorizationTargetV1,
  now = new Date(),
): ScopeCoupledAuthorizationDecisionV1 {
  const decision = decideScopeCoupledAuthorization(access, permissionId, target, now);
  if (!decision.allowed) {
    throw new PlatformError("forbidden", `Missing scoped permission: ${permissionId}`, 403);
  }
  return decision;
}
