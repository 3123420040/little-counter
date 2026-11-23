import type { MedusaRequest, MedusaResponse } from "./http-types";
import { permissions, type PermissionId } from "@medusa-snus/contracts";
import {
  authenticateRequestActor,
  PlatformError,
  assertNotReadOnlyImpersonation,
  enforceRateLimit,
  requireActorPermission,
  requireActivePlatformMembership,
  requireMerchantTargetScope,
  requireMutationScope,
  requireOperatingReadScope,
  requireReadableReportScope,
  requirePlatformReadScope,
  requireScopedActorPermission,
  resolveChannelActor,
  resolveRequestAccess,
  resolveOrderHistoryScope,
  resolveDashboardHistoryScope,
  type ChannelActor,
  sendPlatformError,
  type OperatorContext,
  type RateLimitSubject,
  type Role,
} from "@medusa-snus/application";

export type RequestActor = OperatorContext | ChannelActor;
type RateLimitScope = "auth" | "checkout" | "ai" | "default";

export async function actor(
  req: MedusaRequest,
  minRole: Role = "staff",
  options: { allowPasswordChangeRequired?: boolean } = {},
): Promise<OperatorContext> {
  const operator = await authenticateRequestActor(
    req.headers as Record<string, string | string[] | undefined>,
    minRole,
    options,
  );
  enforceRateLimit(req.headers as Record<string, string | string[] | undefined>, "default", {
    kind: "operator",
    id: operator.operatorId,
  });
  return operator;
}

export function hasChannelHeaders(req: MedusaRequest): boolean {
  const value = req.headers["x-channel"] ?? req.headers["X-Channel"];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

export async function actorWithPermission(
  req: MedusaRequest,
  minRole: Role,
  permissionId: PermissionId,
  scope: RateLimitScope = "default",
): Promise<RequestActor> {
  if (hasChannelHeaders(req)) {
    const operator = await resolveChannelActor(headers(req));
    rateLimit(req, scope, { kind: "operator", id: operator.operatorId });
    await requireActorPermission(operator, permissionId);
    return operator;
  }

  const operator = await actor(req, minRole);
  await requireActorPermission(operator, permissionId);
  return operator;
}

/**
 * Authenticates an actor without using role order for authorization. The
 * caller must supply the explicit permission required by the operation.
 */
async function actorWithExplicitPermission(
  req: MedusaRequest,
  permissionId: PermissionId,
  scope: RateLimitScope,
): Promise<RequestActor> {
  if (hasChannelHeaders(req)) {
    const operator = await resolveChannelActor(headers(req));
    rateLimit(req, scope, { kind: "operator", id: operator.operatorId });
    await requireActorPermission(operator, permissionId);
    return operator;
  }

  const operator = await authenticateRequestActor(headers(req));
  rateLimit(req, scope, { kind: "operator", id: operator.operatorId });
  await requireActorPermission(operator, permissionId);
  return operator;
}

export function rateLimit(
  req: MedusaRequest,
  scope: RateLimitScope = "default",
  subject?: RateLimitSubject,
): void {
  enforceRateLimit(req.headers as Record<string, string | string[] | undefined>, scope, subject);
}

export async function route(res: MedusaResponse, fn: () => Promise<unknown>, status?: number): Promise<void> {
  try {
    const body = await fn();
    const maybeStatus = typeof body === "object" && body !== null && "statusCode" in body
      ? Number((body as { statusCode?: unknown }).statusCode)
      : undefined;
    if (Number.isInteger(maybeStatus) && maybeStatus && maybeStatus >= 100 && maybeStatus < 600) {
      res.status(maybeStatus);
      const { statusCode: _statusCode, ...rest } = body as Record<string, unknown>;
      res.json(rest);
      return;
    }
    if (status) {
      res.status(status);
    }
    res.json(body);
  } catch (err) {
    sendPlatformError(res as unknown as { status: (code: number) => { json: (body: unknown) => void } }, err);
  }
}

export async function csvDownloadRoute(
  res: MedusaResponse,
  filename: string | (() => Promise<string> | string),
  fn: () => Promise<string> | string,
): Promise<void> {
  try {
    const resolvedFilename = typeof filename === "function" ? await filename() : filename;
    const csv = await fn();
    const safeFilename = resolvedFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200).send(csv);
  } catch (err) {
    sendPlatformError(res as unknown as { status: (code: number) => { json: (body: unknown) => void } }, err);
  }
}

