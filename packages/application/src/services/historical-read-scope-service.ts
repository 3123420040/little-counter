import { HistoricalReadScopeSchema, permissions, type PermissionId, type RequestAccess } from "@medusa-snus/contracts";
import type { HeadersLike } from "../http/headers";
import { headerValue } from "../http/headers";
import { PlatformError } from "../errors/platform-error";
import { resolveScopeBootstrap, type ScopeActor, type ScopeBootstrap } from "./access-service";
import { decideScopeCoupledAuthorization } from "./coupled-authorization-policy";

const historyPermissions: PermissionId[] = [permissions.ordersRead, permissions.ordersExport, permissions.reportsRead];

// This proof stays local to historical reads; it must never become actor.access.
function historyAccess(bootstrap: ScopeBootstrap): RequestAccess {
  return { ...bootstrap.access, memberships: bootstrap.historicalMemberships,
    explicitPermissions: bootstrap.historicalExplicitPermissions };
}

export function historicalPermissionIds(bootstrap: ScopeBootstrap): PermissionId[] {
  const access = historyAccess(bootstrap);
  return historyPermissions.filter(permission => bootstrap.historicalStores.some(store =>
    decideScopeCoupledAuthorization(access, permission,
      { scopeType: "store", merchantId: store.merchantId, storeId: store.id }).allowed));
}

function selectedHistoryScope(bootstrap: ScopeBootstrap, headers: HeadersLike) {
  const first = (...names: string[]) => names.map(name => headerValue(headers, name).trim()).find(Boolean) || "";
  const merchantId = first("x-report-merchant-id", "x-merchant-id", "x-operating-merchant-id")
    || bootstrap.reportOptions[0]?.merchantId || bootstrap.historicalStores[0]?.merchantId;
  if (!merchantId) throw new PlatformError("scope_required", "A history merchant is required", 409);
  const stores = [...bootstrap.stores, ...bootstrap.historicalStores].filter(store => store.merchantId === merchantId);
  const requested = first("x-report-store-ids", "x-store-ids", "x-store-id", "x-operating-store-id");
  const storeIds = [...new Set(requested ? requested.split(",").map(id => id.trim()).filter(Boolean) : stores.map(store => store.id))];
  if (!storeIds.length || storeIds.some(id => !stores.some(store => store.id === id))) {
    throw new PlatformError("forbidden", "History scope is not accessible", 403);
  }
  return HistoricalReadScopeSchema.parse({ scopeKind: "historical_read", merchantId, storeIds });
}

function requireHistoryPermission(bootstrap: ScopeBootstrap, permission: PermissionId, merchantId: string, storeId: string) {
  const target = { scopeType: "store" as const, merchantId, storeId };
  const active = bootstrap.stores.some(store => store.id === storeId && store.merchantId === merchantId)
    && decideScopeCoupledAuthorization(bootstrap.access, permission, target).allowed;
  const historical = historyPermissions.includes(permission)
    && bootstrap.historicalStores.some(store => store.id === storeId && store.merchantId === merchantId)
    && decideScopeCoupledAuthorization(historyAccess(bootstrap), permission, target).allowed;
  if (!active && !historical) throw new PlatformError("forbidden", `Missing scoped history permission: ${permission}`, 403);
}

export async function resolveOrderHistoryScope(actor: ScopeActor, headers: HeadersLike, permission: PermissionId) {
  if (permission !== permissions.ordersRead && permission !== permissions.ordersExport) {
    throw new PlatformError("forbidden", "Unsupported order history permission", 403);
  }
  const bootstrap = await resolveScopeBootstrap(actor);
  const scope = selectedHistoryScope(bootstrap, headers);
  for (const storeId of scope.storeIds) requireHistoryPermission(bootstrap, permission, scope.merchantId, storeId);
  return scope;
}

export async function resolveDashboardHistoryScope(actor: ScopeActor, headers: HeadersLike) {
  const bootstrap = await resolveScopeBootstrap(actor);
  const scope = selectedHistoryScope(bootstrap, headers);
  const memberships = [...bootstrap.access.memberships, ...bootstrap.historicalMemberships];
  const fullRoles = scope.storeIds.map(storeId => memberships.some(membership =>
    (membership.scopeType === "platform" && membership.platformRoleKey === "platform_admin")
    || (membership.roleKey && ["owner", "manager", "accountant"].includes(membership.roleKey)
      && membership.merchantId === scope.merchantId
      && (membership.scopeType === "merchant" || membership.storeId === storeId))));
  if (fullRoles.some(Boolean) && !fullRoles.every(Boolean)) {
    throw new PlatformError("forbidden", "A dashboard report cannot mix full and self-only store audiences", 403);
  }
  const audience = fullRoles.every(Boolean) ? "full" as const : "self" as const;
  const permission = audience === "full" ? permissions.reportsRead : permissions.dashboardSelfRead;
  for (const storeId of scope.storeIds) requireHistoryPermission(bootstrap, permission, scope.merchantId, storeId);
  return { scope, audience };
}