export function headers(req: MedusaRequest): Record<string, string | string[] | undefined> {
  return req.headers as Record<string, string | string[] | undefined>;
}

function headerValue(
  headers_: Record<string, string | string[] | undefined>,
  names: string[],
): string {
  for (const name of names) {
    const value = headers_[name];
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string" && first.trim()) return first.trim();
  }
  return "";
}

export function merchantTargetIdFromHeaders(req: MedusaRequest, fallback = "merchant_default"): string {
  const reqHeaders = headers(req);
  return headerValue(reqHeaders, ["x-merchant-id", "X-Merchant-Id"])
    || headerValue(reqHeaders, ["x-operating-merchant-id", "X-Operating-Merchant-Id"])
    || fallback;
}

export function query(req: MedusaRequest): Record<string, string | undefined> {
  return req.query as Record<string, string | undefined>;
}

/** Read a repeated query parameter without narrowing all legacy query users. */
export function queryValues(req: MedusaRequest, name: string): string[] {
  const raw = (req.query as Record<string, unknown>)[name];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (values.some((value) => typeof value !== "string" || !value.trim() || value.trim().length > 160)) {
    throw new PlatformError("validation_error", `Invalid ${name} query parameter`, 400);
  }
  return values as string[];
}

export function body<T>(req: MedusaRequest): T {
  return (req.body || {}) as T;
}


export async function actorWithMutationScope(
  req: MedusaRequest,
  minRole: Role,
  permissionId: PermissionId,
  scope: RateLimitScope = "default",
) {
  const requestActor = await actorWithPermission(req, minRole, permissionId, scope);
  const mutationScope = await requireMutationScope(requestActor, headers(req));
  await requireScopedActorPermission(requestActor, permissionId, {
    scopeType: "store",
    merchantId: mutationScope.merchantId,
    storeId: mutationScope.storeId,
  });
  return { actor: requestActor, scope: mutationScope };
}

async function requireCoupledReportScope(
  requestActor: RequestActor,
  permissionId: PermissionId,
  reportScope: { merchantId: string; storeIds: string[] },
) {
  await Promise.all(reportScope.storeIds.map((storeId) => requireScopedActorPermission(
    requestActor,
    permissionId,
    { scopeType: "store", merchantId: reportScope.merchantId, storeId },
  )));
}

export async function actorWithReportScope(
  req: MedusaRequest,
  minRole: Role,
  permissionId: PermissionId,
  scope: RateLimitScope = "default",
) {
  const requestActor = await actorWithPermission(req, minRole, permissionId, scope);
  const reportScope = await requireReadableReportScope(requestActor, headers(req));
  await requireCoupledReportScope(requestActor, permissionId, reportScope);
  return { actor: requestActor, scope: reportScope };
}

/** Historical authority is projected only into a read report, never an OperatingScope. */
export async function actorWithOrderHistoryScope(
  req: MedusaRequest, minRole: Role, permissionId: PermissionId, scope: RateLimitScope = "default",
) {
  if (hasChannelHeaders(req)) return actorWithReportScope(req, minRole, permissionId, scope);
  const requestActor = await actor(req, minRole);
  const historyScope = await resolveOrderHistoryScope(requestActor, headers(req), permissionId);
  return { actor: requestActor, scope: {
    scopeKind: "report" as const, merchantId: historyScope.merchantId, storeIds: historyScope.storeIds,
  } };
}

function hasFullDashboardRoleAtStore(
  access: NonNullable<OperatorContext["access"]>,
  merchantId: string,
  storeId: string,
): boolean {
  if (access.memberships.some((membership) => membership.scopeType === "platform"
    && membership.platformRoleKey === "platform_admin")) return true;
  return access.memberships.some((membership) => {
    if (!membership.roleKey || !["owner", "manager", "accountant"].includes(membership.roleKey)) {
      return false;
    }
    if (membership.merchantId !== merchantId) return false;
    return membership.scopeType === "merchant"
      || (membership.scopeType === "store" && membership.storeId === storeId);
  });
}

/**
 * Resolves the only two dashboard audiences. Full access requires both an
 * effective business role at every target store and a scoped reports:read
 * proof. A staff (including one with an accidental global reports grant)
 * stays on the self-only branch.
 */
export async function actorWithDashboardAudienceScope(req: MedusaRequest) {
  const channel = hasChannelHeaders(req);
  if (!channel) {
    const requestActor = await actor(req, "staff");
    const { scope, audience } = await resolveDashboardHistoryScope(requestActor, headers(req));
    return { actor: requestActor, audience, scope: {
      scopeKind: "report" as const, merchantId: scope.merchantId, storeIds: scope.storeIds,
    } };
  }
  const requestActor = channel ? await resolveChannelActor(headers(req)) : await actor(req, "staff");
  if (channel) rateLimit(req, "default", { kind: "operator", id: requestActor.operatorId });
  const access = await resolveRequestAccess(requestActor);
  requestActor.access = access;
  requestActor.permissions = [...access.permissionIds];
  const reportScope = await requireReadableReportScope(requestActor, headers(req));
  const fullRoles = reportScope.storeIds.map((storeId) =>
    hasFullDashboardRoleAtStore(access, reportScope.merchantId, storeId));
  if (fullRoles.some(Boolean) && !fullRoles.every(Boolean)) {
    throw new PlatformError("forbidden", "A dashboard report cannot mix full and self-only store audiences", 403);
  }
  const fullRoleAtEveryStore = fullRoles.every(Boolean);
  if (fullRoleAtEveryStore) {
    await requireCoupledReportScope(requestActor, permissions.reportsRead, reportScope);
    return { actor: requestActor, scope: reportScope, audience: "full" as const };
  }
  await requireCoupledReportScope(requestActor, permissions.dashboardSelfRead, reportScope);
  return { actor: requestActor, scope: reportScope, audience: "self" as const };
}

/** Legacy/full dashboard paths must not become a staff-data bypass. */
export async function actorWithFullDashboardReportScope(req: MedusaRequest) {
  const resolved = await actorWithDashboardAudienceScope(req);
  if (resolved.audience !== "full") {
    throw new PlatformError(
      "forbidden",
      "The full dashboard is unavailable to a self-only dashboard audience",
      403,
    );
  }
  return resolved;
}

/**
 * Canonical report-scope read guard for endpoints that must authenticate by an
 * explicit read permission but still need the caller's readable store set.
 * Services using this helper must apply their own row-level constraint when the
 * permission is narrower than full report access.
 */
export async function actorWithReadableReportScopeAccess(
  req: MedusaRequest,
  permissionId: PermissionId,
  scope: RateLimitScope = "default",
) {
  const requestActor = await actorWithExplicitPermission(req, permissionId, scope);
  const reportScope = await requireReadableReportScope(requestActor, headers(req));
  await requireCoupledReportScope(requestActor, permissionId, reportScope);
  return { actor: requestActor, scope: reportScope };
}

export async function actorWithPlatformReadScope(
  req: MedusaRequest,
  minRole: Role = "staff",
  permissionId: PermissionId = permissions.platformRead,
) {
  const requestActor = await actorWithPermission(req, minRole, permissionId, "default");
  const platformScope = await requirePlatformReadScope(requestActor, headers(req));
  await requireScopedActorPermission(requestActor, permissionId, { scopeType: "platform" });
  return { actor: requestActor, scope: platformScope };
}

/**
 * Canonical access guard for operational reads that require exactly one
 * operating store. Authenticates by explicit permission (never role order)
 * and resolves one concrete OperatingScope.
 */
export async function actorWithOperatingScopeAccess(
  req: MedusaRequest,
  permissionId: PermissionId,
  scope: RateLimitScope = "default",
) {
  const requestActor = await actorWithExplicitPermission(req, permissionId, scope);
  const operatingScope = await requireOperatingReadScope(requestActor, headers(req));
  await requireScopedActorPermission(requestActor, permissionId, {
    scopeType: "store",
    merchantId: operatingScope.merchantId,
    storeId: operatingScope.storeId,
  });
  return { actor: requestActor, scope: operatingScope };
}

/**
 * Canonical mutation guard for commands that require exactly one operating
 * store. Use this for store-bound mutations.
 */
export async function actorWithOperatingScopeMutation(
  req: MedusaRequest,
  permissionId: PermissionId,
  scope: RateLimitScope = "default",
) {
  const requestActor = await actorWithExplicitPermission(req, permissionId, scope);
  await assertNotReadOnlyImpersonation(requestActor);
  const mutationScope = await requireMutationScope(requestActor, headers(req));
  await requireScopedActorPermission(requestActor, permissionId, {
    scopeType: "store",
    merchantId: mutationScope.merchantId,
    storeId: mutationScope.storeId,
  });
  return { actor: requestActor, scope: mutationScope };
}

/**
 * Canonical mutation guard for merchant-owned aggregates. The caller passes
 * the canonical merchant id from its validated route/body input.
 */
export async function actorWithMerchantTargetMutation(
  req: MedusaRequest,
  permissionId: PermissionId,
  merchantId: string,
  scope: RateLimitScope = "default",
) {
  const requestActor = await actorWithExplicitPermission(req, permissionId, scope);
  await assertNotReadOnlyImpersonation(requestActor);
  const merchantScope = await requireMerchantTargetScope(requestActor, merchantId);
  await requireScopedActorPermission(requestActor, permissionId, {
    scopeType: "merchant",
    merchantId: merchantScope.merchantId,
  });
  return { actor: requestActor, scope: merchantScope };
}

/**
 * Canonical guard for merchant-owned read APIs. It authenticates by explicit
 * permission and returns the concrete merchant target the service may read.
 */
export async function actorWithMerchantTargetAccess(
  req: MedusaRequest,
  permissionId: PermissionId,
  merchantId: string,
  scope: RateLimitScope = "default",
) {
  const requestActor = await actorWithExplicitPermission(req, permissionId, scope);
  const merchantScope = await requireMerchantTargetScope(requestActor, merchantId);
  await requireScopedActorPermission(requestActor, permissionId, {
    scopeType: "merchant",
    merchantId: merchantScope.merchantId,
  });
  return { actor: requestActor, scope: merchantScope };
}

export async function actorWithCategoryReadAccess(req: MedusaRequest, merchantId: string) {
  try {
    return await actorWithMerchantTargetAccess(req, permissions.categoryRead, merchantId);
  } catch (error) {
    // Preserve existing merchant catalog grants without widening their scope.
    if (!(error instanceof PlatformError) || error.code !== "forbidden") throw error;
    return actorWithMerchantTargetAccess(req, permissions.catalogRead, merchantId);
  }
}

/**
 * Canonical platform read guard. It cannot produce an OperatingScope and is
 * therefore never valid for a mutation route.
 */
export async function actorWithPlatformReadAccess(
  req: MedusaRequest,
  permissionId: PermissionId = permissions.platformRead,
) {
  const requestActor = await actorWithExplicitPermission(req, permissionId, "default");
  const platformScope = await requirePlatformReadScope(requestActor, headers(req));
  await requireScopedActorPermission(requestActor, permissionId, { scopeType: "platform" });
  return { actor: requestActor, scope: platformScope };
}

/**
 * Proves one platform-scoped read capability without widening it to the
 * broader platform console read scope.
 */
export async function actorWithScopedPlatformPermissionAccess(
  req: MedusaRequest,
  permissionId: PermissionId,
  scope: RateLimitScope = "default",
) {
  let requestActor: RequestActor;
  if (hasChannelHeaders(req)) {
    requestActor = await resolveChannelActor(headers(req));
    rateLimit(req, scope, { kind: "operator", id: requestActor.operatorId });
  } else {
    requestActor = await authenticateRequestActor(headers(req));
    rateLimit(req, scope, { kind: "operator", id: requestActor.operatorId });
  }
  await requireScopedActorPermission(requestActor, permissionId, { scopeType: "platform" });
  return { actor: requestActor };
}

/**
 * Narrow guard for platform-owned integration configuration commands. A
 * platform read scope is intentionally not returned because it is not valid
 * mutation authority.
 */
export async function actorWithPlatformIntegrationConfigMutation(
  req: MedusaRequest,
  scope: RateLimitScope = "default",
) {
  const requestActor = await actorWithExplicitPermission(req, permissions.integrationConfigWrite, scope);
  await assertNotReadOnlyImpersonation(requestActor);
  await requireActivePlatformMembership(requestActor);
  await requireScopedActorPermission(requestActor, permissions.integrationConfigWrite, { scopeType: "platform" });
  return { actor: requestActor };
}

export async function actorWithPlatformMutation(
  req: MedusaRequest,
  scope: RateLimitScope = "default",
) {
  const requestActor = await actorWithExplicitPermission(req, permissions.platformWrite, scope);
  await assertNotReadOnlyImpersonation(requestActor);
  await requireActivePlatformMembership(requestActor);
  await requireScopedActorPermission(requestActor, permissions.platformWrite, { scopeType: "platform" });
  return { actor: requestActor };
}
